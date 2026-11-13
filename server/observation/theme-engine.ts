import {createHash} from 'node:crypto';
import {localParts,marketPhase,previousSessions,tradingDay} from './calendar';
import type {Frame,DataPoint,ObservationConfig} from './types';
import type {Theme,ThemeMember,StockView,ThemeView,ThemeReport,ThemeState,ThemeEvent,Condition} from './theme-types';
import {combine,type Atom} from './conditions';
import {evaluationMode,historyDates,formalDaily,available} from './mode';
import {buildDecisions,summaryText} from './strategy';
const round=(x:number)=>Math.round(x*10000)/10000;
const mean=(xs:(number|null)[])=>xs.length&&xs.every(x=>x!==null)?round((xs as number[]).reduce((a,b)=>a+b,0)/xs.length):null;
const number=(x:number|null,unit='')=>x===null?'未取得':`${x.toFixed(2)}${unit}`;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function usableHistory(p:DataPoint|undefined){return !!p&&p.bars.length>0&&(p.kind==='index'?p.priceUnit==='index_points':p.priceUnit==='CNY')&&(p.priceBasis==='qfq'||p.kind==='index'&&p.priceBasis==='none')&&p.bars.every((b,i)=>Number.isFinite(b.close)&&b.close>0&&(i===0||p.bars[i-1].date<b.date));}
function windowReturn(p:DataPoint|undefined,dates:string[],n:number){if(!usableHistory(p)||dates.length<n+1)return null;const wanted=dates.slice(-(n+1)),bars=wanted.map(d=>p!.bars.find(b=>b.date===d));if(bars.some(b=>!b))return null;return round((bars.at(-1)!.close/bars[0]!.close-1)*100);}
function difference(a:number|null,b:number|null){return a===null||b===null?null:round(a-b);}
export function quoteUsable(p:DataPoint|undefined,frame:Frame){if(!p?.quote||!p.quoteAt||!Number.isFinite(p.quote.price)||p.quote.price<=0||!p.quote.open||p.quote.open<=0||p.quote.volume!==null&&p.quote.volume<=0)return false;const {date}=localParts(frame.observedAt),age=Date.parse(frame.observedAt)-Date.parse(p.quoteAt);return p.tradeDate===date&&Number.isFinite(age)&&age>=-60000&&age<=600000&&tradingDay(date)===true&&marketPhase(frame.observedAt)==='intraday'&&available(p.receivedAt,frame.observedAt);}
function dayReturn(p:DataPoint|undefined,f:Frame){return quoteUsable(p,f)&&p!.quote!.previousClose&&p!.quote!.previousClose!>0?round((p!.quote!.price/p!.quote!.previousClose!-1)*100):null;}
function aligned(a:DataPoint|undefined,b:DataPoint|undefined){return !!a?.quoteAt&&!!b?.quoteAt&&Math.abs(Date.parse(a.quoteAt)-Date.parse(b.quoteAt))<=300000;}
export function stockView(member:ThemeMember,t:Theme,f:Frame):StockView{
 const p=f.points[member.symbol],benchmark=f.points.sh000300,m=evaluationMode(f),target=m.targetDate,dates=historyDates(m,Math.max(26,t.rules.highDays+1)),themeBase=t.benchmarks.find(b=>b.role==='theme'&&b.symbol),sector=themeBase?.symbol?f.points[themeBase.symbol]:undefined;
 const history=(x:DataPoint|undefined,n:number)=>available(x?.historyReceivedAt,f.observedAt)&&(!m.formalHistory||formalDaily(x,target,f.observedAt))?windowReturn(x,dates,n):null;
 const ret3=history(p,3),ret5=history(p,5),relative3=difference(ret3,history(benchmark,3)),relative5=difference(ret5,history(benchmark,5));
 const final=m.basisMode==='after_close'&&formalDaily(p,target,f.observedAt)&&!!p?.quote&&Number.isFinite(p.quote.price)&&p.quote.price>0&&p.priceUnit==='CNY';
 const fresh=m.basisMode==='intraday'?quoteUsable(p,f):final,price=p?.quote?.price??null;
 const intraday=m.basisMode==='intraday'?dayReturn(p,f):null,intradayRelative=m.basisMode==='intraday'&&aligned(p,benchmark)?difference(intraday,dayReturn(benchmark,f)):null;
 const phase=final?'正式收盘确认':m.basisMode==='intraday'?'盘中初步观察':'盘后复盘，正式收盘待核验';
 const missing:string[]=[];
 if(!p?.quote)missing.push('当前价格缺失，证券仍保留在观察池');else if(!fresh)missing.push(m.basisMode==='intraday'?'当前报价延迟/交易日期/开盘价未通过核验':'目标交易日正式收盘价未核验，供应商快照仍可查看');
 if(relative3===null||relative5===null)missing.push('个股或沪深300完整历史区间/价格口径/取得时点未通过核验');
 if(m.basisMode==='intraday'&&intradayRelative===null)missing.push('盘中与沪深300行情时间或昨收未对齐');
 if(!member.verified||member.role==='pending')missing.push('业务关联待核验，不计正式广度或事件');
 const ref=(operand:string,historical=false)=>[...([p,benchmark].filter(Boolean) as DataPoint[]).map(x=>({source:historical?x.historyUrl:x.quoteUrl,availableAt:historical?x.historyReceivedAt:x.receivedAt,frameId:f.id,operand}))];
 const atom=(id:string,label:string,actual:number|null,threshold:number|null,unit:string,reason:string,pass=(a:number,b:number)=>a>=b,historical=false):Atom=>({id,label,status:actual===null||threshold===null?'UNKNOWN':pass(actual,threshold)?'PASS':'FAIL',actual,threshold,unit,window:{start:historical?dates.at(id==='relative5'?-6:-4)||null:target,end:historical?m.historyEnd:target},quality:actual===null||threshold===null?'missing':'valid',reasons:actual===null||threshold===null?[reason]:[],evidence:ref(label,historical)});
 const historyReason=(n:number)=>{const errors:string[]=[];for(const [name,x] of [['个股',p],['沪深300',benchmark]] as const){if(!x){errors.push(name+'资料缺失');continue;}if(!usableHistory(x))errors.push(name+'价格单位/复权口径/日线数值或排序无效');if(!available(x.historyReceivedAt,f.observedAt))errors.push(name+'历史取得时间缺失或晚于判断时点');const missingDates=dates.slice(-(n+1)).filter(d=>!x.bars.some(b=>b.date===d));if(missingDates.length)errors.push(name+'缺日线：'+missingDates.join('、'));if(m.formalHistory&&!formalDaily(x,target,f.observedAt))errors.push(name+'目标日正式日线未核验');}return errors.join('；')||'交易日历或完整区间不足';};
 const r3=atom('relative3','3日相对沪深300',relative3,t.rules.relative3,'个百分点',historyReason(3),undefined,true),r5=atom('relative5','5日相对沪深300',relative5,t.rules.relative5,'个百分点',historyReason(5),undefined,true);
 const current=atom('current','盘中相对沪深300',intradayRelative,0,'个百分点','盘中报价时点或基准/昨收无效');
 if(m.basisMode!=='intraday'){current.status='NOT_APPLICABLE';current.quality='not_applicable';current.reasons=['盘后规则不使用当前盘中相对强度'];}
 const confirmation=atom('confirmation',m.basisMode==='intraday'?'当前价格有效性':'目标日正式收盘证据',fresh?1:null,1,'布尔',m.basisMode==='intraday'?'当前价格、交易日期、延迟或开盘信息无效':'缺目标日正式收盘标志、对应日线或当时可用性证据');
 let volumeRatio:number|null=null;
 const priorDates=target?previousSessions(target,20):[],prior20=priorDates.map(d=>p?.bars.find(b=>b.date===d)),today=p?.bars.find(b=>b.date===target);
 if(final&&p?.finalVolume&&p.volumeComparable&&today&&Number.isFinite(today.volume)&&today.volume>=0&&prior20.length===20&&prior20.every(b=>b&&Number.isFinite(b.volume)&&b.volume>=0)){const avg=mean(prior20.map(b=>b!.volume));if(avg&&avg>0)volumeRatio=round(today.volume/avg);}
 const volume=atom('volume','量能确认',volumeRatio,t.rules.volumeRatio,'倍',m.basisMode==='intraday'?'缺可比同时间累计分钟量':'缺正式全天量或历史同口径成交量');
 if(volumeRatio===null)missing.push('量能未验证：'+volume.reasons.join('；')+(t.rules.requireVolume?'（必需）':'（辅助，不参与当前筛选）'));
 const make=(id:string,label:string,atoms:Atom[],required:Atom[],actual:number|null,threshold:number|null,basis:string,direction:'up'|'down'):Condition=>{const combination=combine('AND',required);return {id,label,atoms,combination,status:combination.status,met:combination.status==='PASS'?true:combination.status==='FAIL'?false:null,actual,threshold,basis,direction};};
 const relative=make('relative','相对增强筛选',[r3,r5,current,confirmation,volume],[r3,r5,confirmation,...(m.basisMode==='intraday'?[current]:[]),...(t.rules.requireVolume?[volume]:[])],relative3,t.rules.relative3,`3/5日分别≥${t.rules.relative3}/${t.rules.relative5}个百分点；${m.basisMode==='intraday'?'盘中相对≥0且当前报价有效':'盘后使用正式日线及目标日收盘确认'}；量能${t.rules.requireVolume?'必需':'辅助'}`,'up');
 const conditions:Condition[]=[relative];
 if(!t.rules.enabled.includes('relative')){relative.status='DISABLED';relative.met=null;relative.disabledReason='配置关闭相对增强筛选';}
 const highDates=target?previousSessions(target,t.rules.highDays):[],highs=highDates.map(d=>p?.bars.find(b=>b.date===d)),last=p?.bars.find(b=>b.date===highDates.at(-1));
 const highBase=usableHistory(p)&&available(p?.historyReceivedAt,f.observedAt)&&highs.length===t.rules.highDays&&highs.every(b=>b&&typeof b.high==='number'&&Number.isFinite(b.high)&&b.high>=b.close)&&last&&p?.quote?.previousClose&&p.tradeDate===target?Math.max(...highs.map(b=>b!.high!))/last.close*p.quote.previousClose:null;
 const highAtom=atom('highPrice',`价格超过此前${t.rules.highDays}日最高价`,fresh?price:null,highBase===null?null:round(highBase),'元',[...(!fresh?['缺有效当前/正式收盘价']:[]),...(highBase===null?['缺完整历史最高价或同交易日可比昨收']:[])].join('；'),(a,b)=>a>b);
 highAtom.window={start:highDates[0]||null,end:highDates.at(-1)||null};
 const high=make('high',`此前${t.rules.highDays}个完整交易日高点`,[highAtom,confirmation,volume],[highAtom,confirmation,...(t.rules.requireVolume?[volume]:[])],fresh?price:null,highAtom.threshold,`排除目标日，${highDates[0]}—${highDates.at(-1)}；前复权高点/前复权昨收×当期原价昨收`,'up');
 if(!t.rules.enabled.includes('high')){high.status='DISABLED';high.met=null;high.disabledReason='配置关闭阶段高点筛选';}conditions.push(high);
 for(const [i,line] of t.priceLines.entries())if(line.symbol===member.symbol){
  const reasons:string[]=[];if(!target)reasons.push('交易日历未覆盖');if(target&&line.sourceDate>target)reasons.push('观察线在该时点尚未设定');if(target&&line.validUntil&&line.validUntil<target)reasons.push('已超过明确配置的有效期');
  if(line.comparability!=='verified'||!line.verification||!line.verifiedThrough||target&&line.verifiedThrough<target)reasons.push('缺覆盖目标交易日的证券/除权口径可比性依据');
  const disabled=!t.rules.enabled.includes('price')||line.enabled===false||line.reviewStatus==='disabled';
  if(line.reviewStatus==='needs_review'||line.reviewStatus==='pending')reasons.push('观察线复核任务待完成');
  const valid=atom('price-'+i+'-validation','观察线适用性',reasons.length?null:1,1,'布尔',reasons.join('；'));
  if(disabled){valid.status='DISABLED';valid.quality='disabled';valid.reasons=['配置明确关闭观察线'];}
  const compare=(a:number,b:number)=>line.direction==='above'?a>=b:a<=b;
  const position=atom('price-'+i+'-position','可比确认价格位置',fresh&&!reasons.length&&!disabled?price:null,line.price,'元','缺正式/有效价格或观察线可比性',compare);
  const cond=make('price-'+i,line.direction==='above'?'用户向上观察线':'用户向下观察线',[valid,position,confirmation],[valid,position,confirmation],position.actual,line.price,`来源${line.sourceDate}，${line.validUntil?'有效至'+line.validUntil:'未设置到期日，不等于过期'}；${line.verification||'待核验除权及价格口径'}`,line.direction==='above'?'up':'down');
  if(disabled){cond.status='DISABLED';cond.met=null;}
  cond.disabledReason=disabled?'配置明确关闭':reasons.join('；')||undefined;
  const snapshotValid=!!target&&line.sourceDate<=target&&price!==null&&Number.isFinite(price)&&price>0&&p?.priceUnit==='CNY'&&p?.quotePriceBasis==='unadjusted'&&p?.tradeDate===target&&available(p?.receivedAt,f.observedAt)&&available(p?.quoteAt,f.observedAt);
  cond.snapshot={actual:snapshotValid?price:null,threshold:line.price,status:snapshotValid?(compare(price!,line.price)?'PASS':'FAIL'):'UNKNOWN',label:'供应商快照位置；不证明可比性或本轮首次穿越'};
  cond.validation={status:disabled?'disabled':reasons.length?'pending':'verified',reasons:disabled?['配置关闭']:reasons,next:disabled?'在主题配置恢复后重新核验':'主题配置中补充可比性来源、核验截止日和复核状态，保存新版本并明确采用；不自动改价'};
  conditions.push(cond);
 }
 if(highBase===null&&t.rules.enabled.includes('high'))missing.push('阶段高点条件缺所需历史最高价或可比昨收');
 if(themeBase&&history(sector,3)===null)missing.push(themeBase.name+'历史比较缺失，不能排除行业普涨');
 const strong=relative.met===true&&member.verified&&member.role!=='pending',weak=fresh&&relative3!==null&&relative3<0&&(m.basisMode==='after_close'||intradayRelative!==null&&intradayRelative<0);
 return {symbol:member.symbol,name:member.name,role:member.role,segments:member.segments,price,quoteAt:p?.quoteAt??null,fresh,historyDays:p?.bars.filter(b=>m.historyEnd&&b.date<=m.historyEnd).length||0,return3:ret3,return5:ret5,relative3,relative5,intraday,intradayRelative,themeRelative3:difference(ret3,history(sector,3)),themeRelative5:difference(ret5,history(sector,5)),phase,historyStrong:r3.status==='PASS'&&r5.status==='PASS',strong,weak,conditions,missing,mode:m,evidenceAt:fresh?(m.basisMode==='after_close'?target+'T15:00:00+08:00':p?.quoteAt):null,next:strong?'等待下一独立观察点延续；相对强度失效应重新评估':`${relative.status==='FAIL'?'已知相对条件未满足；':'等待确认；'}补齐必需条件后再判断；观察筛选不是完整入场策略`,business:member.business,sources:member.sources,aliases:member.aliases};
}

