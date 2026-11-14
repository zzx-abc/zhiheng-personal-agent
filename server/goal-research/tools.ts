import {all,one} from '../db';
import {terms,lexicalCards} from '../cards';
import {chunks,entry,search} from '../library/service';
import {provider} from '../model';
import {safePublicUrl} from '../security';
import {assessSourceTime} from '../source-time';
import {checkByNumber,latestCheck} from '../feishu/radar-checks';
import {eventBy,eventText,requireScope,type Scope} from '../feishu/unified-store';
import type {ThemeReport} from '../observation/theme-types';

export const toolNames=['find_material','read_material','radar','past_question','official'] as const;
export type Tool=typeof toolNames[number];
export type Source={ref:string;text:string;kind:'资料索引'|'作者原文'|'个人原话'|'历史行情'|'公告片段';asOf:string|null;location:string};
export type Result={
 status:'ok'|'partial'|'not_found'|'unavailable'|'denied'|'needs_authorization';
 data:Source[];coverage:string;error_code?:string;retryable:boolean;
 entries?:{id:string;version:number}[];records?:string[];checks?:string[];events?:string[];names?:string[];
};
export type Step={tool:Tool;arg:string;reason:string;result:Result};
export function empty(coverage:string,status:Result['status']='not_found',error_code='NO_MATCH'):Result{
 return {status,data:[],coverage,error_code,retryable:false};
}
const matches=(s:string,q:string)=>terms(q).split(' ').filter(w=>w&&s.toLowerCase().includes(w)).length;
export async function readTool(tool:Tool,arg:string,scope:Scope,goal:string,steps:Step[],bound:string[],signal:AbortSignal):Promise<Result>{
 requireScope(scope,true);
 if(tool==='find_material'){
  const rows=(await search(arg||goal)).results.slice(0,4);
  const keys=[...new Set([...bound,...rows.map(x=>x.id)])].slice(0,6);
  if(!keys.length)return empty('本人已收录资料中未找到匹配。');
  const sources=keys.map(entry);
  return {status:'ok',coverage:'标题只供定位，未读正文',retryable:false,entries:sources.map(({id,version})=>({id,version})),
   data:sources.map(e=>({ref:e.id,text:e.title,location:'本人资料库标题',kind:'资料索引',asOf:e.updated_at}))};
 }
 if(tool==='read_material'){
  if(![...bound,...steps.flatMap(s=>s.result.entries||[]).map(e=>e.id)].includes(arg))return empty('只能读取已定位或本人明确引用的材料。','denied','UNBOUND_ID');
  const e=entry(arg);
  const notes=all<{id:string;body:string;created_at:string;kind:string}>("SELECT * FROM library_annotations WHERE entry_id=? AND status='active' ORDER BY created_at DESC",arg);
  const originals=e.kind==='note'&&notes.some(n=>n.kind==='correction')?[]:chunks(arg) as {body:string;id:string;locator:string}[];
  const fragments=originals.sort((a,b)=>matches(b.body,goal)-matches(a.body,goal)).slice(0,4);
  const data:Source[]=[...notes.slice(0,3).map(n=>({ref:n.id,kind:'个人原话' as const,text:n.body.slice(0,550),location:e.title+' · 批注',asOf:n.created_at})),
   ...fragments.map(c=>({ref:c.id,kind:e.kind==='note'?'个人原话' as const:'作者原文' as const,text:c.body.slice(0,1400),location:e.title+' · '+c.locator,asOf:e.fetched_at}))];
  return {status:fragments.length?'ok':'partial',coverage:'当前版本选段；入库时间不代表披露日期。OCR数字仍需核对。'+(!fragments.length?'未取得正文。':''),data,retryable:false,entries:[{id:e.id,version:e.version}]};
 }
 if(tool==='past_question'){
  const keys=[...new Set(lexicalCards(arg||goal).flatMap(c=>JSON.parse(c.source_ids) as string[]))];
  const records=keys.map(key=>one<{id:string;content:string;created_at:string}>("SELECT * FROM records WHERE id=? AND role='user' AND NOT EXISTS(SELECT 1 FROM memories WHERE source_id=records.id AND status='withdrawn') AND kind NOT IN ('action_request','relation_feedback','weekly_feedback','tag_feedback')",key)).filter(x=>!!x).slice(0,3);
  if(!records.length)return empty('未定位到匹配的历史原话。');
  return {status:'ok',coverage:'历史表达仅证明当时说过，需核对是否同一事项',data:records.map(r=>({ref:r.id,text:r.content.slice(0,700),kind:'个人原话',location:'历史想法',asOf:r.created_at})),records:records.map(r=>r.id),retryable:false};
 }
 if(tool==='radar'){
  const refs=[...new Set(goal.toUpperCase().match(/\b[ER]-\d+\b/g)||[])];
  if(refs.length>1)return empty('需要明确一个历史检查或事件。','partial','AMBIGUOUS');
  if(refs[0]?.startsWith('E-')){
   const e=eventBy(scope,Number(refs[0].slice(2)));if(!e)return empty('未找到可访问的指定事件。');
   return {status:'ok',coverage:'该事件发生时的市场表现',data:[{ref:refs[0],kind:'历史行情',asOf:e.created_at,location:refs[0],text:eventText(e).slice(0,1200)}],events:[e.id],names:JSON.parse(e.payload).names||[],retryable:false};
  }
  let check;
  if(refs.length)check=checkByNumber(scope,Number(refs[0].slice(2)));
  else try{check=latestCheck(scope);}catch{return empty('没有可访问的近期主题检查。');}
  if(!check)return empty('没有可访问的指定检查。');
  const report:ThemeReport=JSON.parse(check.detail).themeReport;
  const explicit=report.themes.filter(t=>goal.includes(t.name)||t.name.includes(arg)&&arg.length>1);
  const themes=explicit.length?explicit:report.themes;
  const ref='R-'+check.number;
  return {status:'ok',coverage:'历史快照，仅供研究排序；成交或收益均不能证明收入。范围：'+themes.map(t=>t.name).join('、'),checks:[check.run_id],retryable:false,
   names:themes.flatMap(t=>t.stocks.map(s=>s.name)),data:themes.slice(0,5).map(t=>({ref:ref+'/'+t.id,kind:'历史行情',asOf:report.observedAt,location:ref+' · '+t.name,
    text:[t.name,t.status,...t.stocks.slice(0,8).map(s=>s.name+'：'+(s.phase||'阶段未知')+'；'+(s.next||s.missing?.join('、')||'未给出后续条件')),t.missing?.join('、')].filter(Boolean).join('\n').slice(0,1300)}))};
 }
 // Only an observed company name leaves this device, with a fixed public metric.
 const names=steps.flatMap(s=>s.result.names||[]);
 if(!names.includes(arg)||!/^([\p{Script=Han}A-Za-z0-9＊*·-]){2,20}$/u.test(arg))return empty('补查只接受授权快照返回的单一公司名。','needs_authorization','NO_PUBLIC_SUBJECT');
 const end=new Date(),begin=new Date(end.getTime()-90*86400000);
 const response=await provider('/tools/search_pro',{text_query:arg+' 营业收入 定期报告',sites:['cninfo.com.cn','sse.com.cn','szse.cn','bse.cn'],time_window:{start:begin.toISOString().slice(0,10),end:end.toISOString().slice(0,10)},limit:3,timeout_seconds:20},signal);
 if(!Array.isArray(response.search_results))return empty('公告查询返回格式异常。','unavailable','BAD_RESPONSE');
 const data:Source[]=[];
 for(const hit of response.search_results){
  if(typeof hit.url!=='string'||!safePublicUrl(hit.url))continue;
  const time=assessSourceTime(hit.url,hit.date,begin,end);if(time.outside)continue;
  const text=Array.isArray(hit.chunks)?hit.chunks.map((c:{text?:string})=>c.text||'').join('\n'):'';
  if(!text.trim()||!text.includes(arg)&&!String(hit.title||'').includes(arg))continue;
  data.push({ref:hit.url,kind:'公告片段',text:text.slice(0,1400),location:hit.url,asOf:time.pathDate});
 }
 return data.length?{status:'partial',data,coverage:'白名单近90天正文片段；须核对披露期间、对象与业务口径，未通读公告',retryable:false}:empty('近90天白名单未取得匹配正文片段。');
}
