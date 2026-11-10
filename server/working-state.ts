import {z} from 'zod';
import {one,all,exec,id,now,event,type Run} from './db';

const claim=z.object({text:z.string().min(1).max(700),sources:z.array(z.string()).max(6)});
// Personal decision context is quoted, never inferred from a sector or price move.
const personalQuote=z.object({quote:z.string().min(2).max(500),source_id:z.string()});
export const decisionFrameSchema=z.object({
 original_basis:personalQuote.nullable(),
 evaluation_horizon:personalQuote.nullable(),
 contemplated_change:personalQuote.nullable(),
 change_trigger:personalQuote.nullable(),
 validation_condition:personalQuote.nullable().optional(),
 invalidation_condition:personalQuote.nullable().optional(),
 reported_action:personalQuote.nullable().optional()
});
export const logicChangeSchema=z.object({
 kind:z.enum(['initial','new_evidence','thesis_revision','plan_change','correction','result_only','unresolved']),
 summary:z.string().min(1).max(400),
 before:personalQuote.nullable(),after:personalQuote
});
export const workingStateSchema=z.object({
 decision_frame:decisionFrameSchema.nullable().optional(),
 logic_change:logicChangeSchema.nullable().optional(),
 thesis:claim.extend({owner:z.enum(['user_hypothesis','agent_hypothesis'])}),
 assessment:z.string().min(1).max(900),
 assumptions:z.array(claim).max(4),
 evidence:z.array(claim.extend({direction:z.enum(['supports','challenges','context'])})).max(6),
 change_conditions:z.array(z.string().max(400)).max(4),
 open_questions:z.array(z.string().max(400)).max(5),
 next_action:z.object({kind:z.enum(['official_search','market_data','user_material','discussion']),question:z.string().min(1).max(500),reason:z.string().max(500)}).nullable(),
 change_summary:z.string().min(1).max(700)
});
export type WorkingState=z.infer<typeof workingStateSchema>;
export type StateVersion={id:string;topic_id:string;run_id:string;status:string;content:string;created_at:string;previous_id:string|null};
export function currentState(topicId:string|null){return topicId?one<StateVersion>("SELECT * FROM working_states WHERE topic_id=? AND status='current'",topicId):undefined;}
export function stateSourceIds(state:WorkingState){return [...new Set([
 ...[state.thesis,...state.assumptions,...state.evidence].flatMap(x=>x.sources),
 ...Object.values(state.decision_frame||{}).flatMap(x=>x?[x.source_id]:[]),
 ...[state.logic_change?.before,state.logic_change?.after].flatMap(x=>x?[x.source_id]:[])
])];}
export function validateState(state:WorkingState,allowed:Set<string>){
 for(const item of [...Object.values(state.decision_frame||{}),state.logic_change?.before,state.logic_change?.after]){
  if(!item)continue;
  const source=one<{content:string}>("SELECT content FROM records WHERE id=? AND role='user'",item.source_id);
  if(!allowed.has(item.source_id)||!source?.content.includes(item.quote))throw Error('个人决策背景必须逐字引用可用的用户原文');
 }
 const change=state.logic_change;
 if(change){
  if(['thesis_revision','plan_change'].includes(change.kind)&&(!change.before||change.before.quote===change.after.quote))throw Error('逻辑变化需要明确的前后原话，不能由涨跌倒推');
  if(change.before){
   const before=one<{created_at:string}>('SELECT created_at FROM records WHERE id=?',change.before.source_id)!;
   const after=one<{created_at:string}>('SELECT created_at FROM records WHERE id=?',change.after.source_id)!;
   if(before.created_at>after.created_at)throw Error('逻辑变化的前后时间不能颠倒');
  }
 }
 for(const item of [state.thesis,...state.assumptions,...state.evidence]){
  if(item.sources.some(source=>!allowed.has(source)))throw Error('工作状态包含不存在的依据，未更新');
 }
 if(state.thesis.owner==='user_hypothesis'&&!state.thesis.sources.length)throw Error('用户假设必须关联原始表达');
 for(const item of state.evidence)if(!item.sources.length)throw Error('证据不能只有模型的无来源判断');
 if(state.thesis.owner==='user_hypothesis'&&!state.thesis.sources.some(source=>one("SELECT id FROM records WHERE id=? AND role='user'",source)))throw Error('用户假设必须引用用户原文');
}
// Called in the same transaction as the answer, after revision/cancellation checks.
export function saveState(run:Run,state:WorkingState,allowed:Set<string>){
 if(!run.topic_id)return;
 validateState(state,allowed);
 const previous=one<StateVersion>('SELECT * FROM working_states WHERE topic_id=? ORDER BY rowid DESC LIMIT 1',run.topic_id);
 exec("UPDATE working_states SET status='superseded' WHERE topic_id=? AND status='current'",run.topic_id);
 const key=id();exec('INSERT INTO working_states VALUES(?,?,?,?,?,?,?)',key,run.topic_id,run.id,'current',JSON.stringify(state),now(),previous?.id||null);
 event(run.id,'working_state_updated',{stateId:key,previousId:previous?.id||null,change:state.change_summary});
}
export function stateVersions(){return all<StateVersion>('SELECT * FROM working_states ORDER BY rowid DESC');}
export const workingStateFormat=`若本次涉及持续关注事项，另填 working_state（完整的当前工作状态，非仅本轮摘要；无实质变化用null）。格式：{logic_change:null或{kind:"initial/new_evidence/thesis_revision/plan_change/correction/result_only/unresolved",summary:"本轮变化类型与依据",before:null或{quote,source_id},after:{quote,source_id}},thesis:{text:"正在验证的条件性假设",owner:"user_hypothesis或agent_hypothesis",sources:[原文ID]},assessment:"当前判断及其边界",assumptions:[{text:"因果链上需要成立的前提",sources:[]}],evidence:[{text:"证据说了什么及局限",direction:"supports或challenges或context",sources:[来源ID]}],change_conditions:["什么可观察到的新证据会改变判断"],open_questions:["尚未解决的问题"],next_action:{kind:"official_search或market_data或user_material或discussion",question:"可直接执行的单一具体问题",reason:"为什么先做这一步"}或null,change_summary:"相比上一版本实际改变了什么；首次说明开始验证什么"}。
一张行情截图只用于局部核对，不能单凭放量上涨确认主线、或缩量确认高低切换；next_action.reason要说明先补哪一小段证据，不说一张图足以判别整个假设。能通过现有工具获得的公开证据应由你核实，不转交用户搜集；只有缺失个人背景、标的身份或工具无法获取的材料时，才问一个会改变判断的关键问题。不要要求用户计算指标或填写完整交易体系。假设正文保留“可能/是否”等条件性表达。判断变化条件描述“增强/削弱哪种解释”，不能将几项价格观测直接写成确定证明主线或反弹。你必须维护同一关注事项的持续状态，保留仍有效的问题和证据，合并新事实，移除被明确纠正的归纳。不要因本次只问一个子问题就丢掉原本的完整研究目标。旧状态是模型归纳，不是事实；用原文和当前纠正优先校正。每项证据必须有来源，用户原文仅证明表达，转发材料必须注明为用户提供、尚未独立核实。模型推理放assessment/assumptions，不能编成外部证据。用户假设必须引用用户原文；你提出的替代解释用agent_hypothesis，不能写成用户认可的原则。next_action仅建议，不等于委托或已执行；market_data下一步每次最多三个证券，可为三只当前标的，或两只样本加一个基准，只用最新可得5/20/60个收盘间隔；不要一次列六七只证券或承诺固定历史起止窗口，其他方向保留为后续缺口。已接入腾讯行情工具，沪深A股及常用指数的报价、5/20/60期日K与同期相对涨跌应选market_data，不要再索要这些行情的截图。仅有工具不覆盖的数据或无法确认的标的才选user_material。历史状态说“没有行情源”已经过时，不要沿用。只能按已返回的日期更新，不把旧快照作为今天行情；个股样本不能当板块指数。查证后参考真实researchOutcome：遇到来源或指标缺口就转成具体待补材料，不反复提出同一条已失败查询。纠正时更新受影响的判断，不能仅说收到却保留错误假设。
若用户涉及持有理由、交易周期或想调整，working_state中同时保存decision_frame:{original_basis:null或{quote,source_id},evaluation_horizon:null或{quote,source_id},contemplated_change:null或{quote,source_id},change_trigger:null或{quote,source_id},validation_condition:null或{quote,source_id},invalidation_condition:null或{quote,source_id},reported_action:null或{quote,source_id}}。分别保存原来关注/持有的理由、本人明确的验证周期、当前考虑的改变、触发改变的情况；每项quote必须是用户原文逐字片段，source_id必须指向用户原文。没有明确表达的字段用null，不能从行业景气推断中线、从热点推断短线、从想换仓推断已成交。用户提供的转述不是其个人事实。它是当前情境，不是原则。保持仍有效的历史依据；纠正后替换或清空受影响字段；已经完成或撤回的调整不能继续写成待执行。decision_frame本身没有新的语义时可以保持原值，无此背景用null。`;