function view(t:Theme,f:Frame,previous:ThemeReport|null):ThemeView{
 const stocks=t.members.map(m=>stockView(m,t,f)),formal=stocks.filter(s=>s.role!=='pending'&&t.members.find(m=>m.symbol===s.symbol)!.verified),valid=formal.filter(s=>s.relative3!==null&&s.relative5!==null),strong=formal.filter(s=>s.strong).length;
 const comparable=valid.length===formal.length&&formal.length>=2,relative3=mean(valid.map(s=>s.relative3)),relative5=mean(valid.map(s=>s.relative5)),intradayRelative=mean(formal.map(s=>s.intradayRelative));
 const segments=t.segments.map(name=>{const members=formal.filter(s=>s.segments.includes(name)),ok=members.filter(s=>s.relative3!==null&&s.relative5!==null),n=members.filter(s=>s.strong).length;return {name,configured:members.length,valid:ok.length,strong:n,relative3:mean(ok.map(s=>s.relative3)),relative5:mean(ok.map(s=>s.relative5)),status:members.length===0?'尚无已核验代表':ok.length===1?'单股观察，细分广度尚无法验证':ok.length<2?'有效样本不足':ok.length<members.length?'部分缺失，不确认细分联动':n>=t.rules.minLinked&&n/members.length>=t.rules.breadth?'精选样本出现联动':'尚未确认精选样本联动'};});
 const missing=[...new Set(stocks.flatMap(s=>s.missing))],breadth=round(strong/(formal.length||1));
 const status=!valid.length?'数据不足':valid.length/(formal.length||1)<t.rules.minCoverage?'覆盖不足，仅逐股观察':valid.length<formal.length?'部分数据缺失':!formal.some(s=>s.fresh&&(s.mode?.basisMode==='after_close'||s.intradayRelative!==null))?'历史可比较，当前阶段未确认':strong>=t.rules.minLinked&&breadth>=t.rules.breadth?'精选组合相对增强':strong===1?'单股增强，尚非主题联动':formal.length&&formal.every(s=>s.weak)?'精选组合转弱':'分化／尚未确认增强';
 const old=previous?.themes.find(x=>x.id===t.id&&x.version===t.version),change=old?`${old.status} → ${status}；3日相对变化 ${number(difference(relative3,old.relative3),'个百分点')}；增强对象 ${old.strong} → ${strong}`:'首次建立当前观察状态，不冒充新机会';
 return {id:t.id,name:t.name,version:t.version,scope:t.scope,status,stocks,configured:formal.length,valid:valid.length,pending:stocks.length-formal.length,core:stocks.filter(s=>s.role==='core').length,relative3,relative5,intradayRelative,strong,breadth,comparable,segments,missing,change,next:strong?'等待相同成员、相同口径下持续满足；转负或联动减少则重新评估':'继续核实相对强度、同细分代表与商业证据，不强行选股',benchmarks:t.benchmarks};
}
export function analyzeThemes(f:Frame,c:ObservationConfig,previous:ThemeState[]=[],baseline=false,priorReport:ThemeReport|null=null,replay=false):ThemeReport{
 const configs=(f.themeConfigs||[]).filter(t=>available(t.effectiveAt,f.observedAt)),themes=configs.map(t=>view(t,f,priorReport)),states:ThemeState[]=[],events:ThemeEvent[]=[],mode=evaluationMode(f,replay),date=mode.targetDate||localParts(f.observedAt).date,dates=historyDates(mode,6);
 type Check={id:string;theme:Theme;symbols:string[];name:string;met:boolean|null;negative:boolean;phase:string;evidenceAt:string|null;condition:string;details:string[];next:string};
 const checks:Check[]=[];
 for(const t of configs){const v=themes.find(v=>v.id===t.id)!;
  for(const s of v.stocks){const m=t.members.find(m=>m.symbol===s.symbol)!;if(!m.verified||m.role==='pending')continue;
   for(const cond of s.conditions){checks.push({id:`${t.id}/${s.symbol}/${cond.id}`,theme:t,symbols:[s.symbol],name:`${s.name} · ${cond.label}`,met:cond.status==='DISABLED'||cond.combination?.blocked.length?null:cond.met,negative:cond.direction==='down'||s.weak,phase:s.phase,evidenceAt:s.evidenceAt||null,condition:cond.id,details:[`${s.name} ${s.symbol.slice(2)} · ${s.segments.join('/')}`,`价格 ${number(s.price)}，行情 ${s.quoteAt||'缺失'}`,`完整3/5日相对 ${number(s.relative3)}/${number(s.relative5)} 个百分点；盘中相对 ${number(s.intradayRelative)} 个百分点`,`${cond.label}：${cond.met===null?'无法验证':cond.met?'满足':'未满足'}；本轮值 ${number(cond.actual)} / 门槛 ${number(cond.threshold)}；${cond.basis}`],next:s.next});}
  }
  const evidence=v.stocks.filter(s=>s.role!=='pending'&&s.fresh).map(s=>s.evidenceAt!).sort();
  checks.push({id:`${t.id}/theme/relative`,theme:t,symbols:v.stocks.filter(s=>s.role!=='pending').map(s=>s.symbol),name:t.name+'精选组合',met:v.comparable&&v.stocks.filter(s=>s.role!=='pending').every(s=>s.fresh)&&t.rules.enabled.includes('relative')?v.strong>=t.rules.minLinked&&v.breadth>=t.rules.breadth:null,negative:v.status==='精选组合转弱',phase:evidence.length&&v.stocks.every(s=>s.phase==='正式收盘确认')?'正式收盘确认':'盘中初步观察',evidenceAt:evidence[0]||null,condition:'theme',details:[`增强 ${v.strong}/${v.configured}，有效历史 ${v.valid}/${v.configured}`,`共同基准沪深300，完整3/5日相对 ${number(v.relative3)}/${number(v.relative5)} 个百分点`,...v.segments.filter(s=>s.configured).map(s=>`${s.name}：${s.status}（${s.strong}/${s.configured}）`)],next:v.next});
 }
 const prior=new Map(previous.map(s=>[s.id,s]));
 for(const check of checks){const old=prior.get(check.id);if(check.met===null||!check.evidenceAt||Date.parse(check.theme.effectiveAt)>Date.parse(f.observedAt)){if(old)states.push({...old,checks:0,candidate:old.status});continue;}
  const initial=baseline||!old||old.configVersion!==check.theme.version||old.evaluationVersion!=='conditions/2';
  if(!initial&&Date.parse(check.evidenceAt)-Date.parse(old.lastEvidence)<Math.max(c.frequencyMinutes,30)*60000){states.push(old);continue;}
  const state:ThemeState=initial?{id:check.id,phase:check.phase,status:'watching',candidate:'watching',checks:0,lastEvidence:check.evidenceAt,episode:1,baseline:true,tradeDate:date,finalDates:[],configVersion:check.theme.version,evaluationVersion:'conditions/2'}:structuredClone(old);
  const wanted=check.met?(check.negative&&check.condition.startsWith('price-')?'risk':'enhanced'):check.negative&&check.theme.rules.enabled.includes('risk')&&['enhanced','risk'].includes(state.status)?'risk':'watching';
  state.checks=wanted===state.candidate?state.checks+1:1;state.candidate=wanted;
  state.finalDates=check.met&&check.phase==='正式收盘确认'?[...new Set([...state.finalDates,date])]:check.met?state.finalDates:[];
  const finalDates=[...previousSessions(date,1),date],phase=finalDates.length===2&&finalDates.every(d=>state.finalDates.includes(d))?'后续交易日持续确认':check.phase;
  if(initial){state.status=wanted;state.phase=phase;}
  else if(state.checks>=check.theme.rules.confirmChecks&&(state.status!==wanted||state.phase!==phase&&wanted!=='watching')){
   const before=state.status;state.episode++;state.status=wanted;state.phase=phase;
   if((wanted==='enhanced'||check.theme.rules.enabled.includes('risk'))&&(wanted!=='watching'||before==='enhanced'))events.push({id:hash([check.id,check.theme.version,state.episode,phase,wanted].join(':')),conditionIds:[check.id],objectId:check.symbols.join(','),themeIds:[check.theme.id],names:[check.name],kind:wanted==='risk'||wanted==='watching'?'risk':'strengthening',phase,episode:state.episode,change:`${before==='enhanced'?'已增强':before==='risk'?'弱化风险':'观察中'} → ${wanted==='enhanced'?'连续满足观察条件':wanted==='risk'?'连续弱化/向下条件':'原增强条件连续失效'}；${state.checks}个不同时间观察点`,evidence:check.details,next:check.next,notify:!replay&&check.theme.notify&&c.notification.strategy});
  }
  state.lastEvidence=check.evidenceAt;state.tradeDate=date;state.baseline=initial;states.push(state);
 }
 // One message per run; combine multiple rules/themes for the same stock and direction.
 const merged:ThemeEvent[]=[];for(const e of events){const old=merged.find(x=>x.objectId===e.objectId&&x.kind===e.kind&&x.phase===e.phase);if(old){old.conditionIds=[...new Set([...(old.conditionIds||[]),...(e.conditionIds||[])])];old.themeIds=[...new Set([...old.themeIds,...e.themeIds])];old.names=[...new Set([...old.names,...e.names])];old.evidence=[...new Set([...old.evidence,...e.evidence])];old.notify ||=e.notify;}else merged.push(e);}
 const formalSymbols=new Set(configs.flatMap(t=>t.members.filter(m=>m.verified&&m.role!=='pending').map(m=>m.symbol)));
 const unique=new Map(themes.flatMap(t=>t.stocks.filter(s=>formalSymbols.has(s.symbol))).map(s=>[s.symbol,s])),valid=[...unique.values()].filter(s=>s.relative3!==null&&s.relative5!==null),strongSymbols=new Set(themes.flatMap(t=>t.stocks.filter(s=>s.strong).map(s=>s.symbol)));
 const comparable=themes.filter(t=>t.comparable),comparison=comparable.length<2?'数据不足，暂不能对多个主题排序；各股已知事实仍保留。':`统一完整交易日、沪深300基准、各主题精选公司等权：${comparable.slice().sort((a,b)=>(b.relative3||0)-(a.relative3||0)).map(t=>`${t.name} ${number(t.relative3)}/${number(t.relative5)}个百分点`).join('；')}。这是相对表现比较，不是买入排名，也不证明资金在主题间迁移。${themes.length>comparable.length?'缺失主题不参与排序。':''}`;
 const report:ThemeReport={version:'theme-report/1',observedAt:f.observedAt,mode,phase:mode.mode==='replay'?'历史回放':mode.basisMode==='intraday'?'盘中初步观察':mode.formalHistory?'盘后复盘（各股独立核验）':'盘后复盘，正式收盘待核验',baseline,window:{start3:dates.at(-4)||null,start5:dates.at(-6)||null,end:dates.at(-1)||null,basis:mode.formalHistory?'正式目标日收盘窗口；个股与基准独立验证；相对为收益率之差':'固定截止可用完整日，未确认当日收盘不纳入；相对为收益率之差'},themes,comparison,unique:{configured:unique.size,valid:valid.length,strong:strongSymbols.size},events:merged,states,limitations:[...f.coverage.uncovered,'单股不能验证细分广度；跨环节共享公司不构成额外独立证据','业务资料按配置日期核实，未自动核验新公告、订单和利润贡献','个人历史价格条件需有当期除权可比性核验才能触发'],text:''};report.decision=buildDecisions(report,configs);report.text=formatThemeReport(report);return report;
}
export function formatThemeReport(r:ThemeReport){return summaryText(r);}
export function formatThemeDiagnostics(r:ThemeReport){const lines=['知衡｜多主题机会雷达',`采集于 ${new Date(r.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）；各股行情时间见下`,`${r.phase} · ${r.baseline?'首次/配置变更基线':'主动查询结果'}`,`去重观察 ${r.unique.valid}/${r.unique.configured} 只有完整可比历史；精选组合，非全行业`,`完整3日 ${r.window.start3}—${r.window.end}；5日 ${r.window.start5}—${r.window.end}`,r.comparison];for(const t of r.themes){lines.push(`\n${t.name} · ${t.status}`,`有效 ${t.valid}/${t.configured}，核心${t.core}，待核验${t.pending}；增强${t.strong}/${t.configured}`,t.change,...t.segments.filter(s=>s.configured).map(s=>`${s.name}：${s.status}，增强${s.strong}/${s.configured}；完整3/5日相对 ${number(s.relative3)}/${number(s.relative5)}个百分点`));for(const s of t.stocks.filter(s=>s.role==='core'))lines.push(`${s.name} ${s.symbol.slice(2)}｜${s.segments.join('/')}｜${number(s.price,'元')} @ ${s.quoteAt||'未取得'}｜完整3/5日相对 ${number(s.relative3)}/${number(s.relative5)}pp｜盘中相对 ${number(s.intradayRelative)}pp｜${s.strong?'相对增强待持续验证':s.weak?'弱化观察':'未确认增强'}`,`下一步：${s.next}`);lines.push('影响判断的缺口：'+t.missing.join('；'));}lines.push('\n此处是运行诊断；策略动作以结构化decision为准。盘中触线不等于收盘突破。');return lines.join('\n');}
export function themeNotification(r:ThemeReport){return summaryText(r,'新增事件');}
