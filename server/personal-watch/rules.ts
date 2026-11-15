import {z} from 'zod';
import {tradingDay} from '../observation/calendar';
const security=z.object({symbol:z.string().regex(/^(sh60\d{4}|sh68\d{4}|sz00\d{4}|sz30\d{4})$/),name:z.string().min(2).max(12)});
const price=z.number().finite().positive();
export const rulesSchema=z.object({
 stock:security,peers:z.tuple([security,security]),floor:price,zoneTop:price,repairLow:price,cap:price,
 stop:price,trimLow:price,trimHigh:price,target:price,timeLevel:price,percent:price.max(100)
}).refine(r=>new Set([r.stock,...r.peers].map(s=>s.symbol)).size===3&&r.floor<=r.zoneTop&&r.zoneTop<=r.repairLow&&r.repairLow<=r.cap&&r.stop<r.floor&&r.trimLow<=r.trimHigh&&r.cap<r.trimLow&&r.trimHigh<r.target,'价格顺序或证券重复');
export type Rules=z.infer<typeof rulesSchema>;
export type Minute={end:number;open:number;close:number;high:number;low:number;lots:number;amount:number};
export type Frame={bars:Minute[];price:number;prev:number;low:number;at:string};
export type Verdict={state:'invalid'|'waiting'|'unknown'|'entry';reason:string;needsPeers?:boolean};
export function entryVerdict(r:Rules,f:Frame,peers:Frame[],minute:number):Verdict{
 const result=(state:Verdict['state'],reason:string)=>({state,reason});
 if(f.low<r.floor||f.bars.some(b=>b.low<r.floor))return result('invalid','买入前曾跌破计划下限，当天失效');
 let touched=false;
 for(const b of f.bars){
  if(touched)break;
  const traded=[b.open,b.close,b.high,b.low].some(v=>v>=r.floor&&v<=r.zoneTop);
  if(b.open>r.cap||b.high>r.cap&&!traded)return result('invalid','回落到计划区前已经越过限价');
  if(b.high>r.cap&&b.open>r.zoneTop)return result('unknown','同一分钟内回落与上破的顺序不明');
  touched=traded&&b.lots>0;
 }
 if(!touched||minute<870)return result('waiting','等待回落检验和尾盘观察时段');
 if(f.price<r.repairLow||f.price>r.cap)return result('waiting','最新价不在修复区间');
 const end=Math.floor(minute/15)*15;
 const window=(frame:Frame,n:number)=>frame.bars.filter(b=>b.end>n-15&&b.end<=n);
 const lows=(bars:Minute[])=>Math.min(...bars.map(b=>b.low));
 const a=window(f,end-15),b=window(f,end);
 const above=(bars:Minute[],n:number)=>{
  const day=f.bars.filter(x=>x.end<=n);
  const shares=day.reduce((s,x)=>s+x.lots*100,0),amount=day.reduce((s,x)=>s+x.amount,0);
  return shares>0&&bars.at(-1)!.close>amount/shares;
 };
 if(a.length!==15||b.length!==15)return result('unknown','缺少两根完整的15分钟线');
 if(lows(b)<=lows(a)||!above(a,end-15)||!above(b,end))return result('waiting','低点抬高或两次收盘高于当时均价尚未同时满足');
 const stable=(p:Frame)=>{
  const recent=window(p,end),prior=p.bars.filter(x=>x.end<=end-15),since=p.bars.filter(x=>x.end>end-15);
  return recent.length===15&&prior.length>0&&Math.min(lows(since),p.price,p.low)>=lows(prior);
 };
 if(peers.length!==2)return {...result('unknown','同题材行情不完整'),needsPeers:true};
 if(!peers.some((p,i)=>p.price>p.prev&&stable(peers[1-i])))return result('waiting','同题材翻红与停止创新低尚未同时满足');
 return result('entry','回落检验、尾盘修复与同题材配合均已满足');
}
export function thirdSession(buy:string){
 let t=Date.parse(buy+'T00:00:00Z'),n=0;
 while(n<3){t+=86400000;const date=new Date(t).toISOString().slice(0,10),day=tradingDay(date);if(day===null)return null;if(day&&++n===3)return date;}
 return null;
}
export function canSell(buy:string,date:string){return date>buy&&tradingDay(date)===true;}
export function lotsAllowed(capital:number,r:Rules){return Math.floor(capital*r.percent/100/(r.cap*100))*100;}
