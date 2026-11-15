import {z} from 'zod';
import {db,one,all,exec,id,now,transaction} from '../db';
import {permitted,requireScope,type Scope} from '../feishu/unified-store';
import type {ModelCall} from '../model';
import {localParts,tradingDay,marketPhase} from '../observation/calendar';
import {rulesSchema,entryVerdict,thirdSession,lotsAllowed,canSell,type Rules} from './rules';
import {frame,historicalClose} from './feed';

db.exec(`CREATE TABLE IF NOT EXISTS personal_watches(
 id TEXT PRIMARY KEY,owner TEXT NOT NULL,scope TEXT NOT NULL,original TEXT NOT NULL,rules TEXT NOT NULL,
 state TEXT NOT NULL,until_day TEXT,capital REAL,buy_day TEXT,basis REAL,shares INTEGER,reduced INTEGER DEFAULT 0,
 last_slot TEXT,last_result TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS personal_watch_log(watch TEXT NOT NULL REFERENCES personal_watches(id) ON DELETE CASCADE,
 at TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS personal_watch_events(watch TEXT NOT NULL REFERENCES personal_watches(id) ON DELETE CASCADE,
 key TEXT NOT NULL,receipt TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(watch,key));`);
type Plan={id:string;scope:string;rules:string;state:string;until_day:string;capital:number|null;buy_day:string;basis:number;shares:number;reduced:number;last_slot:string;last_result:string};
const owner=(s:Scope)=>JSON.stringify([s.app,s.tenant,s.sender,s.chat,s.generation]);
const log=(key:string,kind:string,detail:string)=>exec('INSERT INTO personal_watch_log VALUES(?,?,?,?)',key,now(),kind,detail);
export function draft(s:Scope,original:string,rules:Rules){
 requireScope(s,true);const r=rulesSchema.parse(rules);
 const old=one<Plan>('SELECT * FROM personal_watches WHERE owner=? AND original=? ORDER BY created_at DESC LIMIT 1',owner(s),original);
 if(old)return old.id;
 const key='P-'+id().slice(0,8);
 exec('INSERT INTO personal_watches(id,owner,scope,original,rules,state,created_at) VALUES(?,?,?,?,?,?,?)',key,owner(s),JSON.stringify(s),original,JSON.stringify(r),'draft',now());return key;
}
function card(p:Plan){
 const r=rulesSchema.parse(JSON.parse(p.rules));
 const receipt=one<{status:string;detail:string}>('SELECT status,detail FROM personal_watch_events WHERE watch=? ORDER BY rowid DESC LIMIT 1',p.id);
 const state:Record<string,string>={draft:'草稿',active:'观察入场',holding:'跟踪已成交持仓',paused:'已暂停',ended:'已结束',expired:'入场期限已过'};
 return [r.stock.name+' · '+p.id+' · '+state[p.state],
 '先回落 '+r.floor+'–'+r.zoneTop+'；触区前超过 '+r.cap+' 或跌破 '+r.floor+' 当天作废。',
 '14:30 后检查最近两根已收完15分钟线：低点抬高，各自收盘高于当时日均价，现价 '+r.repairLow+'–'+r.cap+'。',
 [r.stock,...r.peers].map(s=>s.name+' '+s.symbol).join(' / '),
 '两只参照股至少一只高于昨收，另一只自最近一根完整15分钟线开始以来没有刷新此前日低。',
 '首笔限价 '+r.cap+'，账户资金最多 '+r.percent+'%，不足100股跳过，只买一次。'+(p.capital?'最多 '+lotsAllowed(p.capital,r)+' 股。':'账户资金未填，数量须自行核对。'),
 '失效 '+r.stop+'；'+r.trimLow+'–'+r.trimHigh+' 先减半，确认减仓后回到成本或达到 '+r.target+' 提醒退出。亏损不加仓、不下移失效线。',
 '买入次日起算第3个交易日收盘 ≤ '+r.timeLevel+'，下一可卖时段提醒退出。仅提醒，成交由本人登记。',
 p.buy_day&&('已登记 '+p.buy_day+' 买入，均价 '+p.basis+'，剩余 '+p.shares+' 股。'),
 p.until_day&&'入场截止 '+p.until_day,
 p.last_result&&'上次检查：'+p.last_result,receipt&&'最近提醒：'+receipt.status,
 p.state==='draft'?'认可以上口径后发送「启用 '+p.id+' 至 YYYY-MM-DD」，可追加「账户资金 金额」。':'回复「策略状态 '+p.id+'」查看；可发送「暂停 '+p.id+'」。'].filter(Boolean).join('\n');
}
export async function watchCommand(s:Scope,text:string,call:ModelCall):Promise<string|null>{
 const command=text.match(/^(删除策略|策略原文|策略状态|查看策略|启用|暂停|已买|已减仓|已清仓)\s+(P-[0-9a-f]{8})(?:\s+(.*))?$/i);
 const list=/^(我的策略|策略监控|我的策略监控|查看策略草稿)$/.test(text);
 const create=/^(创建|新建|按.{0,6}计划.{0,4}盯|帮我.{0,4}(创建|监控|盯))/.test(text)&&/策略|计划|监控/.test(text);
 if(!command&&!list&&!create)return null;
 requireScope(s,true);
 if(list){const rows=all<Plan>("SELECT * FROM personal_watches WHERE owner=? ORDER BY created_at DESC",owner(s));return rows.map(card).join('\n\n')||'尚无策略。发送「创建策略监控」并附自己的条件。';}
 if(!command){
  const schema=z.object({rules:rulesSchema.nullable(),gap:z.string().max(500)});
  const decoded=schema.parse(await call('把本人命令中的策略转为可核对的草稿JSON。仅支持：主股回落区、突破取消、14:30后两根15分钟低点抬高且均高于各自日VWAP、两只同题材至少一红且另一只止跌、5%等资金上限和一次买入、固定失效线、区间减半、余仓目标和保本、买入后第三交易日收盘门槛。不得忽略其他条件或猜缺失数值。证券名称代码必须明确或给出待确认建议。返回 {rules:{stock:{name,symbol},peers:[同结构两项],floor,zoneTop,repairLow,cap,stop,trimLow,trimHigh,target,timeLevel,percent},gap:""}；不适配或不能确定时 rules:null 并用gap说明。',text,schema));
  requireScope(s,true);if(!decoded.rules||decoded.gap.trim())return '尚未建成可执行策略。'+decoded.gap;
  const key=draft(s,text,decoded.rules);return card(one<Plan>('SELECT * FROM personal_watches WHERE id=?',key)!);
 }
 const [,op,key,tail='']=command,p=one<Plan>('SELECT * FROM personal_watches WHERE id=? AND owner=?',key,owner(s));if(!p)return '未找到本人的这个策略编号。';
 const r=rulesSchema.parse(JSON.parse(p.rules)),today=localParts(now()).date;
 if(op==='策略状态'||op==='查看策略')return card(p);
 if(op==='策略原文')return one<{original:string}>('SELECT original FROM personal_watches WHERE id=?',key)!.original;
 if(op==='删除策略'){
  if(tail!=='确认')return '删除计划与它的本地检查和提醒记录，请发送「删除策略 '+key+' 确认」。';
  exec('DELETE FROM personal_watches WHERE id=?',key);return '已删除策略和派生的监控记录。';
 }
 return transaction(()=>{
  if(op==='启用'){
   const args=/^至\s*(\d{4}-\d\d-\d\d)(?:\s+账户资金\s*(\d+(?:\.\d{1,2})?))?$/.exec(tail);
   if(!args||tradingDay(args[1])!==true||args[1]<today||!['draft','paused'].includes(p.state)||args[2]&&!(Number(args[2])>0&&Number.isFinite(+args[2])))return '请核对策略状态并指定有效的入场截止交易日。';
   exec('UPDATE personal_watches SET state=?,until_day=?,capital=COALESCE(?,capital),last_slot=NULL WHERE id=?',p.buy_day?'holding':'active',args[1],args[2]?Number(args[2]):null,key);
  }else if(op==='暂停'){if(!['active','holding'].includes(p.state))return '当前策略未运行。';exec("UPDATE personal_watches SET state='paused' WHERE id=?",key);}
  else if(op==='已买'){
   const m=/^(\d{4}-\d\d-\d\d)\s+(\d+(?:\.\d+)?)元?\s+(\d+)股?$/.exec(tail);
   if(!m||p.buy_day||!['active','expired'].includes(p.state)||tradingDay(m[1])!==true||m[1]>today||m[1]>p.until_day||!(+m[2]>0&&+m[3]>=1&&Number.isSafeInteger(+m[3])))return '请登记真实成交，例如「已买 '+key+' YYYY-MM-DD 均价 股数」；只接受一笔。';
   exec("UPDATE personal_watches SET state='holding',buy_day=?,basis=?,shares=?,last_slot=NULL WHERE id=?",m[1],+m[2],+m[3],key);
  }else if(op==='已减仓'){
   const m=/^(\d+)股?$/.exec(tail);if(!m||p.state!=='holding'||p.reduced||+m[1]<=0||+m[1]>=p.shares)return '请输入实际减仓股数，须小于剩余持仓。';
   exec('UPDATE personal_watches SET shares=shares-?,reduced=1 WHERE id=?',+m[1],key);
  }else if(op==='已清仓'){if(!p.buy_day||p.state==='ended')return '没有待结束的已登记持仓。';exec("UPDATE personal_watches SET state='ended',shares=0 WHERE id=?",key);}
  log(key,op,text);return card(one<Plan>('SELECT * FROM personal_watches WHERE id=?',key)!);
 });
}
type WatchInputs={frame:typeof frame;close:typeof historicalClose;clock:()=>Date};
const liveInputs:WatchInputs={frame,close:historicalClose,clock:()=>new Date()};
type Send=(chat:string,text:string,uuid:string)=>Promise<{code:number;messageId?:string}>;
async function check(p:Plan,r:Rules,date:string,minute:number,inputs:WatchInputs){
 const stock=await inputs.frame(r.stock,date,minute);
 if(p.state==='holding'){
  const last=thirdSession(p.buy_day);
  const sellable=canSell(p.buy_day,date);
  let key='',reason='';
  if(stock.price<=r.stop){key='stop';reason='触及计划失效线';}
  else if(p.reduced&&(stock.price<=p.basis||stock.price>=r.target)){key='exit';reason='剩余仓位达到保本或目标退出条件';}
  else if(last&&date>last&&await inputs.close(r.stock,last)<=r.timeLevel){key='time';reason='第3个交易日收盘未站上计划门槛';}
  else if(!p.reduced&&stock.price>=r.trimLow&&stock.price<=r.trimHigh){key='trim';reason='现价进入首笔减仓区间';}
  return {key:key&&(sellable?key:key+'-locked'),reason:(reason||'暂未触及持仓提醒')+'；现价 '+stock.price+(sellable?'':'，买入当日，下一可卖时段再核对'),at:stock.at};
 }
 const invalid=one('SELECT 1 FROM personal_watch_events WHERE watch=? AND key=?',p.id,'invalid:'+date);
 if(invalid)return {key:'',reason:'当日入场已失效',at:stock.at};
 const end=localParts(stock.at).minute;
 const preliminary=entryVerdict(r,stock,[],minute);
 const peers=preliminary.needsPeers?await Promise.all(r.peers.map(x=>inputs.frame(x,date,minute))):[];
 if(peers.some(x=>Math.abs(Date.parse(x.at)-Date.parse(stock.at))>60000))throw Error('三只证券报价未对齐');
 const decision=preliminary.needsPeers?entryVerdict(r,stock,peers,Math.min(minute,end)):preliminary;
 let reason=decision.reason;
 let key=decision.state==='invalid'?'invalid:'+date:decision.state==='entry'?'entry:'+date:'';
 if(decision.state==='entry'){
  if(p.capital!==null&&lotsAllowed(p.capital,r)<100){key='';reason='条件齐备，资金上限不足100股，按计划跳过';}
  else reason+='；首笔最多 '+r.percent+'%，限价 '+r.cap+'，只买一次。'+(p.capital===null?'请自行核对至少100股的资金。':'最多 '+lotsAllowed(p.capital,r)+' 股。');
 }
 const evidence={stock:{at:stock.at,price:stock.price,dayLow:stock.low},minutes:stock.bars.length,
   peers:peers.map(x=>({at:x.at,price:x.price,previousClose:x.prev,dayLow:x.low})),
   bars:[-15,0].map(offset=>{const end=Math.floor(minute/15)*15+offset;
    const window=stock.bars.filter(b=>b.end>end-15&&b.end<=end),day=stock.bars.filter(b=>b.end<=end);
    return {end,low:window.length?Math.min(...window.map(x=>x.low)):null,close:window.at(-1)?.close,
     vwap:day.reduce((s,b)=>s+b.amount,0)/day.reduce((s,b)=>s+b.lots*100,0)};})};
 return {key,reason,at:stock.at,evidence};
}
export async function tickPersonalWatches(send:Send,inputs=liveInputs){
 const time=inputs.clock(),{date,minute}=localParts(time);
 const plans=all<Plan>("SELECT * FROM personal_watches WHERE state IN ('active','holding')");
 for(const p of plans){
  const s:Scope=JSON.parse(p.scope);if(!permitted(s,true))continue;
  if(p.state==='active'&&date>p.until_day){exec("UPDATE personal_watches SET state='expired' WHERE id=?",p.id);continue;}
  if(marketPhase(time)!=='intraday'||[570,780].includes(minute)||time.getSeconds()<5)continue;
  const slot=date+' '+minute;
  const retry=p.last_slot===slot&&p.last_result?.includes('待核验：')&&time.getSeconds()>=35;
  if((p.last_slot===slot&&!retry)||p.last_slot===slot+' retry')continue;
  exec('UPDATE personal_watches SET last_slot=? WHERE id=?',retry?slot+' retry':slot,p.id);
  const r=rulesSchema.parse(JSON.parse(p.rules));
  try{
   // At the start of a minute the supplier may still be publishing the last bar.
   const outcome=await check(p,r,date,minute,inputs);
   const current=one<Plan>('SELECT * FROM personal_watches WHERE id=?',p.id);
   if(!current||current.state!==p.state||current.reduced!==p.reduced||!permitted(s,true)||marketPhase(inputs.clock())!=='intraday'||+inputs.clock()-Date.parse(outcome.at)>90000)continue;
   const detail=outcome.at+' '+outcome.reason;
   exec('UPDATE personal_watches SET last_result=? WHERE id=?',detail,p.id);
   if(!outcome.key||one('SELECT 1 FROM personal_watch_events WHERE watch=? AND key=?',p.id,outcome.key))continue;
   const uuid=id();exec('INSERT INTO personal_watch_events VALUES(?,?,?,?,?)',p.id,outcome.key,uuid,'未确认',JSON.stringify(outcome));
   const sent=await send(s.chat,r.stock.name+' · '+p.id+'\n'+detail+'\n行情：腾讯报价 / 东方财富不复权分钟线。',uuid);
   exec('UPDATE personal_watch_events SET status=? WHERE receipt=?',sent.code===0&&sent.messageId?'已送达平台':'发送失败',uuid);
  }catch(e){exec('UPDATE personal_watches SET last_result=? WHERE id=?',now()+' 待核验：'+(e instanceof Error?e.message:'数据或发送暂不可用'),p.id);}
 }
}
