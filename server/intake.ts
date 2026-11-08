import {z} from 'zod';
import {all,one,exec,transaction,event,bump,revision,now,type Run,type RecordRow,type Topic} from './db';
import {createTopic,createTask,pauseTask,invalidateGenerated} from './store';
import {contract,leaderFormat,leaderSchema,type ModelCall} from './model';
export const intakeSchema=z.object({
 route:z.enum(['chat','review','check']),data_need:z.enum(['none','market_data','official_search']).default('none'),review_required:z.boolean().default(false),understanding:z.string().max(300),first_help:z.string().max(1200),
 focus:z.object({id:z.string().nullable(),title:z.string().max(60),question:z.string().max(500),quote:z.string().max(500)}).nullable(),
 followup:z.object({title:z.string().max(100),question:z.string().max(1500),quote:z.string().max(500)}).nullable(),
 pause_focus:z.boolean(),reply:leaderSchema.nullable()
});
export type Intake=z.infer<typeof intakeSchema>;
export function resolveIntakeRoute(plan:Intake){return {...plan,route:plan.data_need!=='none'?'check' as const:plan.route};}
export function intakeContext(context:string){
 const c=JSON.parse(context),w=c.workingState;
 return JSON.stringify({...c,workingState:w?{thesis:w.thesis,assessment:w.assessment?.slice(0,500),decision_frame:w.decision_frame,next_action:w.next_action}:null,history:c.history?.slice(0,2).map((h:any)=>({...h,text:h.text?.slice(0,500),truncated:true})),retrievedCards:c.retrievedCards?.slice(0,4).map((card:any)=>({...card,body:card.body?.slice(0,400),excerptOnly:true})),memories:c.memories?.slice(0,6),evidence:[],previousEvidence:[],priorModelJudgments:[],contextSelection:{notice:'此阶段只识别任务与个人背景，未提供外部证据正文；不得据此下市场事实结论。'}});
}
export async function understand(call:ModelCall,context:string,images:{mime:string;data:string}[]){
 const topics=all<Topic>("SELECT * FROM topics WHERE status='active' ORDER BY updated_at DESC LIMIT 20");
 return resolveIntakeRoute(intakeSchema.parse(await call(contract+`你先理解用户要完成的任务，不让用户管理Agent。输出JSON：{route:"chat"|"review"|"check",data_need:"none"|"market_data"|"official_search",review_required:涉及实质决策比较时true否则false,understanding:"一句简短的具体理解，不许泛泛说我会帮你分析",first_help:"最多三句先提供有用判断：核心因果链和首要缺口。不是完成承诺，不冒充查证结论；简单问题可空",focus:null或{id:已存在关注ID或null,title:短名称,question:用户正在验证的问题,quote:本次原话的逐字片段},followup:null或{title,question,quote:本次明确委托原话},pause_focus:false,reply:null或完整回答对象}。
先独立决定data_need，再决定审议深度。当前有明确标的，且回答依赖其走势/成交量/相对强弱时data_need=market_data；判断需要公告原文时official_search。缺的是个人动机或只梳理已提供逻辑时none。只交代未来跟进、回顾或纠正时none。不允许一边说“需要行情核实”，一边选择none把可执行任务留给用户。data_need非none时程序先执行工具，仍可review_required=true。不以其他股票的旧快照代替本次标的。
工具取数与独立审议分别决定：check仅表示先获取证据；若用户还要求比较原有理由与新选择、检验调整依据，review_required=true，即使只获取报价也要独立审议。纯粹问价、回顾、纠正的review_required=false。
路由：涉及原有理由与拟调整方向的实质比较、交易评价标准混淆时用review，让两个独立视角核验；但没有明确标的时先帮助拆清问题，只问一个关键问题，不盲目搜索。已有对象且需要核实公开事实时优先check。纠正某个周期或说明担心不是规则时用chat并更新背景，不触发完整重审。复杂投资假设、观点冲突、看材料判断变化用review；明确要求查公告、或回答眼前问题需要报价、行情走势、相对涨跌及最新事实时用check；在工具已覆盖且对象明确时主动取数，不必等用户再次说“调用接口”；普通问题、历史回顾、纠正、状态询问用chat。对现有论证的单一澄清（如单日回落是否改变假设）通常用chat；有新的实质材料、重要分歧或用户明确要求多角度重审时才再用review。用户说“接着推进”“继续查”时，结合workingState.next_action和delegatedTasks决定：已明确要推进且下一步是official_search或market_data可用check；旧状态曾要求行情截图时，应先用新接入的行情工具尝试，不能机械重复索要截图；其他下一步需要用户材料则只说明缺哪一份材料，不重复输出整篇报告或承诺已有数据。用户只问进展时总结真实已完成和卡点，不擅自开新查询。用户要求先评价逻辑时用review，不为了完整研究强制联网；但回答不能把无数据的市场假设说成事实。已有腾讯行情工具：沪深A股和上证指数、沪深300、科创50、深证成指、创业板指的供应商报价及日K（5/20/60个收盘间隔）。需要这些数据就用check；取数后注明供应商时间，不承诺交易所实时性。没有分时、全行业指数目录、资金净流入和订单工具，不能混为一谈。
持续投资问题可以自然建立focus，不要求填表；现有相关关注优先引用其ID，完全不同的话题不要硬接。个人软件连接、无持续投资判断的闲聊、泛知识问题不建立focus。用户说持有理由、犹豫调整或希望持续验证自己的做法，属于持续决策问题，应自然建立focus并关联原话，即使表达很随意、没有证券代码也可以。明确的虚构练习不得存成真实持仓背景。focus.quote必须来自本次用户原话，转发文章本身不等于用户认可其观点。focus.question写成待验证问题，不写已成立的事实。用户明确纠正正在关注的问题时，使用原有focus.id并给出修正后的question与原话quote，不要重复建立新关注。
followup只在用户明确交代以后跟进时建立，普通建议不等于委托。只交代以后跟进、还没要求立即查证时route=chat，不调用搜索。当前仅支持用户点击立即检查，不能承诺自动监测或提醒。quote逐字来自本次委托。pause_focus只在用户明确要求暂停当前关注时为true。当前自然语言动作只有建立/接续/纠正关注、保存手动跟进、暂停关注；其他动作不要宣称执行。例如恢复已暂停关注请引导到关注与跟进页面点击恢复；不能承诺自动提醒、盯盘或下单。原则只可提为待认可候选，不能把担心当纪律。
chat时在reply里直接完成帮助（含记忆纠正）；review/check时reply为null。简单问题只需一两句；长论述先准确抓住因果链再判断。reply格式：`+leaderFormat,intakeContext(context)+'\n可接续的关注（不是已证实的事实）：'+JSON.stringify(topics),intakeSchema,images)));
}
export type IntakeReceipt={topicId:string|null;contextChanged:boolean;focusUpdated:boolean;taskId:string|null;paused:boolean;needsTarget:boolean};
export function applyIntake(plan:Intake,run:Run,record:RecordRow){
 return transaction(()=>{
  if(one<Run>('SELECT * FROM runs WHERE id=?',run.id)?.status!=='running'||revision()!==run.revision)throw Error('任务已取消或上下文已更新');
  let topicId=run.topic_id;const receipt:IntakeReceipt={topicId,contextChanged:false,focusUpdated:false,taskId:null,paused:false,needsTarget:false};
  if(plan.focus){
   if(plan.focus.id){
    const existing=one<Topic>("SELECT * FROM topics WHERE id=? AND status='active'",plan.focus.id);
    if(!existing)throw Error('找不到要接续的关注，未改变个人背景');
    topicId=existing.id;
    if(/(理解错|更正|纠正|关注的是|研究的是|想验证的是)/.test(record.content)&&plan.focus.question.trim()&&plan.focus.quote.length>=2&&record.content.includes(plan.focus.quote)){
     exec('UPDATE topics SET title=?,question=?,updated_at=? WHERE id=?',plan.focus.title||existing.title,plan.focus.question,now(),existing.id);
     bump();run.revision=revision();exec('UPDATE runs SET revision=? WHERE id=?',run.revision,run.id);invalidateGenerated(existing.id);receipt.focusUpdated=true;
     event(run.id,'focus_corrected',{topicId:existing.id,question:plan.focus.question,sourceId:record.id,quote:plan.focus.quote});
    }
   }else if(plan.focus.title.trim()&&plan.focus.question.trim()&&plan.focus.quote.length>=2&&record.content.includes(plan.focus.quote)){
    topicId=all<Topic>("SELECT * FROM topics WHERE status='active'").find(t=>t.title===plan.focus!.title)?.id||createTopic(plan.focus.title,plan.focus.question);
    event(run.id,'focus_created',{topicId,title:plan.focus.title,sourceId:record.id,quote:plan.focus.quote});
   }
  }
  receipt.topicId=topicId;receipt.contextChanged=topicId!==run.topic_id;
  if(topicId!==run.topic_id){exec('UPDATE records SET topic_id=? WHERE id=?',topicId,record.id);exec('UPDATE runs SET topic_id=? WHERE record_id=?',topicId,record.id);exec('UPDATE records SET topic_id=? WHERE run_id IN (SELECT id FROM runs WHERE record_id=?)',topicId,record.id);exec('UPDATE memories SET topic_id=? WHERE source_id=?',topicId,record.id);run.topic_id=topicId;record.topic_id=topicId;}
  if(plan.followup&&topicId){
   const task=plan.followup;
   if(task.quote.length<4||!record.content.includes(task.quote))throw Error('跟进委托缺少原文依据，未建立任务');
   const existing=one<{id:string}>("SELECT id FROM tasks WHERE topic_id=? AND question=? AND status='active'",topicId,task.question);
   const taskId=existing?.id||createTask(topicId,task.title,task.question);
   receipt.taskId=taskId;
   event(run.id,'task_created',{taskId,topicId,title:task.title,trigger:'manual',sourceId:record.id,quote:task.quote});
  }
  if(plan.pause_focus&&topicId){
   if(!/(暂停|不再关注|先不关注|停止跟进|取消跟进)/.test(record.content))throw Error('暂停关注需要明确的用户表达');
   exec("UPDATE topics SET status='paused',updated_at=? WHERE id=?",now(),topicId);
   for(const task of all<{id:string}>('SELECT id FROM tasks WHERE topic_id=?',topicId))pauseTask(task.id,'paused');
   bump();run.revision=revision();exec('UPDATE runs SET revision=? WHERE id=?',run.revision,run.id);
   receipt.paused=true;
   event(run.id,'focus_paused',{topicId});
  }
  if((plan.followup||plan.pause_focus)&&!topicId)receipt.needsTarget=true;
  event(run.id,'action_receipt',receipt);
  event(run.id,'understood',{route:plan.route,understanding:plan.understanding,first_help:plan.first_help,topicId});
  return receipt;
 });
}
