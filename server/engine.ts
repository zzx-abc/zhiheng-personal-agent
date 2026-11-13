import {saveTags,tagsFor,proactiveRecall,blockedSources,validateLinks,selectedLinks,saveLinks,applyLinkFeedback,recentLinks,relationContext} from './memory-learning';
import {ZodError} from 'zod';
import {packContext,leaderInput} from './context-budget';
import {retrieve} from './retrieval';
import {captureContext,replyHistory,recallRequest,detachCapture} from './conversation-context';
import {syncCards} from './cards';
import { readFileSync } from 'node:fs';
import { all,one,exec,id,now,transaction,revision,bump,event,type Run,type RecordRow,type Memory,type Topic,type Evidence } from './db';
import { searchHistory,invalidateGenerated } from './store';
import { contract,reviewFormat,leaderFormat,reviewSchema,leaderSchema,assertCitations,type ModelCall,type Review,type Leader } from './model';
import {agentCall} from './runtime';
import {config} from './config';
import {currentState,saveState,validateState,stateSourceIds,workingStateSchema,workingStateFormat,decisionLogicFormat,type WorkingState} from './working-state';
import {research} from './research';
import {marketContext} from './market-research';
import {chinaDate} from './market-data';
import {observationSummary} from './observation/service';
import {understand,applyIntake,type Intake,type IntakeReceipt} from './intake';
export async function deliberate(call:ModelCall,context:string,allowed:Set<string>,images:{mime:string;data:string}[],save:(name:string,report:Review)=>void,reused?:{analysis:Review;challenge:Review}){
 const reviews=reused?[{status:"fulfilled" as const,value:reused.analysis},{status:"fulfilled" as const,value:reused.challenge}]:await Promise.allSettled([
 call(contract+'你是分析 Agent。独立检查原有依据是否仍成立，以及新情况是否改变其前提。涉及调整时分别检查原选择与新选择，不为原持仓辩护。'+reviewFormat,context,reviewSchema,images).then(x=>{const r=reviewSchema.parse(x);assertCitations(r,allowed);save('analysis',r);return r;}),
 call(contract+'你是质疑 Agent。独立检查新选择是否有独立依据、比较周期是否一致，并寻找原判断的反证与个人规则误用。不能把想调整自动归因为情绪。没有有效异议就说明，不为反对而反对。'+reviewFormat,context,reviewSchema,images).then(x=>{const r=reviewSchema.parse(x);assertCitations(r,allowed);save('challenge',r);return r;})
 ]);
 const failed=reviews.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
 const [analysis,challenge]=reviews.map(r=>(r as PromiseFulfilledResult<Review>).value);
 const leader=leaderSchema.parse(await call(contract+'你是用户唯一面对的 Leader。整合两份独立审议。不要投票，按证据强弱处理分歧；不能无理由忽略有依据的异议。未解决分歧保留。'+leaderFormat,leaderInput(context,analysis,challenge),leaderSchema,images));assertCitations(leader,allowed);save('leader',leader);return leader;
}
function alive(run:Run){const current=one<Run>('SELECT * FROM runs WHERE id=?',run.id);if(!current||current.status!=='running')throw Error('任务已取消或失效');if(revision()!==run.revision)throw Error('上下文在执行期间已被纠正或删除，旧结果不会写回，请重新分析');}
function phase(run:Run,name:string,detail:unknown={}){alive(run);exec('UPDATE runs SET phase=?,heartbeat=? WHERE id=?',name,now(),run.id);event(run.id,name,detail);}

