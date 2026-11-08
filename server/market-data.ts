import {z} from 'zod';
export const indexNames:Record<string,string>={sh000001:'上证指数',sh000300:'沪深300',sh000688:'科创50',sz399001:'深证成指',sz399006:'创业板指'};
export const supportedSymbol=(s:string)=>/^(sh(?:60|68)\d{4}|sz(?:00|30)\d{4})$/.test(s)||Object.hasOwn(indexNames,s);
export const marketRequestSchema=z.object({instruments:z.array(z.object({symbol:z.string().refine(supportedSymbol,'仅支持沪深A股和已接入的常用指数'),name:z.string().min(1).max(30),role:z.enum(['subject','benchmark']).default('subject')})).min(1).max(3),observation:z.enum(['quote','daily']).default('daily'),sessions:z.union([z.literal(5),z.literal(20),z.literal(60)]).default(20)}).refine(x=>new Set(x.instruments.map(i=>i.symbol)).size===x.instruments.length,'证券不能重复').refine(x=>x.instruments.filter(i=>i.role==='benchmark').length<=1,'最多一个比较基准');
export type MarketRequest=z.infer<typeof marketRequestSchema>;
export type Quote={symbol:string;name:string;kind:'stock'|'index';price:number;previousClose:number|null;open:number|null;high:number|null;low:number|null;changePercent:number|null;asOf:string;providerTime:string;currency:'CNY'|'index_points';volumeRaw:number|null;volumeUnit:string;fetchedAt:string;cacheHit:boolean;note:string};
export type Bar={date:string;open:number;close:number;high:number;low:number;volumeRaw:number};
export type History={symbol:string;adjustment:'qfq'|'none';bars:Bar[];url:string;fetchedAt:string;cacheHit:boolean};
export type MarketSummary={symbol:string;name:string;quote:Quote;history?:{adjustment:string;start:string;end:string;observations:number;requestedIntervals:number;intervals:number;returnPercent:number;last5VsPrevious5Volume:number|null;note:string}};
export type MarketResult={data:{provider:string;observedAt:string;request:MarketRequest;instruments:MarketSummary[];comparisons:{symbol:string;benchmark:string;start:string;end:string;intervals:number;subjectReturnPercent:number;benchmarkReturnPercent:number;excessPercentagePoints:number;basis:string}[];warnings:string[];limitations:string[];requests:number;sourceUrls:string[]};raw:{url:string;fetchedAt:string;cacheHit:boolean;body:string}[]};
export function chinaDate(d=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
function validDate(d:string){return /^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;}
const number=(s:unknown)=>typeof s==='string'&&s.trim()!==''&&Number.isFinite(Number(s))?Number(s):null;
const positive=(s:unknown)=>{const n=number(s);return n!==null&&n>0?n:null};
const rounded=(n:number)=>Math.round(n*10000)/10000;
export function parseQuote(text:string,symbol:string,fetchedAt:string,cacheHit=false):Quote{
 if(!supportedSymbol(symbol))throw Error('不支持的证券代码');
 const match=text.match(new RegExp('(?:^|\\n)v_'+symbol+'="([^"\\r\\n]*)";?'));
 if(!match)throw Error(symbol+' 未返回可识别行情');const f=match[1].split('~');
 if(f.length<35||f[2]!==symbol.slice(2)||!f[1]||f[1].includes('\ufffd'))throw Error(symbol+' 名称/代码/编码校验失败');
 const t=f[30];if(!/^\d{14}$/.test(t)||!validDate(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`))throw Error(symbol+' 缺少有效行情时间');
 const asOf=`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}+08:00`;
 if(!Number.isFinite(Date.parse(asOf))||Date.parse(asOf)>Date.parse(fetchedAt)+300000)throw Error(symbol+' 行情时间异常');
 const price=positive(f[3]);if(price===null)throw Error(symbol+' 未提供有效最新价格');const previousClose=positive(f[4]);
 const reportedChange=number(f[32]);
 if(previousClose&&reportedChange!==null&&Math.abs((price/previousClose-1)*100-reportedChange)>0.03)throw Error(symbol+' 涨跌字段与价格不一致，可能发生接口格式变更');
 return {symbol,name:f[1],kind:Object.hasOwn(indexNames,symbol)?'index':'stock',price,previousClose,open:positive(f[5]),high:positive(f[33]),low:positive(f[34]),changePercent:previousClose?rounded((price/previousClose-1)*100):null,asOf,providerTime:t,currency:Object.hasOwn(indexNames,symbol)?'index_points':'CNY',volumeRaw:number(f[6]),volumeUnit:'供应商原始单位，未统一；不能跨证券相加或与金额混用',fetchedAt,cacheHit,note:asOf.slice(0,10)!==chinaDate(new Date(fetchedAt))?'行情日与抓取日不同；只能称为该时间的最新返回，不能称为今天成交。':'供应商该时刻快照；不保证交易所实时性，不推断开市/停牌状态。'};
}
export function parseHistory(text:string,symbol:string,url:string,fetchedAt:string,cacheHit=false):History{
 const response=JSON.parse(text),data=response.data?.[symbol];if(response.code!==0||!data)throw Error(symbol+' 日K接口未返回数据');
 const adjustment=Array.isArray(data.qfqday)?'qfq':'none';if(!(Object.hasOwn(indexNames,symbol))&&adjustment!=='qfq')throw Error(symbol+' 前复权日K缺失，不用不复权数据替代');
 const rows=adjustment==='qfq'?data.qfqday:data.day;if(!Array.isArray(rows)||!rows.length||rows.length>100)throw Error(symbol+' 日K格式异常');
 let previous='';const bars:Bar[]=rows.map((r:unknown[])=>{
  if(!Array.isArray(r)||typeof r[0]!=='string'||!validDate(r[0])||r[0]<=previous||r[0]>chinaDate(new Date(fetchedAt)))throw Error(symbol+' 日K日期异常或重复');
  const [open,close,high,low]=r.slice(1,5).map(positive),volumeRaw=number(r[5]);
  if(open===null||close===null||high===null||low===null||volumeRaw===null||volumeRaw<0||high<Math.max(open,close,low)||low>Math.min(open,close,high))throw Error(symbol+' 日K数值校验失败');
  previous=r[0];return {date:r[0],open,close,high,low,volumeRaw};
 });return {symbol,adjustment,bars,url,fetchedAt,cacheHit};
}
export function historyMetrics(history:History,sessions:number,today:string){
 const bars=history.bars.filter(b=>b.date<today).slice(-(sessions+1));if(bars.length<2)throw Error(history.symbol+' 缺少两个完整历史日');
 const last=bars.at(-1)!,first=bars[0];const volume=bars.length>=10?bars.slice(-5).reduce((a,b)=>a+b.volumeRaw,0):null;
 const previous=bars.length>=10?bars.slice(-10,-5).reduce((a,b)=>a+b.volumeRaw,0):null;
 return {adjustment:history.adjustment,start:first.date,end:last.date,observations:bars.length,requestedIntervals:sessions,intervals:bars.length-1,returnPercent:rounded((last.close/first.close-1)*100),last5VsPrevious5Volume:volume!==null&&previous?rounded(volume/previous):null,note:'收益为区间两端收盘价变化；保守排除抓取日K线，避免盘中不完整成交量。量比仅同一证券最近5个完整日与此前5日之比，不是资金净流入。'};
}
export function compareHistories(a:History,b:History,sessions:number,today:string){
 const other=new Map(b.bars.map(x=>[x.date,x]));const dates=a.bars.filter(x=>x.date<today&&other.has(x.date)).slice(-(sessions+1));if(dates.length<2)throw Error('没有足够共同交易日进行比较');
 const first=dates[0],last=dates.at(-1)!,subject=(last.close/first.close-1)*100,benchmark=(other.get(last.date)!.close/other.get(first.date)!.close-1)*100;
 return {symbol:a.symbol,benchmark:b.symbol,start:first.date,end:last.date,intervals:dates.length-1,subjectReturnPercent:rounded(subject),benchmarkReturnPercent:rounded(benchmark),excessPercentagePoints:rounded(subject-benchmark),basis:`共同日期对齐；个股口径 ${a.adjustment}，基准口径 ${b.adjustment}；价格涨幅之差（百分点），非含分红总回报或统计alpha。`};
}
const cache=new Map<string,{body:string;fetchedAt:string;expires:number}>();
export async function fetchMarketData(input:MarketRequest,signal:AbortSignal,transport:typeof fetch=fetch,clock=()=>new Date()):Promise<MarketResult>{
 const request=marketRequestSchema.parse(input);const raw:MarketResult['raw']=[];let requests=0;
 async function get(url:string,encoding:string,ttl:number){
  if(signal.aborted)throw signal.reason;const old=transport===fetch?cache.get(url):undefined;const at=clock();
  if(old&&old.expires>at.getTime()){const item={url,body:old.body,fetchedAt:old.fetchedAt,cacheHit:true};raw.push(item);return item;}
  requests++;const res=await transport(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),redirect:'error',headers:{Accept:'*/*'}});
  if(!res.ok)throw Error('腾讯行情接口返回 HTTP '+res.status);
  const reader=res.body?.getReader();if(!reader)throw Error('行情响应为空');const parts:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1000000){await reader.cancel();throw Error('行情响应超过大小上限');}parts.push(r.value);}}finally{reader.releaseLock();}
  const bytes=Buffer.concat(parts),body=new TextDecoder(encoding).decode(bytes),fetchedAt=clock().toISOString();
  if(transport===fetch){if(cache.size>=100)cache.delete(cache.keys().next().value!);cache.set(url,{body,fetchedAt,expires:Date.parse(fetchedAt)+ttl});}
  const item={url,body,fetchedAt,cacheHit:false};raw.push(item);return item;
 }
 const warnings:string[]=[],instruments:MarketSummary[]=[],histories=new Map<string,History>();
 const quoteUrl='https://qt.gtimg.cn/q='+request.instruments.map(x=>x.symbol).sort().join(',');
 const quotes=await get(quoteUrl,'gb18030',30000);
 const normalize=(s:string)=>s.replace(/指数|\s/g,'');
 for(const item of request.instruments){
  try{
   const quote=parseQuote(quotes.body,item.symbol,quotes.fetchedAt,quotes.cacheHit);
   if(normalize(quote.name)!==normalize(item.name))throw Error(`名称与代码不匹配：${item.symbol} 返回 ${quote.name}，规划名称是 ${item.name}；未使用`);
   const summary:MarketSummary={symbol:item.symbol,name:quote.name,quote};instruments.push(summary);
   if(request.observation==='daily'){
    try{const url=`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${item.symbol},day,,,65,qfq`;const payload=await get(url,'utf-8',300000);const history=parseHistory(payload.body,item.symbol,url,payload.fetchedAt,payload.cacheHit);histories.set(item.symbol,history);summary.history=historyMetrics(history,request.sessions,chinaDate(clock()));if(summary.history.intervals<request.sessions)warnings.push(item.symbol+' 完整历史日不足所需区间');if(quote.asOf.slice(0,10)<chinaDate(clock())&&history.bars.at(-1)!.date<quote.asOf.slice(0,10))warnings.push(item.symbol+' 历史日K落后于报价日期，不当作最新完整区间');}
    catch(error){if(signal.aborted)throw error;warnings.push(item.symbol+' 历史数据未完成：'+(error instanceof Error?error.message:'请求失败'));}
   }
  }catch(error){if(signal.aborted)throw error;warnings.push(error instanceof Error?error.message:'证券数据不可用');}
 }
 const comparisons:MarketResult['data']['comparisons']=[];
 const benchmark=request.instruments.find(x=>x.role==='benchmark');
 if(benchmark&&request.observation==='daily')for(const item of request.instruments.filter(x=>x.role==='subject')){
  const a=histories.get(item.symbol),b=histories.get(benchmark.symbol);
  if(a&&b){try{const c=compareHistories(a,b,request.sessions,chinaDate(clock()));comparisons.push(c);if(c.intervals<request.sessions)warnings.push(item.symbol+' 与基准的共同历史日不足所需区间');}catch(error){warnings.push(error instanceof Error?error.message:'无法对齐比较');}}
 }
 return {data:{provider:'腾讯财经网页行情接口（未发现公开稳定性或再分发授权承诺）',observedAt:clock().toISOString(),request,instruments,comparisons,warnings,requests,sourceUrls:raw.map(r=>r.url),limitations:['只取得供应商返回时间的报价，不保证实时；历史引用不能当作当前行情。','个股是有限样本，不能当作半导体行业指数或全市场资金证据。','成交量原始单位未统一，只计算同一证券的日量变化；不支持成交额占全市场比例、资金净流入、分时和订单数据。','接口不可用时明确报缺失，不用旧快照冒充新行情。']},raw};
}
