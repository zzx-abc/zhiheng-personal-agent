import {localParts,marketPhase,previousSessions,tradingDay} from './calendar';
import type {Frame,DataPoint} from './types';
export type EvaluationMode={mode:'intraday'|'after_close'|'replay';basisMode:'intraday'|'after_close'|'unavailable';asOf:string;targetDate:string|null;lastAvailableDate:string|null;historyEnd:string|null;formalHistory:boolean;notice:string};
export function available(at:string|null|undefined,asOf:string){return !!at&&Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.parse(asOf);}
export function formalDaily(p:DataPoint|undefined,target:string|null,asOf:string){return !!target&&!!p&&p.finalPrice&&p.tradeDate===target&&available(p.historyReceivedAt,asOf)&&Date.parse(p.historyReceivedAt!)>=Date.parse(target+'T15:00:00+08:00')&&available(p.receivedAt,asOf)&&available(p.quoteAt,asOf)&&localParts(p.quoteAt!).date===target&&Date.parse(p.quoteAt!)>=Date.parse(target+'T15:00:00+08:00')&&!!p.bars.find(b=>b.date===target&&Number.isFinite(b.close)&&b.close>0);}
export function evaluationMode(f:Frame,replay=false):EvaluationMode{
 const at=f.observedAt,{date}=localParts(at),phase=marketPhase(at),basisMode=phase==='unknown'?'unavailable':phase==='intraday'?'intraday':'after_close';
 const target=phase==='unknown'?null:tradingDay(date)&&['intraday','after_close'].includes(phase)?date:previousSessions(date,1)[0]||null;
 // A common window is chosen by the market benchmark. Each stock is checked independently.
 const formalHistory=basisMode==='after_close'&&formalDaily(f.points.sh000300,target,at);
 const historyEnd=target?(formalHistory?target:previousSessions(target,1)[0]||null):null;
 const dates=Object.values(f.points).filter(p=>available(p.historyReceivedAt,at)).flatMap(p=>p.bars.filter(b=>target&&b.date<=target).map(b=>b.date)).sort();
 return {mode:replay?'replay':basisMode==='intraday'?'intraday':'after_close',basisMode,asOf:at,targetDate:target,lastAvailableDate:dates.at(-1)||null,historyEnd,formalHistory,notice:replay?'历史回放，仅使用当时已取得的证据，不发送当前提醒':basisMode==='unavailable'?'交易日历未覆盖，暂停时点判定':formalHistory?'目标交易日正式日线；个股仍独立核验':'供应商快照与可用历史分列；未把更新时间当作正式收盘'};
}
export function historyDates(m:EvaluationMode,n:number){return m.historyEnd?[...previousSessions(m.historyEnd,n-1),m.historyEnd]:[];}