export async function contextFor(run:Run,record:RecordRow,topic:Topic|undefined,warnings:string[],understandingOnly=false){
 const request=understandingOnly?null:recallRequest(run.id);
 const retrieved=request?await retrieve(request.query,run.topic_id,run.id):{mode:'未调用历史检索',cards:[],records:[]};
 const selection=selectedLinks(run.id);const denied=blockedSources(record.id);
 if(selection!==null){const chosen=new Set(selection.map(l=>l.source_id));retrieved.records=retrieved.records.filter(r=>chosen.has(r.id));retrieved.cards=retrieved.cards.filter(c=>(JSON.parse(c.source_ids) as string[]).every(id=>chosen.has(id)));}
 const branch=replyHistory(record.id).filter(r=>!denied.has(r.id));
 const stateRow=understandingOnly?undefined:currentState(run.topic_id);
 let workingState:WorkingState|null=stateRow?JSON.parse(stateRow.content):null;
 if(workingState&&stateSourceIds(workingState).some(id=>denied.has(id)))workingState=null;
 const stateSources=workingState?stateSourceIds(workingState):[];
 const stateRecords=stateSources.flatMap(source=>{const row=one<RecordRow>("SELECT * FROM records WHERE id=? AND role='user'",source);return row?[row]:[];});
 const history=[...new Map([...retrieved.records,...(captureContext(record.id)?branch:run.topic_id?all<RecordRow>("SELECT * FROM records WHERE role='user' AND topic_id=? AND id!=? ORDER BY created_at DESC LIMIT 2",run.topic_id,record.id):[]),...stateRecords].filter(x=>x.id!==record.id&&!denied.has(x.id)&&x.created_at<=record.created_at).map(x=>[x.id,x])).values()];
 const recalledSources=new Set(retrieved.records.map(r=>r.id));
 const memories=understandingOnly?[]:all<Memory>("SELECT * FROM memories WHERE status='active' ORDER BY updated_at DESC").filter(m=>!denied.has(m.source_id)&&((!!run.topic_id&&m.topic_id===run.topic_id)||recalledSources.has(m.source_id))).slice(0,25);
 const evidence=all<Evidence>("SELECT * FROM evidence WHERE run_id=?",run.id);
 const priorAnalyses=!captureContext(record.id)&&run.topic_id?all<{id:string;result:string;finished_at:string}>("SELECT id,result,finished_at FROM runs WHERE topic_id=? AND id!=? AND record_id!=? AND status IN ('succeeded','partial') AND result IS NOT NULL ORDER BY finished_at DESC LIMIT 4",run.topic_id,run.id,record.id):history.length?all<{id:string;result:string;finished_at:string}>(`SELECT id,result,finished_at FROM runs WHERE record_id IN (${history.map(()=>'?').join(',')}) AND status IN ('succeeded','partial') AND result IS NOT NULL ORDER BY finished_at DESC LIMIT 4`,...history.map(r=>r.id)):[];
 const previousEvidence=!understandingOnly&&run.topic_id?all<Evidence>("SELECT e.* FROM evidence e JOIN runs r ON e.run_id=r.id WHERE r.topic_id=? AND r.id!=? AND r.status IN ('succeeded','partial') ORDER BY e.retrieved_at DESC LIMIT 8",run.topic_id,run.id):[];
 for(const source of [...new Set([...stateSources,...retrieved.cards.flatMap(c=>JSON.parse(c.source_ids) as string[])])]){if(!previousEvidence.some(e=>e.id===source)&&!evidence.some(e=>e.id===source)){const item=one<Evidence>('SELECT * FROM evidence WHERE id=?',source);if(item)previousEvidence.push(item);}}
 const sources=[record,...history];const allowed=new Set([...sources.map(x=>x.id),...evidence.map(x=>x.id),...previousEvidence.map(x=>x.id),...memories.map(x=>x.source_id)]);
 const currentImages=all<{record_id:string;path:string;mime:string}>('SELECT record_id,path,mime FROM attachments WHERE record_id=?',record.id);
 const historicalImages=(/截图|图片|图里|图中|那张图/.test(record.content)?history:[]).flatMap(h=>all<{record_id:string;path:string;mime:string}>('SELECT record_id,path,mime FROM attachments WHERE record_id=?',h.id)).slice(0,2);
 const imageSources=[...currentImages,...historicalImages];
 const images=imageSources.map(x=>({mime:x.mime,data:readFileSync(x.path).toString('base64')}));
 const researchOutcome=one<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='research_finished' ORDER BY rowid DESC LIMIT 1",run.id);
 const delegatedTasks=run.topic_id?all("SELECT id,title,question,status,trigger,last_run_id FROM tasks WHERE topic_id=?",run.topic_id):[];
 const candidateIds=new Set(retrieved.records.map(r=>r.topic_id).filter(Boolean));
 const candidateTopics=all<Topic>("SELECT * FROM topics WHERE status='active'").filter(t=>candidateIds.has(t.id)||t.id===run.topic_id);
 const replyContext=understandingOnly?priorAnalyses.filter(a=>branch.some(r=>one<{record_id:string}>('SELECT record_id FROM runs WHERE id=?',a.id)?.record_id===r.id)).slice(0,2).map(a=>({runId:a.id,judgment:(JSON.parse(a.result) as Leader).judgment.slice(0,800),type:'当前回复链中的模型回答，不是用户事实'})):[];
 const context=JSON.stringify(packContext({currentTags:tagsFor([record.id]),relationshipFeedback:relationContext(record.id),recentMemoryLinks:recentLinks(record.id).map(l=>({id:l.id,relation:l.relation,targetId:l.target_id,status:l.status,reason:l.status==='rejected'?'用户已否认此关联，不再引用其原文':l.reason.slice(0,150)})),selectedMemoryLinks:selection,replyContext,contextBoundary:{hasReplyParent:!!captureContext(record.id)?.parent_id,historyRequested:!!request,reason:request?.reason||null,notice:'本次原文是任务中心。历史命中只是参考，不表示同一件事、当前持仓或旧判断仍有效。独立片段不要输出无关的判断变化。'},candidateTopics,retrievedCards:retrieved.cards.map(c=>({id:c.id,kind:c.kind,body:c.body,status:c.status,origin:c.origin,sourceIds:JSON.parse(c.source_ids)})),retrievalMethod:retrieved.mode,operationalState:{observationTasks:observationSummary().slice(0,5).map(t=>({id:t.id,title:t.title,status:t.status,goal:t.config.goal.slice(0,160),health:t.health,lastSuccess:t.last_success_at,nextAt:t.next_at,endsAt:t.ends_at})),focusStatus:topic?.status||null,tasks:delegatedTasks,authority:'程序当前状态，高于历史对话和工作状态中关于暂停/恢复的旧描述；不代表投资假设成立'},workingState:workingState?{asOf:stateRow!.created_at,kind:'模型维护的工作状态，非实时事实或用户交易规则',...workingState}:null,delegatedTasks,researchOutcome:researchOutcome?JSON.parse(researchOutcome.detail):null,allowed_source_ids:[...allowed],runtime:{currentDateShanghai:chinaDate(),timezone:'Asia/Shanghai',provider:'Kimi',endpoint:'https://api.moonshot.cn/v1/chat/completions',model:config().model,tools:['腾讯沪深A股/常用指数报价、前复权日K及共同日期比较','有限官方公告搜索'],engine:config().engine==='dsh'?'DeepSeek Harness':'直接 Kimi API',note:'本次通过以上配置调用模型生成回答；仅证明本次模型响应，不代表外部检索成功。'},current:{id:record.id,text:record.content,date:record.created_at,kind:record.kind},topic,history:history.map(x=>({id:x.id,text:x.content,date:x.created_at,kind:x.kind,relationToCurrent:branch.some(b=>b.id===x.id)?'reply_chain':recalledSources.has(x.id)?'retrieved_reference':'working_state_source',tags:tagsFor([x.id])})),memories,evidence:evidence.map(e=>e.level==='market'?{...e,body:marketContext(e.body)}:e),previousEvidence:previousEvidence.map(e=>({...e,body:e.level==='market'?marketContext(e.body):e.body.slice(0,5000)})),priorModelJudgments:priorAnalyses.map(a=>({runId:a.id,date:a.finished_at,report:((r:Leader)=>({judgment:r.judgment,reasons:r.reasons,uncertainties:r.uncertainties,changes:r.changes}))(JSON.parse(a.result)),type:'模型历史判断，不能当用户观点或独立事实'})),imageSourceOrder:imageSources.map(x=>x.record_id),scope:run.mode==='check'?'本次按需调用工具；行情以腾讯返回时间及日K区间为准，不保证实时，旧行情不能当今天的数据；公告范围见执行记录。discovery级别仅发现线索。':'未查询外部最新信息；图片为用户提供快照。',executionWarnings:warnings}));
 return {context,allowed,images,memories,candidateIds:new Set(retrieved.records.map(r=>r.id))};
}
export async function processRun(run:Run,testCall?:ModelCall){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),330000);const heartbeat=setInterval(()=>{const r=one<Run>('SELECT * FROM runs WHERE id=?',run.id);if(!r||r.status!=='running'||revision()!==run.revision)controller.abort();else exec('UPDATE runs SET heartbeat=? WHERE id=?',now(),run.id);},1500);
 try{
 const record=one<RecordRow>('SELECT * FROM records WHERE id=?',run.record_id);if(!record)throw Error('原始输入已删除');
 // A reply may have been queued before its parent's focus was created.
 const parentId=captureContext(record.id)?.parent_id;
 const parent=parentId?one<RecordRow>('SELECT * FROM records WHERE id=?',parentId):undefined;
 if(parent&&parent.topic_id!==run.topic_id){
  run.topic_id=parent.topic_id;record.topic_id=parent.topic_id;
  exec('UPDATE records SET topic_id=? WHERE id=?',parent.topic_id,record.id);
  exec('UPDATE runs SET topic_id=? WHERE id=?',parent.topic_id,run.id);
 }
 let topic=run.topic_id?one<Topic>('SELECT * FROM topics WHERE id=?',run.topic_id):undefined;
 const originalTopic=run.topic_id;const hadWorkingState=!!currentState(run.topic_id);
 const call=testCall || agentCall(run.id,controller.signal);
 let intake:Intake|undefined;let receipt:IntakeReceipt|undefined;
 if(run.mode==='auto'){
  phase(run,'understanding');const initial=await contextFor(run,record,topic,[],true);
  intake=await understand(call,initial.context,initial.images);alive(run);
  saveTags(record,intake.tags);
  let feedbackApplied=false;
  if(intake.link_feedback){const f=intake.link_feedback;
   if(record.content.includes(f.quote)&&/(关联|联系|同一件|不是这件事|两件事|串在|这条历史)/.test(f.quote)&&recentLinks(record.id).some(l=>l.id===f.id)){
    applyLinkFeedback(f.id,f.decision,f.note,record.id);run.revision=revision();exec('UPDATE runs SET revision=? WHERE id=?',run.revision,run.id);
    event(run.id,'relationship_feedback_applied',{id:f.id,decision:f.decision});feedbackApplied=true;
   }
  }
  const proactive=!intake.memory_query&&!feedbackApplied?proactiveRecall(record):null;
  if(proactive){intake.memory_query=proactive.query;intake.memory_reason=proactive.reason;}
  if(intake.context_relation==='independent'&&captureContext(record.id)?.parent_id){
   detachCapture(run,record);topic=undefined;event(run.id,'fragment_separated',{reason:'本次是独立问题，不继承上一条的关注状态'});
  }
  if(intake.memory_query){
   event(run.id,'memory_requested',{query:intake.memory_query,reason:intake.memory_reason});
   const recalled=await contextFor(run,record,topic,[]);
   intake=await understand(call,recalled.context,recalled.images);alive(run);
   const links=validateLinks(record,intake.history_links,recalled.candidateIds);
   event(run.id,'memory_selected',{links,scoring:'0.40 task + 0.20 entity + 0.25 question + 0.15 validity; threshold 0.75; heuristic, not probability'});
   if(intake.context_relation==='independent'&&captureContext(record.id)?.parent_id){
    detachCapture(run,record);topic=undefined;event(run.id,'fragment_separated',{reason:'历史核对后确认是独立问题，仅引用相关原文'});
   }
  }
  receipt=applyIntake(intake,run,record);
  run.mode=receipt.needsTarget?'chat':intake.route;exec('UPDATE runs SET mode=? WHERE id=?',run.mode,run.id);
  topic=run.topic_id?one<Topic>('SELECT * FROM topics WHERE id=?',run.topic_id):undefined;
 }
 const stored=all<{agent:string;content:string}>('SELECT agent,content FROM reports WHERE run_id=?',run.id);
 const reused=stored.length===2&&stored.some(x=>x.agent==='analysis')&&stored.some(x=>x.agent==='challenge')?{analysis:reviewSchema.parse(JSON.parse(stored.find(x=>x.agent==='analysis')!.content)),challenge:reviewSchema.parse(JSON.parse(stored.find(x=>x.agent==='challenge')!.content))}:undefined;
 if(reused)event(run.id,'reviews_reused',{reason:'预算中断后接续已完成的独立审议，未重复取数或审议'});
 const previousOutcome=one<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='research_finished' ORDER BY rowid DESC LIMIT 1",run.id);
 const warnings:string[]=reused&&previousOutcome?JSON.parse(previousOutcome.detail).missing||[]:[];
 if(run.mode==='check'&&!reused){try{warnings.push(...await research(run,record,topic,call,controller.signal,()=>alive(run),(name,detail)=>phase(run,name,detail)));}catch(e){alive(run);warnings.push('本次联网核实未完成：'+(e instanceof Error?e.message:'接口失败')+'。以下仅分析已提供材料，不能当作已核实的最新事实。');event(run.id,'search_unavailable',{message:warnings[0]});}}
 phase(run,'context');
 const prepared=await contextFor(run,record,topic,warnings);const {allowed,images,memories}=prepared;
 const feedbackReceipt=one<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='relationship_feedback_applied' ORDER BY rowid DESC LIMIT 1",run.id);
 const context=prepared.context+'\n程序执行回执（只有这里的动作确实完成了）：'+JSON.stringify({...receipt,relationshipFeedbackApplied:feedbackReceipt?JSON.parse(feedbackReceipt.detail):null});
 const save=(name:string,result:Review)=>{alive(run);exec('INSERT INTO reports VALUES(?,?,?,?,?)',id(),run.id,name,JSON.stringify(result),now());event(run.id,'agent_completed',{agent:name});};
 const quoteEvent=one<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='market_data_result' ORDER BY rowid DESC LIMIT 1",run.id);
 const simpleQuote=quoteEvent&&JSON.parse(quoteEvent.detail).observation==='quote'&&intake&&!intake.review_required;
 phase(run,run.mode==='chat'||simpleQuote?'answering':'deliberating');
 let leader:Leader;
 if(run.mode==='chat'||simpleQuote){const mustRefresh=!!one("SELECT id FROM events WHERE run_id=? AND type='relationship_feedback_applied'",run.id)||!!run.topic_id||simpleQuote||!!recallRequest(run.id)||!!one("SELECT id FROM events WHERE run_id=? AND type='fragment_separated'",run.id)||receipt&&(receipt.contextChanged||receipt.focusUpdated||receipt.taskId||receipt.paused||receipt.needsTarget);leader=leaderSchema.parse((!mustRefresh?intake?.reply:null)??await call(contract+'严格依据程序执行回执报告保存、跟进或暂停。needsTarget=true表示没执行，不能说已完成，只问一个关键问题：要跟进或暂停哪个方向/公司？taskId存在只表示已保存手动委托，不代表查过或自动监测。'+leaderFormat,context,leaderSchema,images));assertCitations(leader,allowed);save('leader',leader);}
 else leader=await deliberate(call,context,allowed,images,save,reused);
 const explicitCorrection=/(不是|理解错|纠正|更正|不再|取消|撤回|改为)/.test(record.content);
 const willCorrect=!one("SELECT id FROM events WHERE run_id=? AND type='relationship_feedback_applied'",run.id)&&explicitCorrection&&(leader.withdraw_memory_ids.length>0||/(理解错|更正|纠正|不是我的|我只是[\s\S]{0,100}不是)/.test(record.content));
 if(willCorrect&&((run.topic_id===originalTopic&&hadWorkingState)||currentState(run.topic_id))&&!leader.working_state){
  phase(run,'updating_state');
  leader.working_state=workingStateSchema.parse(await call(contract+workingStateFormat+decisionLogicFormat+'本次用户明确纠正了理解。必须对照原文修正现有状态；不受影响的部分保留，不把整件事丢掉。本次只输出状态对象本身，不要working_state外层或其他回复字段。',context+'\n本轮已形成的回答：'+JSON.stringify(leader),workingStateSchema,images));
  // The stored Leader report must agree with the committed state.
  alive(run);exec("UPDATE reports SET content=? WHERE run_id=? AND agent='leader'",JSON.stringify(leader),run.id);
 }
 if(leader.working_state){
  // Uncited model inferences cannot become evidence. Keep an audit event instead
  // of failing a useful answer or inventing citations to complete a field.
  const unsupported=leader.working_state.evidence.filter(x=>!x.sources.length);
  if(unsupported.length){alive(run);event(run.id,'unsupported_state_evidence_omitted',{claims:unsupported.map(x=>x.text)});leader.working_state.evidence=leader.working_state.evidence.filter(x=>x.sources.length);exec("UPDATE reports SET content=? WHERE run_id=? AND agent='leader'",JSON.stringify(leader),run.id);}
  validateState(leader.working_state,allowed);
  if(leader.working_state.logic_change&&leader.working_state.logic_change.after.source_id!==record.id)throw Error('本轮逻辑更新必须引用本次原话');
 }
 // The researcher is not an authority: independent review can reject a claimed
 // resolution. Keep the visible execution outcome consistent with that verdict.
 if(run.mode==='check'&&!leader.evidence_sufficient){
  const outcome=one<{id:string;detail:string}>("SELECT id,detail FROM events WHERE run_id=? AND type='research_finished' ORDER BY rowid DESC LIMIT 1",run.id);
  if(outcome){const value=JSON.parse(outcome.detail);if(value.status==='answered'){alive(run);exec('UPDATE events SET detail=? WHERE id=?',JSON.stringify({...value,status:'limited',reason:'独立审议后，材料仍不足以解决核心问题。'+leader.uncertainties.join('；'),next_requirement:leader.next_step||value.next_requirement}),outcome.id);event(run.id,'research_reconciled',{reason:'Leader did not confirm evidence sufficiency'});}}
 }
 transaction(()=>{
 alive(run);
 if(willCorrect){for(const memoryId of leader.withdraw_memory_ids){if(memories.some(m=>m.id===memoryId))exec("UPDATE memories SET status='withdrawn',updated_at=? WHERE id=?",now(),memoryId);}const at=now();exec('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)',id(),run.topic_id,'correction',record.content,'active',record.id,record.content,at,at,null);bump();invalidateGenerated(run.topic_id);}
 exec("DELETE FROM memories WHERE source_id=? AND status='candidate'",record.id);
 for(const m of leader.memory_candidates){if(record.kind==='action_request')continue;if(m.source_id!==record.id||!m.quote||!record.content.includes(m.quote)||m.content.length>500)continue;if(one("SELECT id FROM memories WHERE content=? OR (source_id=? AND source_quote=? AND status='withdrawn')",m.content,record.id,m.quote))continue;const at=now();
 if(m.kind==='principle'&&/不是.{0,20}(原则|规则)|不(应|要|是).{0,15}(买入|买卖|交易)规则/.test(m.quote))continue;
 const quoteAt=record.content.indexOf(m.quote),prefix=record.content.slice(Math.max(0,quoteAt-24),quoteAt);
 const quoted=/[“「"']\s*$/.test(prefix)||/(他说|她说|朋友说|转发|摘录|群里说)[：:\s]*$/.test(prefix);
 const explicitSimple=['goal','preference'].includes(m.kind)&&/^我(最近|目前|现在|正在|希望|想|喜欢|偏好|更喜欢|的目标|目标是)/.test(m.quote)&&!quoted;
 exec('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)',id(),run.topic_id,m.kind,explicitSimple?m.quote:m.content,explicitSimple?'active':'candidate',record.id,m.quote,at,at,null);}
 saveLinks(run,record);
 if(leader.working_state)saveState(run,leader.working_state,allowed);
 if(run.mode==='check'&&!leader.evidence_sufficient&&!warnings.length)warnings.push('已执行检索，但材料仍不足以回答核心问题；未确认不等于事实不存在。');
 const status=warnings.length?'partial':'succeeded';
 if(run.topic_id)exec('UPDATE topics SET updated_at=? WHERE id=?',now(),run.topic_id);
 exec('INSERT INTO records VALUES(?,?,?,?,?,?,?)',id(),run.topic_id,'assistant','analysis',JSON.stringify(leader),now(),run.id);
 exec('UPDATE runs SET status=?,phase=?,finished_at=?,result=?,error=? WHERE id=?',status,'done',now(),JSON.stringify(leader),warnings.join('；')||null,run.id);event(run.id,'completed',{status});
 });
 syncCards();
 }catch(e){controller.abort();const current=one<Run>('SELECT * FROM runs WHERE id=?',run.id);if(current?.status==='running'){const stale=revision()!==run.revision;const message=stale?'执行期间个人理解已更新，旧结果未提交。请重新分析。':controller.signal.aborted&&e instanceof Error&&e.name==='AbortError'?'任务超时或取消，未提交不完整结论。':e instanceof ZodError?'模型回复缺少必要内容或格式不完整，原文已保存。请重新处理这条原文。':e instanceof SyntaxError?'模型回复暂时无法解析，原文已保存。请重新处理这条原文。':e instanceof Error?e.message:'任务执行失败';const safeMessage=message.split(config().apiKey||'__NO_SECRET__').join('[已隐藏]').slice(0,700);exec('UPDATE runs SET status=?,phase=?,error=?,finished_at=? WHERE id=?',stale?'stale':'failed','stopped',safeMessage,now(),run.id);event(run.id,'failed',{message:safeMessage});}}
 finally{clearTimeout(timeout);clearInterval(heartbeat);}
}
export function claim(modes?:string[],exclude=false){return transaction(()=>{const filter=modes?.length?` AND mode ${exclude?'NOT IN':'IN'} (${modes.map(()=>'?').join(',')})`:"";const r=one<Run>("SELECT * FROM runs WHERE status='queued'"+filter+" ORDER BY created_at LIMIT 1",...(modes||[]));if(!r)return;const binding=one<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='continuation_requested'",r.id);if(binding){const source=JSON.parse(binding.detail);if(currentState(r.topic_id)?.id!==source.stateId||!one("SELECT id FROM topics WHERE id=? AND status='active'",r.topic_id)){exec("UPDATE runs SET status='stale',error='核实所依据的理解已更新或暂停，旧请求未执行',finished_at=? WHERE id=?",now(),r.id);return;}}if(one('SELECT id FROM reports WHERE run_id=?',r.id)&&r.revision!==revision()){exec("UPDATE runs SET status='stale',error='背景已更新，旧审议不能接续。请重新处理原文。' WHERE id=?",r.id);return;}exec("UPDATE runs SET status='running',phase='starting',started_at=?,heartbeat=?,revision=? WHERE id=?",now(),now(),revision(),r.id);return one<Run>('SELECT * FROM runs WHERE id=?',r.id)!;});}
