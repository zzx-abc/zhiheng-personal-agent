import {z} from 'zod';
import {createHash} from 'node:crypto';
import {all,one,exec,id,now,event,type Run,type RecordRow,type Topic,type Evidence} from './db';
import {contract,provider,type ModelCall} from './model';
import {safePublicUrl} from './security';
import {assessSourceTime} from './source-time';
import {currentState} from './working-state';
import {marketRequestSchema,indexNames,chinaDate} from './market-data';
import {executeMarketResearch} from './market-research';

export const researchDecisionSchema=z.object({
 decision:z.enum(['answered','continue','blocked']),reason:z.string().min(1).max(700),
 achieved:z.array(z.string().max(500)).max(4),missing:z.array(z.string().max(500)).max(5),
 next_query:z.string().max(200).nullable(),next_requirement:z.string().max(600)
});
export type ResearchOutcome={tool?:'market_data';requests?:number;status:'answered'|'blocked'|'limited';reason:string;achieved:string[];missing:string[];next_requirement:string;searches:number;scope:string;windowDays:number};
export async function research(run:Run,record:RecordRow,topic:Topic|undefined,call:ModelCall,signal:AbortSignal,alive:()=>void,phase:(name:string,detail?:unknown)=>void,tool=provider){
 const state=currentState(run.topic_id);const oldState=state?JSON.parse(state.content):null;const workingState=oldState?{thesis:oldState.thesis,decision_frame:oldState.decision_frame,assessment:oldState.assessment,...(record.content.length<40&&/继续|接着/.test(record.content)?{next_action:oldState.next_action}:{})}:null;
 phase('planning');
 const planSchema=z.object({tool:z.enum(['official_search','market_data']).default('official_search'),market:marketRequestSchema.nullable().default(null),query:z.string().max(200).nullable().default(null),scope:z.string().max(500),window_days:z.union([z.literal(30),z.literal(90)]).default(30),blocked_reason:z.string().max(500).default('')});
 const plan=planSchema.parse(await call(contract+`你规划一项有边界的官方材料查证。当前用户问题是本次任务，优先于旧状态、旧待办和旧样本。用户列出具体公司时，只查本次公司的一个或多个，不可替换成旧话题的代表股；最多3个证券，可选择三只主体而不强制加入基准。用户描述历史操作时，行情仅作当前或有限历史佐证，不得假装支持任意指定日期。根据当前问题及工作状态选择最有信息价值的一步，不重做已解决问题。以输入today和时间窗为准选择最近已披露期间，不得凭训练知识默认2025年。行情需要时选择tool=market_data，直接通过腾讯行情工具查价和日K。仅支持沪深A股(sh60/sh68/sz00/sz30开头的6位代码)和常用指数，不支持分时、资金净流入或成交额占比。行情不需要用户补截图。对支持/不支持的混合需求先完成能做的部分，在scope说明边界。只问现价用observation=quote，不额外拉历史。比较近几周走势用daily；不确定对象时market=null，只问一个关键问题。行业问题可以查代表个股加基准，但必须在scope明确样本不是行业指数，不擅自编造板块代码。只生成公司、证券代码、行业与公开经营指标的查询，不包含用户身份、持仓、金额或私人经历。单次只查一个主体的一个关键指标；行业问题可以选代表公司，但scope明确不能代表全行业。输出 {tool:official_search或market_data,market:null或{instruments:[{symbol:带市场前缀代码,name:证券全名,role:subject或benchmark}],observation:quote或daily,sessions:5或20或60},query:一条具体中文查询或null,scope:范围,window_days:30或90,blocked_reason:不能执行的原因或空}。日K当前只支持最新可得5/20/60个收盘间隔，不支持任意固定起止日期；用户指定旧历史窗口时不要悄悄改为最近区间，在blocked_reason说明。最多3个证券（最多1个基准），名称会与真实接口校验，不知道名称或代码不要猜。用户说“它突然拉起来”但没有明确证券时，即使有行业背景也不能随意挑一个股票替代；market=null，blocked_reason只询问要看哪只证券。新公告30天，最近一期季度披露90天。不要承诺全量或自动监测。`,JSON.stringify({today:chinaDate(),now:now(),timezone:'Asia/Shanghai',supportedIndices:indexNames,topic,question:record.content,workingState}),planSchema));
 alive();
 if(plan.tool==='market_data'&&plan.market)return executeMarketResearch(run,plan.market,plan.scope,signal,alive,phase);
 const errors:string[]=[];let searches=0;
 const finish=(outcome:Omit<ResearchOutcome,'searches'|'scope'|'windowDays'>)=>{
  alive();event(run.id,'research_finished',{...outcome,searches,scope:plan.scope,windowDays:plan.window_days});
  if(outcome.status!=='answered')errors.push(outcome.reason+'；'+outcome.next_requirement);
  event(run.id,'coverage',{read:all('SELECT id FROM evidence WHERE run_id=?',run.id).length,errors,windowDays:plan.window_days,exhaustive:false});
  return errors;
 };
 if(!plan.query)return finish({status:'blocked',reason:plan.blocked_reason||'尚无适用的公开查询',achieved:[],missing:['缺少可执行的数据来源或明确对象'],next_requirement:plan.blocked_reason||'请提供要核实的公司或原始材料。'});
 const end=new Date(),begin=new Date(end);begin.setDate(begin.getDate()-plan.window_days);
 const attempted:string[]=[];let query=plan.query;
 // The program enforces a finite two-search budget; the model decides whether a
 // different second search can resolve a specific remaining gap. No scheduling.
 for(let step=1;step<=2;step++){
  alive();phase('searching',{step,limit:2,query,scope:plan.scope});attempted.push(query);searches++;
  const stepErrors:string[]=[];
  try{
   const result=await tool('/tools/search_pro',{text_query:query,sites:['cninfo.com.cn','sse.com.cn','szse.cn','bse.cn'],time_window:{start:begin.toISOString().slice(0,10),end:end.toISOString().slice(0,10)},limit:4,timeout_seconds:25},signal);
   if(!Array.isArray(result.search_results))throw Error('搜索返回格式不符合接口，不能判为没有信息');
   event(run.id,'search_result',{step,query,count:result.search_results.length,from:begin.toISOString(),to:end.toISOString()});
   for(const item of result.search_results){
    alive();if(all('SELECT id FROM evidence WHERE run_id=?',run.id).length>=6)break;
    if(typeof item.url!=='string'||!safePublicUrl(item.url))continue;
    if(one('SELECT id FROM evidence WHERE run_id=? AND url=?',run.id,item.url))continue;
    const timing=assessSourceTime(item.url,item.date,begin,end);
    if(timing.outside){stepErrors.push('已排除时间窗外来源：'+item.url);continue;}
    if(timing.uncertain)stepErrors.push('原文发布日期未核实：'+item.url);
    const chunks=Array.isArray(item.chunks)?item.chunks.map((c:{text?:string})=>c.text||'').join('\n'):'';
    let body=chunks,level=chunks?'excerpt':'discovery';
    if(!body){try{const fetched=await tool('/tools/fetch',{url:item.url},signal);body=String(fetched.content||fetched.markdown||fetched.result?.content||'');if(body)level='body';}catch{stepErrors.push('正文读取失败：'+item.url);}}
    if(!body){body=typeof item.snippet==='string'?item.snippet:'';stepErrors.push('只有搜索摘要，未核实正文：'+item.url);}
    if(!body)continue;
    const hash=createHash('sha256').update(item.url+'\n'+body).digest('hex');
    alive();exec('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)',id(),run.id,String(item.title||'未命名材料'),item.url,timing.note+'\n\n'+body.slice(0,10000),timing.pathDate,now(),level,hash);
   }
  }catch(e){alive();stepErrors.push(e instanceof Error?e.message:'检索失败');}
  errors.push(...stepErrors);
  phase('evaluating',{step,limit:2});
  const evidence=all<Evidence>('SELECT * FROM evidence WHERE run_id=?',run.id);
  const decision=researchDecisionSchema.parse(await call(contract+`你评估真实工具结果是否推进了用户委托，而不是写研究报告。输出 {decision:"answered"|"continue"|"blocked",reason:"为什么",achieved:["实际查清的子问题及依据范围"],missing:["仍缺的具体信息"],next_query:一条更具体的新查询或null,next_requirement:"如果停止，靠什么才能继续"}。answered仅限相关正文/片段直接回答核心问题；search摘要discovery、概念词命中、基金持仓披露都不能证明设备订单或晶圆厂资本开支改善。不能把零命中说成事实不存在。continue仅在还有检索次数且一个不同的查询有合理机会补足缺口；否则blocked。next_query只含公开公司、代码、经营指标，不包含私人信息。即使查清一个样本也不能升级整个行业的结论。不得承诺已执行下一查询。以today及from/to为准，不得无依据回退到去年的报告。剩余检索次数是本次程序的次数上限，不是API余额不足；next_requirement不要让用户增加额度或修改预算，只说明缺哪一份现成材料。achieved只写有直接资料支持的查证成果，确定查询计划不算查清事实。`,JSON.stringify({today:chinaDate(),now:now(),timezone:'Asia/Shanghai',from:begin.toISOString(),to:end.toISOString(),question:record.content,topic,workingState,scope:plan.scope,remainingSearches:2-step,attempted,evidence,toolWarnings:stepErrors}),researchDecisionSchema));
  alive();event(run.id,'research_decision',{step,...decision});
  const hasBody=evidence.some(e=>e.level==='body'||e.level==='excerpt');
  if(decision.decision==='answered'&&hasBody)return finish({status:'answered',reason:decision.reason,achieved:decision.achieved,missing:decision.missing,next_requirement:decision.next_requirement});
  if(decision.decision==='blocked')return finish({status:'blocked',reason:decision.reason,achieved:hasBody?decision.achieved:[],missing:decision.missing,next_requirement:decision.next_requirement});
  if(step===2||!decision.next_query?.trim()||attempted.includes(decision.next_query))return finish({status:'limited',reason:decision.decision==='answered'?'只有发现线索，尚无可核实正文':decision.reason,achieved:hasBody?decision.achieved:[],missing:decision.missing,next_requirement:decision.next_requirement||'本次有限查证未解决问题；补充原始公告或指定公司后再继续。'});
  query=decision.next_query;
 }
 return errors;
}
