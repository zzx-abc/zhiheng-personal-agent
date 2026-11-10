import {tagSchema,linkSchema} from './memory-learning';
import {z} from 'zod';
import {recalledTopics} from './conversation-context';
import {all,one,exec,transaction,event,bump,revision,now,type Run,type RecordRow,type Topic} from './db';
import {createTopic,createTask,pauseTask,invalidateGenerated} from './store';
import {contract,leaderFormat,leaderSchema,type ModelCall} from './model';
export const intakeSchema=z.object({
 tags:z.array(tagSchema).max(10).default([]),history_links:z.array(linkSchema).max(3).default([]),
 link_feedback:z.object({id:z.string(),decision:z.enum(['confirmed','rejected']),quote:z.string().min(2).max(300),note:z.string().max(500)}).nullable().default(null),
 context_relation:z.enum(['independent','continue']).default('continue'),memory_query:z.string().min(2).max(300).nullable().default(null),memory_reason:z.string().max(300).default(''),
 route:z.enum(['chat','review','check']),data_need:z.enum(['none','market_data','official_search']).default('none'),review_required:z.boolean().default(false),understanding:z.string().max(300),first_help:z.string().max(1200),
 focus:z.object({id:z.string().nullable(),title:z.string().max(60),question:z.string().max(500),quote:z.string().max(500)}).nullable(),
 followup:z.object({title:z.string().max(100),question:z.string().max(1500),quote:z.string().max(500)}).nullable(),
 pause_focus:z.boolean(),reply:leaderSchema.nullable()
});
export type Intake=z.infer<typeof intakeSchema>;
export function resolveIntakeRoute(plan:Intake){return {...plan,route:plan.data_need!=='none'?'check' as const:plan.route};}
export function intakeContext(context:string){
 const c=JSON.parse(context),w=c.workingState;
 return JSON.stringify({...c,workingState:w?{thesis:w.thesis,assessment:w.assessment?.slice(0,500),decision_frame:w.decision_frame,next_action:w.next_action}:null,history:c.history?.slice(0,2).map((h:any)=>({...h,text:h.text?.slice(0,500),truncated:true})),retrievedCards:c.retrievedCards?.slice(0,4).map((card:any)=>({...card,body:card.body?.slice(0,400),excerptOnly:true})),memories:c.memories?.slice(0,6),evidence:[],previousEvidence:[],priorModelJudgments:[],replyContext:c.replyContext||[],contextSelection:{notice:'此阶段只识别任务与个人背景，未提供外部证据正文；不得据此下市场事实结论。'}});
}
export async function understand(call:ModelCall,context:string,images:{mime:string;data:string}[]){
 const topics=JSON.parse(context).candidateTopics||[];
 return resolveIntakeRoute(intakeSchema.parse(await call(contract+`你先理解用户要完成的任务，不让用户管理Agent。输出JSON：{tags:[{kind:"entity/theme/intent/horizon",label:"简短检索标签",quote:"本次原文逐字片段"}],history_links:[],link_feedback:null,context_relation:"independent或continue",memory_query:"确实需要历史时的具体检索词，否则null",memory_reason:"历史能解决本次哪个具体缺口，不检索则空",route:"chat"|"review"|"check",data_need:"none"|"market_data"|"official_search",review_required:涉及实质决策比较时true否则false,understanding:"一句简短的具体理解，不许泛泛说我会帮你分析",first_help:"最多三句先提供有用判断：核心因果链和首要缺口。不是完成承诺，不冒充查证结论；简单问题可空",focus:null或{id:已存在关注ID或null,title:短名称,question:用户正在验证的问题,quote:本次原话的逐字片段},followup:null或{title,question,quote:本次明确委托原话},pause_focus:false,reply:null或完整回答对象}。
先判断本次是不是独立片段，再考虑记忆。没有回复父片段时context_relation=independent；有父片段且是追问、纠正、继续核实时为continue。即使界面仍停在旧讨论，用户开始一个自足的新任务（例如“分析今天早上的盘面并记录”）也用independent，不默认是在看其旧持仓。只是同一公司、同一行业、相近关键词不构成接续。用户说另一笔、新开一笔、之前已结束时，若要持续梳理应创建新focus(id=null)，不能覆盖同股旧交易。检索不会合并原文或自动接续关注。
标签是检索线索，不是用户事实。给本次表达提取最多6个tags。entity只用原文明确写出的公司/证券名称或代码，不补全猜测；theme可归纳订单兑现、行业景气等主题；intent可用原始依据、考虑调整、验证条件；horizon只能引用明确的短线/中线/长期等表达。每个quote必须逐字来自current.text。不用冲动、贪婪、违规等标签。不把“提到某公司”当成持有。原始依据和考虑调整是这条文本的任务性质，不是用户交易原则。
先判断完成当前任务缺少什么背景，而不是等用户要求关联。当用户考虑调整、判断新信息是否影响原逻辑、表达可能与已有背景相关的犹豫时，可以主动填写memory_query与memory_reason，即使没有“上次/之前”等词。记忆不是每次都要检索：独立市场概览、概念解释、材料已足够的任务仍用null。当前回复链足够时不全库检索。contextBoundary.historyRequested=true说明程序已经检索，不再次提出查询。
检索返回的是候选。在historyRequested=true时，逐一判断哪些原文对当前任务有用，用history_links选择最多3个独立用户原文来源，不合适就[]。格式：[{source_id:"history中原文ID",relation:"basis/compare/supports/challenges/recall",reason:"具体为什么对本次有用及局限",current_quote:"当前原文的逐字片段",target_quote:"候选历史原文逐字片段",task:0到1,entity:0到1,question:0到1,validity:0到1}]。四项分别是任务帮助、对象对应、问题及时间尺度匹配、原文有效性；不确定用0.5或更低。来源评分只是启发式，不是概率。共同标签只用于发现，不能替代证据。不同证券不选basis；用户明确比较时可compare。对象未知不能认定是同一笔持仓，在reason明确边界。撤回版本不得作为当前依据。relationshipFeedback中的rejected属于用户纠正，同一讨论不得重复采用被否认的关系；用户明确要求回看原文或重新比较时，可以作为回顾材料，但不得把旧关系当成成立。相似情境的否认要重新核对，不据此推断用户永久偏好。
用户明确指出某次历史关联不对，或明确认可它时，可从recentMemoryLinks选择link_feedback.id，quote逐字引用用户对关联的反馈；不能把没有反对、点开卡片、赞同投资结论当作认可关联。不清楚在指哪条关系时不写link_feedback，不猜。这个动作由程序执行，只有回执才代表已记住纠正。历史关系不合并原文，也不创建交易规则。
独立片段的focus一般为null。只有用户明确表达持续关注、验证假设、决策困惑或委托跟进才建立新focus；“做个记录”、泛盘面观察不创建持续关注。只有当前确实在接续/纠正同一待验证问题时才能选候选focus.id，不能仅凭名称相关就挂上旧关注。对历史作比较可以只引用，不必更新那个关注的工作状态。context_relation=independent时不得继承父片段中的持仓、市场对象或判断，reply必须以新问题为准。
先独立决定data_need，再决定审议深度。当前有明确标的，且回答依赖其走势/成交量/相对强弱时data_need=market_data；判断需要公告原文时official_search。缺的是个人动机或只梳理已提供逻辑时none。只交代未来跟进、回顾或纠正时none。不允许一边说“需要行情核实”，一边选择none把可执行任务留给用户。data_need非none时程序先执行工具，仍可review_required=true。不以其他股票的旧快照代替本次标的。
工具取数与独立审议分别决定：check仅表示先获取证据；若用户还要求比较原有理由与新选择、检验调整依据，review_required=true，即使只获取报价也要独立审议。纯粹问价、回顾、纠正的review_required=false。
路由：涉及原有理由与拟调整方向的实质比较、交易评价标准混淆时用review，让两个独立视角核验；但没有明确标的时先帮助拆清问题，只问一个关键问题，不盲目搜索。已有对象且需要核实公开事实时优先check。纠正某个周期或说明担心不是规则时用chat并更新背景，不触发完整重审。复杂投资假设、观点冲突、看材料判断变化用review；明确要求查公告、或回答眼前问题需要报价、行情走势、相对涨跌及最新事实时用check；在工具已覆盖且对象明确时主动取数，不必等用户再次说“调用接口”；普通问题、历史回顾、纠正、状态询问用chat。对现有论证的单一澄清（如单日回落是否改变假设）通常用chat；有新的实质材料、重要分歧或用户明确要求多角度重审时才再用review。用户说“接着推进”“继续查”时，结合workingState.next_action和delegatedTasks决定：已明确要推进且下一步是official_search或market_data可用check；旧状态曾要求行情截图时，应先用新接入的行情工具尝试，不能机械重复索要截图；其他下一步需要用户材料则只说明缺哪一份材料，不重复输出整篇报告或承诺已有数据。用户只问进展时总结真实已完成和卡点，不擅自开新查询。用户要求先评价逻辑时用review，不为了完整研究强制联网；但回答不能把无数据的市场假设说成事实。已有腾讯行情工具：沪深A股和上证指数、沪深300、科创50、深证成指、创业板指的供应商报价及日K（5/20/60个收盘间隔）。需要这些数据就用check；取数后注明供应商时间，不承诺交易所实时性。没有分时、全行业指数目录、资金净流入和订单工具，不能混为一谈。
在上述独立片段边界内，持续投资问题可以自然建立focus，不要求填表；只有明确接续同一待验证问题才引用其ID，不因关键词相近合并。个人软件连接、无持续投资判断的闲聊、泛知识问题不建立focus。用户说持有理由、犹豫调整或希望持续验证自己的做法，属于持续决策问题，应自然建立focus并关联原话，即使表达很随意、没有证券代码也可以。明确的虚构练习不得存成真实持仓背景。focus.quote必须来自本次用户原话，转发文章本身不等于用户认可其观点。focus.question写成待验证问题，不写已成立的事实。用户明确纠正正在关注的问题时，使用原有focus.id并给出修正后的question与原话quote，不要重复建立新关注。
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
    if(plan.focus.id!==run.topic_id&&!recalledTopics(run.id).has(plan.focus.id))throw Error('本次没有检索或指定这个关注，未自动关联');
    if(!existing)throw Error('找不到要接续的关注，未改变个人背景');
    topicId=existing.id;
    if(/(理解错|更正|纠正|关注的是|研究的是|想验证的是)/.test(record.content)&&plan.focus.question.trim()&&plan.focus.quote.length>=2&&record.content.includes(plan.focus.quote)){
     exec('UPDATE topics SET title=?,question=?,updated_at=? WHERE id=?',plan.focus.title||existing.title,plan.focus.question,now(),existing.id);
     bump();run.revision=revision();exec('UPDATE runs SET revision=? WHERE id=?',run.revision,run.id);invalidateGenerated(existing.id);receipt.focusUpdated=true;
     event(run.id,'focus_corrected',{topicId:existing.id,question:plan.focus.question,sourceId:record.id,quote:plan.focus.quote});
    }
   }else if(plan.focus.title.trim()&&plan.focus.question.trim()&&plan.focus.quote.length>=2&&record.content.includes(plan.focus.quote)){
    topicId=createTopic(plan.focus.title,plan.focus.question);
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
