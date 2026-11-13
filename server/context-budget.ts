/** Bound the context assembled from hybrid retrieval. Originals stay in SQLite. */
export const CONTEXT_CHAR_LIMIT=24000;
type Item=Record<string,any>;
export function excerpt(text:string,limit:number,anchors:string[]=[]){
 if(text.length<=limit)return {text,truncated:false};
 const anchor=anchors.find(a=>a.length>=2&&text.includes(a));
 const start=anchor?Math.max(0,text.indexOf(anchor)-Math.floor((limit-Math.min(anchor.length,limit))/2)):0;
 return {text:text.slice(start,start+limit),truncated:true,offset:start,originalCharacters:text.length};
}
export function packContext(input:Item,limit=CONTEXT_CHAR_LIMIT){
 const {history=[],memories=[],evidence=[],previousEvidence=[],priorModelJudgments=[],...core}=input;
 const omitted:Record<string,number>={};
 // Never silently shorten the current request or the current version of the decision.
 const output:Item={...core,history:[],memories:[],evidence:[],previousEvidence:[],priorModelJudgments:[],contextSelection:{method:input.retrievalMethod||'全文检索 + 分组预算',characterLimit:limit,omitted,notice:'truncated=true是原文片段，不是全文；未入选不代表不存在。不能把缺少上下文认定为用户从未说过。'}};
 const size=()=>JSON.stringify(output).length;
 // Reserve room for accounting metadata so output has a hard serialized bound.
 if(size()>limit-800)throw Error('本次问题与当前背景超出上下文预算，原文已保存。请聚焦一个问题后重试。');
 const quotes=Object.values(input.workingState?.decision_frame||{}).filter(Boolean) as {quote:string;source_id:string}[];
 const anchors=(id:string)=>[...quotes.filter(q=>q.source_id===id).map(q=>q.quote),...memories.filter((m:Item)=>m.source_id===id).map((m:Item)=>m.source_quote)];
 function add(name:string,items:Item[],budget:number,transform:(x:Item)=>Item){
  let spent=0;for(const item of items){const value=transform(item),cost=JSON.stringify(value).length+1;
   if(spent+cost>budget||size()+cost>limit-800){omitted[name]=(omitted[name]||0)+1;continue;}
   output[name].push(value);spent+=cost;
  }
 }
 // Corrections and accepted principles have priority over historical model prose.
 add('memories',[...memories].sort((a,b)=>(b.kind==='correction'?2:b.kind==='principle'?1:0)-(a.kind==='correction'?2:a.kind==='principle'?1:0)),1800,x=>x);
 const priority=(x:Item)=>x.kind==='correction'?2:quotes.some(q=>q.source_id===x.id)||input.workingState?.thesis?.sources?.includes(x.id)?1:0;
 add('history',[...history].sort((a,b)=>priority(b)-priority(a)),3200,x=>({...x,...excerpt(x.text,750,anchors(x.id))}));
 add('evidence',evidence,5000,x=>{const part=excerpt(x.body,x.level==='market'?4500:2400);return {...x,body:part.text,truncated:part.truncated,originalCharacters:part.originalCharacters}});
 add('previousEvidence',previousEvidence,1200,x=>{const part=excerpt(x.body,900);return {...x,body:part.text,truncated:part.truncated,originalCharacters:part.originalCharacters}});
 add('priorModelJudgments',priorModelJudgments,600,x=>({...x,report:{judgment:excerpt(x.report.judgment,700).text,changes:excerpt(x.report.changes||'',350).text},excerptOnly:true}));
 output.contextSelection.characters=size();
 return output;
}
/** Leader receives original evidence and concise reviewer excerpts, not three
 * copies of the same chat history. Full reports remain available for audit. */
export function leaderInput(context:string,analysis:Item,challenge:Item){
 const separator='\n程序执行回执';const split=context.indexOf(separator);const c=JSON.parse(split<0?context:context.slice(0,split));
 const evidence=c.evidence||[];
 const required=new Set([...(c.workingState?.thesis?.sources||[]),...Object.values(c.workingState?.decision_frame||{}).filter(Boolean).map(x=>(x as Item).source_id)]);
 const availableHistory=c.history||[];
 const history=availableHistory.filter((x:Item,i:number)=>required.has(x.id)||i<2).map((x:Item)=>({...x,...excerpt(x.text,750,Object.values(c.workingState?.decision_frame||{}).filter(Boolean).filter(q=>(q as Item).source_id===x.id).map(q=>(q as Item).quote))}));
 const memories=(c.memories||[]).slice(0,3).map((x:Item)=>({kind:x.kind,content:excerpt(x.content,250).text,source_id:x.source_id}));
 const state=c.workingState?{thesis:c.workingState.thesis,decision_frame:c.workingState.decision_frame}:null;
 const previousEvidence=evidence.length?[]:(c.previousEvidence||[]).slice(0,1);
 const ids=[c.current.id,...history.map((x:Item)=>x.id),...memories.map((x:Item)=>x.source_id),...evidence.map((x:Item)=>x.id),...previousEvidence.map((x:Item)=>x.id)];
 const summarize=(r:Item)=>({judgment:excerpt(r.judgment,320).text,reasons:r.reasons.slice(0,2).map((x:Item)=>({text:excerpt(x.text,120).text,sources:x.sources,available:x.sources.every((id:string)=>ids.includes(id))})),uncertainties:r.uncertainties.slice(0,3).map((s:string)=>excerpt(s,160).text),excerptOnly:true});
 // Do not present a state thesis as a sourced user fact without its original.
 if(state?.thesis?.sources?.some((id:string)=>!ids.includes(id)))state.thesis=null;
 if(state?.decision_frame)for(const [key,value] of Object.entries(state.decision_frame))if(value&&!ids.includes((value as Item).source_id))state.decision_frame[key]=null;
 return JSON.stringify({relationshipFeedback:c.relationshipFeedback,selectedMemoryLinks:c.selectedMemoryLinks,contextBoundary:c.contextBoundary,current:c.current,topic:c.topic?{id:c.topic.id,title:c.topic.title,question:c.topic.question}:null,runtime:{currentDateShanghai:c.runtime?.currentDateShanghai,timezone:c.runtime?.timezone,model:c.runtime?.model},operationalState:c.operationalState?{observationTasks:c.operationalState.observationTasks,focusStatus:c.operationalState.focusStatus,tasks:c.operationalState.tasks}:null,workingState:state,history,memories,evidence,previousEvidence,allowed_source_ids:[...new Set(ids)],researchOutcome:c.researchOutcome?{status:c.researchOutcome.status,reason:c.researchOutcome.reason,missing:c.researchOutcome.missing,next_requirement:c.researchOutcome.next_requirement}:null,executionWarnings:c.executionWarnings,analysis:summarize(analysis),challenge:summarize(challenge),notice:'两份审议为节选，不是新增证据。available=false的理由缺少本次原始证据，不可据此认定事实。按本次原文和工具结果独立整合；观察行业的2—4周不等于用户承诺持有新仓2—4周。不能由缺少记录推断没有依据。正文只说最关键的判断，状态保留真实来源与未知。'})+(split<0?'':context.slice(split));
}