export const decisionLogicFormat=`持续交易判断的 working_state 要维护 decision_frame，而非只保留本轮摘要。额外字段 validation_condition、invalidation_condition、reported_action 均为null或{quote,source_id}：用户明确的验证条件、失效条件、本人报告的实际行动（包括明确尚未行动）。只引用用户原话，不把你建议的条件写成用户的计划。未知留null；观察期限不等于持有期限。旧调整已实施或撤回时更新contemplated_change，避免把旧计划继续当待办。
working_state必须包含logic_change字段，首次建立用initial，用户纠正用correction，纯复述没有变化用null。有实质新增时填 logic_change:{kind:"initial/new_evidence/thesis_revision/plan_change/correction/result_only/unresolved",summary:"这次究竟改变了什么；简短、可被用户纠正",before:null或{quote,source_id},after:{quote,source_id}}。initial首次整理；new_evidence用户提供新材料（并非已核实）；thesis_revision判断前提改变；plan_change明确修改计划；correction纠正你的理解；result_only仅报告结果，不代表原逻辑对错；unresolved尚不能判断原因。前后都必须逐字引用用户记录，after来自本次表达。thesis_revision、plan_change必须有不同的前后原话；一段回述可含前后，但不能把记述顺序当成交日期。没有变化用null。summary是模型解释，不是已证实事实。仅出现涨跌不能标为thesis_revision。同股另一笔交易必须新建关注，不覆盖原交易；不同证券若属于用户明确的一次换仓决策可一起梳理。
对用户只展示最重要的判断、一个关键缺口和具体下一步。不要要求填表，也不要罗列所有未知。缺的是公开证据就用工具，缺的是个人意图才问人；建议核验条件放change_conditions，不自动写成个人规则。`;
