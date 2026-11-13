import {createHash} from 'node:crypto';
import {marketPhase,localParts,previousSessions,tradingDay} from './calendar';
import {type Frame,type DataPoint,type Group,type Metric,type Candidate,type Signal,type ObservationConfig} from './types';
const mean=(xs:number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
const round=(x:number)=>Math.round(x*10000)/10000;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function quality(p:DataPoint|undefined,date:string,at:string){
 if(!p)return ['没有取得数据'];const bad=[...p.issues];
 if(!p.quote||!p.quoteAt||p.tradeDate!==date)bad.push('报价交易日错误或缺失');
 if(p.quoteAt&&!Number.isFinite(Date.parse(p.quoteAt)))bad.push('行情时间格式无效');
 if(p.quoteAt&&(Date.parse(at)-Date.parse(p.quoteAt)>10*60000||Date.parse(p.quoteAt)>Date.parse(at)+60000))bad.push('快照过期或来自未来');
 if(!p.quote?.open||!p.quote?.previousClose||p.quote.volume===null||p.quote.volume<=0)bad.push('成交状态或昨收无法核验，不能把缺失当作零');
 if(p.kind==='stock'&&(p.priceBasis!=='qfq'||p.priceUnit!=='CNY'))bad.push('个股价格口径或单位不一致');
 if(p.kind==='index'&&(p.priceBasis!=='none'||p.priceUnit!=='index_points'))bad.push('基准价格口径或单位不一致');
 if(p.bars.some((b,i)=>!Number.isFinite(b.close)||b.close<=0||!Number.isFinite(b.volume)||b.volume<0||(i>0&&p.bars[i-1].date>=b.date)))bad.push('历史字段或顺序无效');
 return bad;
}
function returnAt(p:DataPoint,dates:string[],window:number){const bars=new Map(p.bars.map(b=>[b.date,b])),last=bars.get(dates.at(-1)!)!,base=bars.get(dates.at(-window)!)!;return ((last.close/base.close)*(p.quote!.price/p.quote!.previousClose!)-1)*100;}
export function computeMetric(group:Group,frame:Frame,c:ObservationConfig):Metric{
 const at=frame.observedAt,{date}=localParts(at),benchmark=frame.points[c.scope.benchmark],dates=previousSessions(date,26),historyDates=dates.slice(-6),missing:string[]=[];
 const m:Metric={id:group.id,name:group.name,kind:group.kind,stage:'preliminary',valid:false,tradeDate:date,quoteAt:'',coverage:0,validMembers:[],allMembers:group.fullMembers,upMembers:[],linkedMembers:[],relative3:null,relative5:null,dailyRelative3:[],breadth:null,volumeRatio:null,missing,conditions:[],sourceDates:{start3:historyDates.at(-3)||null,start5:historyDates.at(-5)||null,end:date}};
 if(tradingDay(date)!==true)missing.push('休市或交易日历未覆盖');
 if(group.knownAt>at||group.sourceDate>date||Date.parse(date)-Date.parse(group.sourceDate)>30*86400000)missing.push('分类缺少当时可用版本或已经过期');
 if(!group.members.length||new Set(group.members.map(x=>x.symbol)).size!==group.members.length)missing.push('分类样本为空或重复');
 const baseProblems=quality(benchmark,date,at);if(baseProblems.length)missing.push(...baseProblems.map(s=>'基准：'+s));
 const historical=(p:DataPoint)=>historyDates.length===6&&historyDates.every(d=>p.bars.some(b=>b.date===d));
 if(!benchmark||!historical(benchmark))missing.push('基准共同历史区间不足');
 const valid=group.members.map(x=>frame.points[x.symbol]).filter((p):p is DataPoint=>!!p&&quality(p,date,at).length===0&&historical(p));
 m.coverage=valid.length/group.members.length||0;m.validMembers=valid.map(p=>p.symbol);
 if(m.coverage<c.rules.minCoverage||valid.length<c.rules.minLinked)missing.push('有效样本/联动数量不足');
 const phase=marketPhase(at),final=phase==='after_close'&&valid.length>0&&valid.every(p=>p.finalPrice)&&benchmark?.finalPrice;
 if(phase!=='intraday'&&!(phase==='after_close'&&final))missing.push('非盘中有效采样，且未取得正式收盘标志');
 const times=[...valid,benchmark].filter((x):x is DataPoint=>!!x&&!!x.quoteAt).map(p=>Date.parse(p.quoteAt!)).filter(Number.isFinite);
 if(times.length&&Math.max(...times)-Math.min(...times)>5*60000)missing.push('对象与基准快照未对齐');
 m.quoteAt=times.length?new Date(Math.min(...times)).toISOString():at;
 if(missing.length)return m;
 m.relative3=round(mean(valid.map(p=>returnAt(p,historyDates,3)))-returnAt(benchmark,historyDates,3));
 m.relative5=round(mean(valid.map(p=>returnAt(p,historyDates,5)))-returnAt(benchmark,historyDates,5));
 m.upMembers=valid.filter(p=>p.quote!.price>p.quote!.previousClose!).map(p=>p.symbol);
 m.linkedMembers=valid.filter(p=>returnAt(p,historyDates,3)-returnAt(benchmark,historyDates,3)>=c.rules.minRelative3).map(p=>p.symbol);
 // Missing constituents stay in the denominator: absence cannot improve breadth.
 m.breadth=round(m.upMembers.length/group.members.length);
 for(let offset=2;offset>=0;offset--){const end=historyDates[5-offset],start=historyDates[2-offset];const r=(p:DataPoint)=>(p.bars.find(b=>b.date===end)!.close/p.bars.find(b=>b.date===start)!.close-1)*100;m.dailyRelative3.push(round(mean(valid.map(r))-r(benchmark)));}
 const volumeEligible=phase==='after_close'&&valid.every(p=>p.volumeComparable&&p.finalVolume&&p.bars.some(b=>b.date===date)&&dates.slice(-20).every(d=>p.bars.some(b=>b.date===d)))&&new Set(valid.map(p=>p.volumeUnit)).size===1;
 if(volumeEligible){const ratios=valid.map(p=>{const prior=mean(dates.slice(-20).map(d=>p.bars.find(b=>b.date===d)!.volume));return prior>0?p.bars.find(b=>b.date===date)!.volume/prior:NaN;});if(ratios.every(Number.isFinite))m.volumeRatio=round(mean(ratios));}
 if(m.volumeRatio===null)missing.push('量能确认停用：缺少最终成交量/同口径单位/20个完整交易日；盘中不比全天量');
 m.stage=final?'close_confirmed':'intraday';m.valid=true;
 m.conditions=[{name:'3日相对强度（累计收益之差，百分点）',met:m.relative3>=c.rules.minRelative3,actual:m.relative3,threshold:c.rules.minRelative3},{name:'5日相对强度（百分点）',met:m.relative5>=c.rules.minRelative5,actual:m.relative5,threshold:c.rules.minRelative5},{name:'上涨广度（抽样，缺失仍计分母）',met:m.breadth>=c.rules.breadth,actual:m.breadth,threshold:c.rules.breadth},{name:'至少两只样本联动',met:m.linkedMembers.length>=c.rules.minLinked,actual:m.linkedMembers.length,threshold:c.rules.minLinked},{name:'历史3日相对强度持续性',met:m.dailyRelative3.slice(-2).every(v=>v>0),actual:m.dailyRelative3,threshold:'最近两个历史窗口均>0'},{name:'量能确认',met:m.volumeRatio===null?null:m.volumeRatio>=c.rules.volumeRatio,actual:m.volumeRatio,threshold:c.rules.requireVolume?c.rules.volumeRatio:'不作为本配置的确认条件'}];
 return m;
}
export function overlap(a:string[],b:string[]){const x=new Set(a),y=new Set(b),intersection=[...x].filter(i=>y.has(i)).length;return intersection/(x.size+y.size-intersection||1);}
const strong=(m:Metric,c:ObservationConfig)=>m.valid&&m.conditions.filter(x=>x.name!=='量能确认').every(x=>x.met===true)&&(!c.rules.requireVolume||m.volumeRatio!==null&&m.volumeRatio>=c.rules.volumeRatio);
export function detect(frame:Frame,c:ObservationConfig,previous:Candidate[],baseline:boolean){
 const metrics=frame.groups.map(g=>computeMetric(g,frame,c)),states:Candidate[]=[],signals:Signal[]=[];
 const oldById=new Map(previous.map(p=>[p.id,p]));
 for(const m of metrics){const old=oldById.get(m.id);
  if(!m.valid||m.coverage<1){if(m.valid&&m.coverage<1)m.missing.push('部分样本可展示，但不参与排名、状态升级或风险判断，避免缺失造成伪增强');if(old)states.push(old);continue;}
  const enoughTime=!old||Date.parse(m.quoteAt)-Date.parse(old.lastEvidence)>=Math.max(c.frequencyMinutes,30)*60000;
  if(old&&!enoughTime&&!baseline){states.push(old);continue;}
  const positive=strong(m,c),weak=m.relative3!<0&&m.breadth!<=c.rules.riskBreadth;
  const s:Candidate=old&&!baseline?structuredClone(old):{id:m.id,name:m.name,episode:1,status:'watching',last:m,lastEvidence:m.quoteAt,strongChecks:0,strongDates:[],finalDates:[],weakChecks:0,weakDates:[],rotationChecks:0,emitted:[],anchor:m};
  s.strongChecks=positive?s.strongChecks+1:0;s.strongDates=positive?[...new Set([...s.strongDates,m.tradeDate])]:[];s.weakChecks=weak?s.weakChecks+1:0;s.weakDates=weak?[...new Set([...s.weakDates,m.tradeDate])]:[];
  // Final confirmation is never inferred from repeated intraday observations.
  s.finalDates=positive?(m.stage==='close_confirmed'?[...new Set([...s.finalDates,m.tradeDate])]:s.finalDates):[];
  const requiredFinalDates=[...previousSessions(m.tradeDate,c.rules.confirmDays-1),m.tradeDate];
  const phase=m.stage==='close_confirmed'&&requiredFinalDates.length===c.rules.confirmDays&&requiredFinalDates.every(d=>s.finalDates.includes(d))?'persistent_confirmed':m.stage;
  const confirmed=positive&&(s.strongChecks>=c.rules.confirmChecks||phase==='persistent_confirmed');
  const emit=(kind:Signal['kind'],why:string,change:string)=>{
   if(!c.rules.enabled.includes(kind))return;const key=kind+':'+phase;if(s.emitted.includes(key))return;s.emitted.push(key);
   signals.push({id:digest([m.id,kind,phase,s.episode].join(':')),groupId:m.id,kind,phase,episode:s.episode,ruleVersion:c.rules.version,notify:!baseline&&c.notification.strategy,explanation:why,change,metric:m,previous:old?.last||null,related:[]});
  };
  if(baseline||!old){s.status=positive?'candidate':'watching';s.emitted=positive?['candidate:'+phase]:[];}
  else if(confirmed){
   if(s.status==='weakening'){s.episode++;s.emitted=[];s.anchor=m;}
   if(s.status!=='candidate'||!s.emitted.includes('candidate:'+phase))emit('candidate','覆盖样本的相对强度、历史持续性与联动广度满足规则；是候选，不是买入信号。',old?.status==='weakening'?'弱化后重新满足观察门槛；尚非正式修复结论':'由观察转入候选或确认层级升级');
   if(old?.status==='candidate'&&m.relative3!-s.anchor.relative3!>=c.rules.strengthDelta&&m.breadth!>=s.anchor.breadth!)emit('strengthening','同一版本、同一组样本相对强度改善，广度未下降。',`相对3日强度较事件基线增加 ${round(m.relative3!-s.anchor.relative3!)} 个百分点`);
   const added=m.upMembers.filter(x=>!s.anchor.upMembers.includes(x));
   if(old?.status==='candidate'&&m.breadth!-s.anchor.breadth!>=c.rules.diffusionDelta&&added.length>=2)emit('diffusion','更多同组抽样成分同步上涨；仅证明样本内扩散，不证明全行业或产业链扩散。',`新增 ${added.length} 只上涨样本；广度 ${s.anchor.breadth} → ${m.breadth}`);
   if(old?.status!=='candidate')s.anchor=m;
   s.status='candidate';
  }
  if(!baseline&&s.status==='candidate'&&s.weakChecks>=c.rules.confirmChecks){emit('risk','相对强度转弱且样本上涨广度持续收缩；不是减仓指令。',`连续 ${s.weakChecks} 个有效观察点弱化，涉及 ${s.weakDates.length} 个不同交易日`);s.status='weakening';}
  s.last=m;s.lastEvidence=m.quoteAt;states.push(s);
 }
 // Rotation compares prior leaders, excludes shared constituents, and requires persistence.
 for(const s of states){const m=metrics.find(m=>m.id===s.id);if(!m?.valid||m.coverage<1||!strong(m,c)||baseline||s.lastEvidence!==m.quoteAt)continue;const old=oldById.get(s.id);if(old?.lastEvidence===m.quoteAt)continue;
  const leader=previous.filter(p=>p.id!==s.id&&p.status==='candidate'&&overlap(p.last.allMembers,m.allMembers)<c.rules.overlap).sort((a,b)=>(b.last.relative3||0)-(a.last.relative3||0))[0];const other=metrics.find(m=>m.id===leader?.id);
  const improves=leader&&other?.valid&&other.coverage===1&&old&&m.relative3!-other.relative3!>=c.rules.rotationDelta&&(m.relative3!-other.relative3!)-(old.last.relative3!-leader.last.relative3!)>=c.rules.rotationDelta;
  s.rotationChecks=improves?s.rotationChecks+1:0;
  if(s.rotationChecks>=c.rules.confirmChecks&&c.rules.enabled.includes('rotation')&&!s.emitted.includes('rotation:'+m.stage)){s.emitted.push('rotation:'+m.stage);signals.push({id:digest([s.id,'rotation',m.stage,s.episode].join(':')),groupId:s.id,kind:'rotation',phase:m.stage,episode:s.episode,ruleVersion:c.rules.version,notify:c.notification.strategy,explanation:'量价相对表现支持的轮动候选；不能证明资金真实从一个方向转入另一个方向。',change:`相对 ${other!.name} 的表现差持续改善`,metric:m,previous:old?.last||null,related:[other!.id]});}
 }
 // Suppress duplicate external alerts; preserve both events with their relationship.
 const ordered=signals.slice().sort((a,b)=>(a.kind==='risk'?-1:0)-(b.kind==='risk'?-1:0)||(b.metric.relative3||0)-(a.metric.relative3||0));
 const accepted:Signal[]=[];for(const s of ordered){const duplicate=accepted.find(x=>x.groupId!==s.groupId&&overlap(x.metric.allMembers,s.metric.allMembers)>=c.rules.overlap);if(duplicate){s.notify=false;s.related.push(duplicate.groupId);s.explanation+=' 与 '+duplicate.metric.name+' 高度重叠，合并提醒，不算独立确认。';}else accepted.push(s);}
 return {metrics,states,signals,baseline,validGroups:metrics.filter(m=>m.valid&&m.coverage===1).length};
}
