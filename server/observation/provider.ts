import * as XLSX from 'xlsx';
import {createHash} from 'node:crypto';
import {all,one,exec,now} from '../db';
import {parseQuote,parseHistory,supportedSymbol} from '../market-data';
import './db';
import {selectedGroups,type ObservationConfig,type Frame,type Group,type DataPoint} from './types';
import {calendarVersion,localParts} from './calendar';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const inFlight=new Map<string,Promise<{bytes:Buffer;receivedAt:string}>>();
let nextRequestAt=0;
async function throttle(signal:AbortSignal){
 const slot=Math.max(Date.now(),nextRequestAt);nextRequestAt=slot+500;
 if(signal.aborted)throw Error('采集已取消');
 if(slot>Date.now())await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(Error('采集已取消'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},slot-Date.now());signal.addEventListener('abort',abort,{once:true});});
}
function diagnostic(error:unknown){const message=error instanceof Error?error.message:'';const http=message.match(/HTTP \d{3}/)?.[0];return http||(/timeout|abort/i.test(message)?'请求超时或取消':'字段/日期/口径校验未通过');}
export async function mapLimited<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>){const output:R[]=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;output[i]=await fn(items[i]);}}));return output;}
async function get(url:string,ttl:number,signal:AbortSignal,transport:typeof fetch,clock:()=>Date){
 const existing=transport===fetch?one<{body:string;received_at:string;expires_at:string}>('SELECT * FROM observation_cache WHERE url=?',url):undefined;
 if(existing&&existing.expires_at>clock().toISOString())return {bytes:Buffer.from(existing.body,'base64'),receivedAt:existing.received_at};
 const active=transport===fetch?inFlight.get(url):undefined;if(active)return active;
 const request=(async()=>{
  if(transport===fetch)await throttle(signal);
  const r=await transport(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),redirect:'error'});if(!r.ok)throw Error('数据源 HTTP '+r.status);
  const reader=r.body?.getReader();if(!reader)throw Error('数据源返回为空');const parts:Uint8Array[]=[];let size=0;
  try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>3000000){await reader.cancel();throw Error('数据超过读取上限');}parts.push(x.value);}}finally{reader.releaseLock();}
  const bytes=Buffer.concat(parts),receivedAt=clock().toISOString();if(transport===fetch)exec('INSERT OR REPLACE INTO observation_cache VALUES(?,?,?,?)',url,bytes.toString('base64'),receivedAt,new Date(+clock()+ttl).toISOString());return {bytes,receivedAt};
 })();if(transport===fetch)inFlight.set(url,request);try{return await request;}finally{if(transport===fetch)inFlight.delete(url);}
}
export function parseConstituents(bytes:Buffer,indexId:string,receivedAt:string,sampleSize:number):Group{
 const book=XLSX.read(bytes,{type:'buffer',cellFormula:false,cellHTML:false,sheetRows:3000});const rows=XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]],{header:1,raw:false});
 const header=rows[0]?.map(String)||[],col=(s:string)=>header.findIndex(x=>x.includes(s));
 const date=col('日期'),code=col('指数代码'),name=col('指数名称'),stock=col('成份券代码'),stockName=col('成份券名称'),exchange=col('交易所Exchange');if([date,code,name,stock,stockName,exchange].some(i=>i<0))throw Error('中证样本文件字段变化，未继续猜测');
 const records=rows.slice(1).filter(r=>String(r[code]).padStart(6,'0')===indexId);if(!records.length)throw Error('中证样本列表为空或指数代码不符');
 const dates=[...new Set(records.map(r=>String(r[date])))];if(dates.length!==1||!/^\d{8}$/.test(dates[0]))throw Error('分类日期不一致');
 const sourceDate=dates[0].replace(/^(....)(..)(..)$/,'$1-$2-$3'),today=localParts(receivedAt).date;
 if(sourceDate>today||Date.parse(today)-Date.parse(sourceDate)>30*86400000)throw Error('分类版本过期或使用了未来成分');
 const members=records.map(r=>{const market=String(r[exchange]);const symbol=(market==='上海证券交易所'?'sh':market==='深圳证券交易所'?'sz':'')+String(r[stock]).padStart(6,'0');if(!supportedSymbol(symbol)||symbol==='sh000300')throw Error('样本含未接入的证券类型');return {symbol,name:String(r[stockName])};}).sort((a,b)=>a.symbol.localeCompare(b.symbol));
 if(new Set(members.map(m=>m.symbol)).size!==members.length)throw Error('分类中出现重复成分');
 const count=Math.min(sampleSize,members.length),sample=Array.from({length:count},(_,i)=>members[Math.floor(i*(members.length-1)/Math.max(1,count-1))]);
 return {id:indexId,name:String(records[0][name]),kind:'industry',source:`https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/cons/${indexId}cons.xls`,sourceDate,knownAt:receivedAt,mappingVersion:hash(JSON.stringify({members})),fullMembers:members.map(m=>m.symbol),members:sample};
}
export async function collectFrame(config:ObservationConfig,signal:AbortSignal,transport:typeof fetch=fetch,clock=()=>new Date()):Promise<Frame>{
 const issues:string[]=[],specs=selectedGroups(config);
 const groups=(await mapLimited(specs,2,async spec=>{try{const url=`https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/cons/${spec.id}cons.xls`;const r=await get(url,24*3600000,signal,transport,clock);return parseConstituents(r.bytes,spec.id,r.receivedAt,config.scope.sampleSize);}catch(e){issues.push(spec.name+'：成分来源 '+diagnostic(e));return null;}})).filter((x):x is Group=>!!x);
 for(const g of specs)if(!groups.some(x=>x.id===g.id))issues.push(g.name+'：官方成分名单未取得或不满足日期/字段要求');
 const members=[...new Map([...groups.flatMap(g=>g.members),{symbol:config.scope.benchmark,name:'沪深300'}].map(x=>[x.symbol,x])).values()];
 const points:Record<string,DataPoint>={};
 await mapLimited(Array.from({length:Math.ceil(members.length/30)},(_,i)=>members.slice(i*30,i*30+30)),2,async batch=>{
  const url='https://qt.gtimg.cn/q='+batch.map(x=>x.symbol).sort().join(',');let payload:{bytes:Buffer;receivedAt:string}|null=null;
  try{payload=await get(url,30000,signal,transport,clock);}catch(e){issues.push('一批腾讯报价未取得：'+diagnostic(e));}
  await mapLimited(batch,3,async member=>{
   const historyUrl=`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${member.symbol},day,,,65,qfq`;
   const p:DataPoint={...member,kind:member.symbol===config.scope.benchmark?'index':'stock',source:'腾讯财经网页行情；无稳定性/再分发承诺',quoteUrl:url,historyUrl,receivedAt:payload?.receivedAt||clock().toISOString(),historyReceivedAt:null,quotePriceBasis:'unadjusted',quoteAt:null,tradeDate:null,priceBasis:member.symbol===config.scope.benchmark?'none':'qfq',priceUnit:member.symbol===config.scope.benchmark?'index_points':'CNY',volumeUnit:'腾讯日K原始单位（未取得正式单位约定）',volumeComparable:false,finalPrice:false,finalVolume:false,quote:null,bars:[],issues:[]};
   if(payload)try{const q=parseQuote(new TextDecoder('gb18030').decode(payload.bytes),member.symbol,payload.receivedAt);p.name=q.name;p.quoteAt=q.asOf;p.tradeDate=q.asOf.slice(0,10);p.quote={price:q.price,previousClose:q.previousClose,volume:q.volumeRaw,open:q.open};}catch{p.issues.push('报价字段、日期或编码未通过校验');}
   try{const h=await get(historyUrl,6*3600000,signal,transport,clock);const parsed=parseHistory(h.bytes.toString('utf8'),member.symbol,historyUrl,h.receivedAt);p.historyReceivedAt=h.receivedAt;p.priceBasis=parsed.adjustment;p.bars=parsed.bars.map(b=>({date:b.date,close:b.close,volume:b.volumeRaw}));}catch(e){p.issues.push('历史日K不可用：'+diagnostic(e));}
   points[member.symbol]=p;
  });
 });
 if(signal.aborted)throw Error('扫描已取消或超时');
 const observedAt=clock().toISOString(),classificationVersion=hash(JSON.stringify(groups.map(g=>[g.id,g.mappingVersion,g.members.map(m=>m.symbol)])));
 return {id:hash(JSON.stringify({observedAt,groups,points})),provider:'Tencent webpage + CSI official constituents',observedAt,calendarVersion,groups,points,issues,classificationVersion,synthetic:false,coverage:{requestedGroups:specs.length,loadedGroups:groups.length,requestedSymbols:members.length,loadedSymbols:Object.values(points).filter(p=>p.quote&&p.bars.length).length,uncovered:['仅中证800的10个行业分类中的确定性成分抽样，不是全A股扫描','不覆盖北交所、概念主题、ETF份额、行业全成分权重及产业链环节关系','样本等权收益不是行业指数收益；每组按代码排序等距取样，存在抽样偏差','腾讯接口无正式最终收盘标志及已核实成交量单位，正式收盘/量能确认停用','只有当前成分快照，不支持回填本系统采集之前的无偏历史回测','未接入新闻/公告常规扫描，不推断上涨原因或资金身份']}};
}
export function storedFrame(frameId:string){const r=one<{payload:string}>('SELECT payload FROM observation_frames WHERE id=?',frameId);return r?JSON.parse(r.payload) as Frame:null;}
export function recentFrames(){return all<{id:string;observed_at:string}>('SELECT id,observed_at FROM observation_frames ORDER BY observed_at DESC LIMIT 50');}
