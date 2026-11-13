// Official exchange closure schedule; unknown years fail closed, never guess weekdays are sessions.
export const calendarVersion='SSE-SZSE-2026/2025-12-22';
export const calendarSources=['https://www.sse.com.cn/disclosure/dealinstruc/closed/','https://www.szse.cn/disclosure/notice/t20251222_618087.html'];
const closures=[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']];
export function localParts(at:string|Date){const d=new Date(at);if(!Number.isFinite(+d))throw Error('时间无效');const x=new Date(+d+8*3600000);return {date:x.toISOString().slice(0,10),minute:x.getUTCHours()*60+x.getUTCMinutes()};}
export function tradingDay(date:string):boolean|null{if(!/^2026-\d{2}-\d{2}$/.test(date))return null;const d=new Date(date+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==date)return null;return ![0,6].includes(d.getUTCDay())&&!closures.some(([a,b])=>date.slice(5)>=a&&date.slice(5)<=b);}
export function marketPhase(at:string|Date){const {date,minute}=localParts(at),day=tradingDay(date);if(day===null)return 'unknown';if(!day)return 'holiday';if((minute>=570&&minute<690)||(minute>=780&&minute<900))return 'intraday';return minute>=900?'after_close':'closed';}
export function previousSessions(date:string,count:number){const out:string[]=[];let d=Date.parse(date+'T00:00:00Z');for(let i=0;i<160&&out.length<count;i++){d-=86400000;const x=new Date(d).toISOString().slice(0,10),open=tradingDay(x);if(open===null)break;if(open)out.unshift(x);}return out;}
export function nextObservation(at:string,minutes:number){const base=+new Date(at);for(let i=minutes;i<9*24*60;i+=1){const d=new Date(base+i*60000),p=localParts(d);if(tradingDay(p.date)===null)return null;if(tradingDay(p.date)&&((p.minute>=580&&p.minute<=680)||(p.minute>=790&&p.minute<=890)))return d.toISOString();}return null;}
export function missedTradingMinutes(from:string,to:string){let total=0;const end=+new Date(to),start=Math.max(+new Date(from),end-8*86400000);for(let at=start;at<end;at+=60000)if(marketPhase(new Date(at))==='intraday')total++;return total;}

/** Fixed exchange-session slots. No catch-up bursts after sleep or lunch. */
export function nextThemeObservation(at:string,minutes:number){
 const start=new Date(at);for(let i=0;i<10;i++){const day=localParts(new Date(+start+i*86400000)).date;if(tradingDay(day)===null)return null;if(!tradingDay(day))continue;
  for(const opening of [570,780])for(let m=opening;m<opening+120;m+=minutes){const slot=new Date(day+'T00:00:00+08:00');slot.setTime(+slot+m*60000);if(+slot>+start)return slot.toISOString();}
 }return null;
}
