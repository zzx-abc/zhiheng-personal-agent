import {createHash} from 'node:crypto';
import {exec,id,now,event,type Run} from './db';
import {fetchMarketData,type MarketRequest,type MarketResult} from './market-data';
export async function executeMarketResearch(run:Run,request:MarketRequest,scope:string,signal:AbortSignal,alive:()=>void,phase:(name:string,detail?:unknown)=>void,fetcher=fetchMarketData){
 phase('market_data',{instruments:request.instruments,observation:request.observation,sessions:request.sessions});
 let result:MarketResult;
 try{result=await fetcher(request,signal);}catch(error){alive();const message=error instanceof Error?error.message:'行情接口不可用';event(run.id,'market_data_result',{observation:request.observation,success:false,reason:message});event(run.id,'research_finished',{tool:'market_data',status:'blocked',reason:message,achieved:[],missing:['本次行情未取得'],next_requirement:'稍后重试；也可以提供带日期的材料。不会把历史快照作为新行情。',searches:0,requests:0,scope,windowDays:0});return ['本次腾讯行情获取失败：'+message];}
 alive();const {data}=result;
 const enough=data.instruments.length===request.instruments.length&&(request.observation==='quote'||data.instruments.every(i=>i.history&&i.history.intervals>=request.sessions));
 if(data.instruments.length){const body=JSON.stringify(result);exec('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)',id(),run.id,'腾讯行情 · '+data.instruments.map(i=>i.name).join(' / '),data.sourceUrls[0],body,null,data.observedAt,'market',createHash('sha256').update(body).digest('hex'));}
 const warnings=[...data.warnings];if(!enough&&!warnings.length)warnings.push('只取得部分行情，不能回答缺失部分');
 event(run.id,'market_data_result',{observation:request.observation,success:enough,symbols:data.instruments.map(i=>i.symbol),dataTimes:data.instruments.map(i=>i.quote.asOf),requests:data.requests,warnings});
 // Data retrieval is complete; resolving the investment thesis is left to the
 // independent review. This receipt never upgrades the thesis to a fact.
 event(run.id,'research_finished',{tool:'market_data',status:enough&&!warnings.length?'answered':'limited',reason:enough?'已取得所选证券的行情快照'+(request.observation==='daily'?'及历史日线，并按共同日期计算比较。':'。')+'这只完成行情取数，不等于投资假设已成立。':'本次只获得部分行情，缺失部分未推断。',achieved:data.instruments.map(i=>i.name+'：供应商行情时间 '+i.quote.asOf+(i.history?'；区间 '+i.history.start+' 至 '+i.history.end:'')),missing:warnings,next_requirement:enough?'':warnings.join('；'),searches:0,requests:data.requests,scope,windowDays:0});
 return warnings;
}
/** Public raw payloads are kept for audit/export but are not repeated in every model prompt. */
export function marketContext(body:string){const parsed=JSON.parse(body) as MarketResult;return JSON.stringify(parsed.data);}
