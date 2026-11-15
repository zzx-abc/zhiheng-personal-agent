import {fetchMarketData} from '../market-data';
import {localParts} from '../observation/calendar';
import type {Frame,Minute,Rules} from './rules';
type Stock=Rules['stock'];
async function history(stock:Stock,date:string,interval:1|101){
 const end=date.replaceAll('-',''),secid=(stock.symbol.startsWith('sh')?'1.':'0.')+stock.symbol.slice(2);
 const url='https://push2his.eastmoney.com/api/qt/stock/kline/get?'+new URLSearchParams({secid,klt:String(interval),fqt:'0',beg:end,end,lmt:'250',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57'});
 const response=await fetch(url,{signal:AbortSignal.timeout(9000),redirect:'error'});
 if(!response.ok)throw Error('分钟或日线服务不可用');
 const d=(await response.json()).data;
 if(d?.code!==stock.symbol.slice(2)||d.name!==stock.name||!Array.isArray(d.klines))throw Error('证券名称、代码或行情数据待核验');
 return d.klines as string[];
}
export function minutes(rows:string[],date:string,end:number):Minute[]{
 const result:Minute[]=[];
 for(const row of rows){
  const [stamp,...values]=row.split(',');
  if(!stamp.startsWith(date+' '))continue;
  const m=/^\d{4}-\d\d-\d\d (\d\d):(\d\d)$/.exec(stamp);
  if(!m)throw Error('分钟时间格式异常');
  const minute=+m[1]*60 + +m[2];
  if(minute>end)continue;
  if(values.length<6||values.slice(0,6).some(x=>!x.trim()||!Number.isFinite(+x)))throw Error('分钟字段不全');
  const [open,close,high,low,lots,amount]=values.map(Number);
  const expected=result.at(-1)?.end??570,next=expected===690?781:expected+1;
  if(minute!==next||low<=0||low>Math.min(open,close)||high<Math.max(open,close)||lots<0||amount<0||(amount===0)!==(lots===0))throw Error('分钟序列或价格字段异常');
  result.push({end:minute,open,close,high,low,lots,amount});
 }
 if(!result.length||result.at(-1)!.end!==end)throw Error('缺少开盘以来的完整分钟行情');
 const shares=result.reduce((s,b)=>s+b.lots*100,0),avg=result.reduce((s,b)=>s+b.amount,0)/shares;
 if(!Number.isFinite(avg)||avg<Math.min(...result.map(b=>b.low))||avg>Math.max(...result.map(b=>b.high)))throw Error('成交额与成交量单位无法交叉核验');
 return result;
}
export async function frame(stock:Stock,date:string,end:number):Promise<Frame>{
 const [rows,market]=await Promise.all([history(stock,date,1),fetchMarketData({instruments:[{...stock,role:'subject'}],observation:'quote',sessions:5},AbortSignal.timeout(9000))]);
 const q=market.data.instruments[0]?.quote,age=q?Date.now()-Date.parse(q.asOf):Infinity;
 if(!q||q.name!==stock.name||!q.previousClose||!q.low||q.asOf.slice(0,10)!==date||age<0||age>65000||localParts(q.asOf).minute<end)throw Error('腾讯报价过期或对象未核实');
 return {bars:minutes(rows,date,end),price:q.price,prev:q.previousClose,low:q.low,at:q.asOf};
}
export async function historicalClose(stock:Stock,date:string){
 const rows=await history(stock,date,101),row=rows.find(x=>x.split(',')[0]===date)?.split(',');
 if(!row||!(+row[2]>0&&+row[3]>=+row[2]&&+row[4]<=+row[2]&&+row[4]>0))throw Error('目标交易日收盘价不可用');
 return +row[2];
}
