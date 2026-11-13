import type {Theme,ThemeReport,StockView,Condition} from './theme-types';
import {combine,conditionLabel,type Atom,type ConditionStatus} from './conditions';
import {strategyDraft,type Strategy} from './strategy-schema';
export type Action={code:'screen_only'|'wait_confirmation'|'defer_entry'|'consider_entry'|'risk_unverified'|'hold_valid'|'consider_reduce'|'consider_exit';label:string;scenario:'未持有者'|'已持有者';ruleVersion:string;dataAt:string;stage:string;reasons:string[];next:string[];invalidation:string[];blockers:string[];evidence:string[];validation:string};
export type DecisionItem={key:string;symbol:string;name:string;theme:string;themeId:string;risk:boolean;severity:number;confirmation:number;changed:boolean;actionable:boolean;rankReason:string;researchScore:number;reasons:string[];blockers:string[];actions:Action[]};
export type DecisionReport={version:'decision/1';rules:{themeId:string;strategy:Strategy;missing:string[]}[];risks:DecisionItem[];opportunities:DecisionItem[];others:DecisionItem[];gaps:string[];boundary:string};
const finite=(n:number|null)=>n!==null&&Number.isFinite(n);
const value=(n:number|null)=>finite(n)?n!.toFixed(2):'缺失';
function ruleMissing(s:Strategy){return (['entry','cancel','hold','reduce','exit','riskBoundary'] as const).filter(k=>!s[k]).map(k=>({entry:'入场与确认条件',cancel:'入场取消条件',hold:'持有条件',reduce:'减仓条件',exit:'退出条件',riskBoundary:'风险边界'}[k]));}
function knownAtoms(s:StockView){return s.conditions.flatMap(c=>{const status=c.status||(c.met===null?'UNKNOWN':c.met?'PASS':'FAIL');return [{id:c.id,status},...(status==='DISABLED'?[]:c.atoms||[])];});}
function actions(s:StockView,t:Theme|undefined,r:ThemeReport):Action[]{
 const rule=t?.strategy||strategyDraft(),missing=ruleMissing(rule),enabled=!!rule.enabled&&!missing.length;
 const atoms=knownAtoms(s),byId=new Map(atoms.map(a=>[a.id,a])),m=s.mode?.basisMode||r.mode?.basisMode;
 const stageReady=(g:Strategy['entry'])=>!!g&&(g.stage==='intraday'?m==='intraday'&&s.fresh:g.stage==='formal_close'?s.phase==='正式收盘确认':s.phase==='正式收盘确认'&&g.conditions.every(id=>{const parent=s.conditions.find(c=>c.id===id||c.atoms?.some(a=>a.id===id));return parent&&r.states.some(x=>x.id===t?.id+'/'+s.symbol+'/'+parent.id&&x.phase==='后续交易日持续确认'&&x.tradeDate===r.mode?.targetDate);}));
 const check=(g:Strategy['entry'])=>{
  if(!g)return {status:'UNKNOWN' as ConditionStatus,blocked:['未定义规则']};
  const required=g.conditions.map(id=>byId.get(id)||{id,status:'UNKNOWN' as const}),primary=combine(g.operator,required);
  const wanted:Pick<Atom,'id'|'status'>[]=[{id:'rule',status:primary.status}];
  // Volume/sector are explicit strategy requirements, not automatically inherited as auxiliary.
  if(rule.volumeRole==='required')wanted.push(byId.get('volume')||{id:'volume',status:'UNKNOWN'});
  if(rule.sectorRole==='required')wanted.push({id:'sector',status:r.themes.find(x=>x.id===t?.id)?.status==='精选组合相对增强'?'PASS':'UNKNOWN'});
  wanted.push({id:'stage',status:stageReady(g)?'PASS':'UNKNOWN'});
  const gates=combine('AND',wanted);return {...gates,blocked:[...new Set([...gates.blocked,...(primary.status==='UNKNOWN'?primary.blocked:[])])]};
 };
 const entry=check(rule.entry),cancel=check(rule.cancel),hold=check(rule.hold),reduce=check(rule.reduce),exit=check(rule.exit);
 const usable=enabled&&!!m&&m!=='unavailable'&&rule.modes.includes(m)&&s.role!=='pending'&&!!t?.members.find(x=>x.symbol===s.symbol)?.verified&&s.fresh;
 const ready=(g:Strategy['entry'],x:ReturnType<typeof check>)=>usable&&stageReady(g)&&x.status==='PASS'&&!x.blocked.length;
 let entering='等待确认',holding='已有风险计划未获本轮重新核验';
 if(!enabled){entering='仅作机会筛选，等待完整入场规则';holding='复核既有风险计划，不据缺失数据卖出或确认安全';}
 else if(usable){
  if(ready(rule.exit,exit))holding='退出条件已满足，可考虑退出';
  else if(ready(rule.reduce,reduce)&&exit.status==='FAIL')holding='减仓条件已满足，可考虑减仓';
  else if(ready(rule.hold,hold)&&exit.status==='FAIL'&&reduce.status==='FAIL'&&cancel.status==='FAIL')holding='持有条件仍成立';
  const range=rule.positionConstraint,day=r.mode?.targetDate;const positionOK=!range||!!day&&range.sourceDate<=day&&(!range.validUntil||range.validUntil>=day)&&s.price!==null&&(range.minimum===null||s.price>=range.minimum)&&(range.maximum===null||s.price<=range.maximum);
  if(positionOK&&ready(rule.entry,entry)&&cancel.status==='FAIL'&&exit.status==='FAIL'&&reduce.status==='FAIL')entering='入场条件已满足，可考虑建仓';
  else if(entry.status==='FAIL'||cancel.status==='PASS'||exit.status==='PASS'||reduce.status==='PASS')entering='暂不买入';
 }
 const atomic=new Map(s.conditions.flatMap(c=>c.atoms||[]).map(a=>[a.id,a]));
 const explain=(x:ReturnType<typeof check>)=>x.blocked.filter(id=>id!=='rule').flatMap(id=>atomic.get(id)?.reasons.length?atomic.get(id)!.reasons:[id==='stage'?'策略要求的证据确认阶段尚未满足':id==='sector'?'必需的主题联动未验证':'条件 '+id+' 尚未验证']);
 const common=[...(!enabled?missing.length?missing:['策略未启用']:[]),...(enabled&&!usable?['当前运行模式、证券资格或有效价格不满足策略要求']:[])];
 const draftBlockers=!enabled?s.conditions.filter(c=>c.id==='relative').flatMap(c=>c.atoms?.filter(a=>c.combination?.blocked.includes(a.id)).flatMap(a=>a.reasons)||[]):[];
 const range=rule.positionConstraint,day=r.mode?.targetDate;
 const rangeBlocked=range&&(!day||range.sourceDate>day||range.validUntil&&range.validUntil<day||s.price===null||range.minimum!==null&&s.price<range.minimum||range.maximum!==null&&s.price>range.maximum)?['已配置入场价格区间越界、过期或价格待核验']:[];
 const entryBlockers=[...new Set([...common,...draftBlockers,...(entering.includes('可考虑建仓')?[]:[...explain(entry),...explain(cancel),...explain(exit),...explain(reduce),...rangeBlocked])])];
 const holdBlockers=[...new Set([...common,...draftBlockers,...(/可考虑|持有条件仍成立/.test(holding)?[]:[...explain(hold),...explain(exit),...explain(reduce),...explain(cancel)])])];
 const base={ruleVersion:`${rule.id}/v${rule.version}`,dataAt:r.observedAt,stage:s.phase,reasons:s.conditions.filter(c=>c.status==='FAIL'||c.status==='PASS').map(c=>`${c.label}：${conditionLabel(c)}`),next:enabled?[`入场：${rule.entry!.operator}(${rule.entry!.conditions.join('、')})；确认阶段 ${rule.entry!.stage}`]:['补齐完整交易规则；历史相对强度只用于研究排序'],invalidation:rule.cancel?[`取消：${rule.cancel.operator}(${rule.cancel.conditions.join('、')})`,rule.riskBoundary||'风险边界未定义']:['取消条件和风险边界尚未定义'],evidence:[...new Set(s.conditions.flatMap(c=>c.atoms?.flatMap(a=>a.evidence.map(e=>`${e.frameId}:${e.operand}:${e.source}`))||[]))],validation:rule.validation==='unvalidated'?'规则执行结果，策略尚未验证盈利有效性':`配置声明${rule.validation}，验证依据：${rule.validationEvidence}；不承诺收益`};
 return [{...base,blockers:entryBlockers,code:!enabled?'screen_only':entering==='暂不买入'?'defer_entry':entering.includes('可考虑建仓')?'consider_entry':'wait_confirmation',label:entering,scenario:'未持有者'},{...base,blockers:holdBlockers,code:holding.includes('可考虑退出')?'consider_exit':holding.includes('可考虑减仓')?'consider_reduce':holding==='持有条件仍成立'?'hold_valid':'risk_unverified',label:holding,scenario:'已持有者'}];
}
export function buildDecisions(r:ThemeReport,configs:Theme[]=[]):DecisionReport{
 const items:DecisionItem[]=[],rules=r.themes.map(t=>{const strategy=configs.find(c=>c.id===t.id)?.strategy||strategyDraft();return {themeId:t.id,strategy,missing:ruleMissing(strategy)};});
 for(const t of r.themes)for(const s of t.stocks){
  const downward=s.conditions.filter(c=>c.status!=='DISABLED'&&c.direction==='down'&&(c.status==='PASS'||c.snapshot?.status==='PASS'));
  const confirmed=downward.some(c=>c.status==='PASS'&&!c.combination?.blocked.length),risk=downward.length>0||s.weak;
  const a=actions(s,configs.find(c=>c.id===t.id),r),actionable=a.some(x=>/已满足|仍成立/.test(x.label));
  const reasons=risk?downward.map(c=>`${c.label}：${c.snapshot?.actual!==null&&c.snapshot?value(c.snapshot.actual):value(c.actual)}元${c.direction==='down'?'低于或等于':'高于或等于'}${value(c.threshold)}元；${confirmed?'已通过该位置条件核验，是否首次穿越须看事件历史':'仅快照位置，先核验收盘与价位适用性'}`):s.historyStrong?[`完整3/5日相对沪深300为${value(s.relative3)}/${value(s.relative5)}个百分点，达到历史筛选门槛`]:s.conditions.filter(c=>c.status==='FAIL').map(c=>c.label+'未满足');
  if(s.weak&&!reasons.length)reasons.push('有效价格与相对表现显示弱化，需复核原有风险条件');
  const blockers=[...new Set(s.conditions.flatMap(c=>c.atoms?.filter(a=>a.status==='UNKNOWN').flatMap(a=>a.reasons)||[]).concat(downward.flatMap(c=>c.validation?.reasons||[])))];
  const severity=a.some(x=>x.label.startsWith('退出条件'))?4:a.some(x=>x.label.startsWith('减仓条件'))?3:confirmed?2:risk?1:0;
  const changed=r.events.some(e=>e.objectId.split(',').includes(s.symbol));
  items.push({key:t.id+'/'+s.symbol,symbol:s.symbol,name:s.name,theme:t.name,themeId:t.id,risk,severity,confirmation:confirmed?2:s.historyStrong?1:0,changed,actionable,rankReason:`风险级别${severity} → 确认等级${confirmed?2:s.historyStrong?1:0} → ${changed?'本轮有变化':'无新增事件'} → ${actionable?'动作条件充分':'研究/核验优先'}`,researchScore:s.historyStrong?Math.min(s.relative3!,s.relative5!):-1e9,reasons,blockers,actions:a});
 }
 const order=(a:DecisionItem,b:DecisionItem)=>b.severity-a.severity||b.confirmation-a.confirmation||Number(b.changed)-Number(a.changed)||Number(b.actionable)-Number(a.actionable)||b.researchScore-a.researchScore||a.key.localeCompare(b.key);
 const dedupe=(xs:DecisionItem[])=>[...new Map(xs.sort(order).map(x=>[x.symbol,x] as const).reverse()).values()].sort(order);
 return {version:'decision/1',rules,risks:dedupe(items.filter(i=>i.risk)),opportunities:dedupe(items.filter(i=>i.confirmation>=1&&!i.risk&&i.researchScore!==-1e9)),others:items.filter(i=>!i.risk&&i.researchScore===-1e9),gaps:r.themes.filter(t=>!t.comparable).map(t=>`${t.name}可比${t.valid}/${t.configured}只，不作主题整体判断`),boundary:rules.some(r=>r.strategy.enabled)?'条件化动作依据已配置规则，均为假设持仓场景；规则执行不代表盈利已验证':'当前是机会筛选器；缺少完整入场、持有、减仓、退出和风险边界，不生成已确认买卖名单'};
}
export function summaryText(r:ThemeReport,nature='主动查询'){
 const d=r.decision||buildDecisions(r),target=r.mode?.targetDate||r.window.end||'日期待核实';
 const lines=['知衡｜策略观察',`${target} · ${r.mode?.mode==='replay'?'历史回放':r.phase} · ${nature}`,r.baseline?'当前判断：本次建立基线，先看风险再筛机会；已知条件单独呈现，不称为新增信号。':'当前判断：先处理风险核验，再研究证据较充分的候选；观察排名不等于买入顺序。'];
 const risk=d.risks[0],op=d.opportunities.slice(0,2);
 if(risk)lines.push(`风险优先：${risk.name}，${risk.reasons[0]||'原观察条件弱化'}。${risk.actions[1].label}。`);
 if(op.length)lines.push(`机会优先：${op.map(x=>x.theme+'·'+x.name).join('、')}，历史3/5日相对指标满足。${op.some(x=>x.actions[0].code==='consider_entry')?op.map(x=>x.name+'：'+x.actions[0].label).join('；'):'先核验当前确认与入场/取消规则，暂不确认买点'}。`);
 if(!risk&&!op.length)lines.push('观察结果：尚无证据充分的优先候选；有效不达标项和缺失项分别保留，不把数据不足当作市场安全。');
 if(d.gaps.length)lines.push('暂缓判断：'+d.gaps[0]+'。');
 lines.push(d.rules.some(x=>x.strategy.enabled)?'这是规则执行结果，非经过盈利验证的承诺；持仓分支仅是假设。':'当前只有机会筛选规则，尚无完整买卖策略；未读取个人持仓。');
 return lines.join('\n');
}
export function evidenceText(r:ThemeReport,question='',page=1){
 const matches=r.themes.filter(t=>question.includes(t.name)||t.stocks.some(s=>question.includes(s.name)||question.includes(s.symbol)||question.includes(s.symbol.slice(2))));
 const themes=matches.length?matches:r.themes,objects=themes.flatMap(t=>t.stocks.filter(s=>!matches.length||question.includes(t.name)||question.includes(s.name)||question.includes(s.symbol)||question.includes(s.symbol.slice(2))).map(s=>({t,s})));
 const selected=objects.slice(page-1,page),lines=[`策略与证据 · 第${page}/${Math.max(1,objects.length)}页；共${objects.length}个对象（含辅助与待核验）`,`采集 ${r.observedAt}；目标交易日 ${r.mode?.targetDate||'旧报告未记录'}；最后可用日 ${r.mode?.lastAvailableDate||'旧报告未记录'}`,`3日 ${r.window.start3}—${r.window.end}；5日 ${r.window.start5}—${r.window.end}；${r.window.basis}`];
 for(const {t,s} of selected){lines.push(`${t.name}·${s.name} ${s.symbol}｜快照${value(s.price)}元；行情${s.quoteAt||'缺失'}；${s.phase}`);lines.push('主要缺口：'+s.missing.join('；'));for(const c of s.conditions){lines.push(`${c.label}：${conditionLabel(c)}；实际 ${value(c.actual)} / 阈值 ${value(c.threshold)}。${c.basis}`);if(c.snapshot)lines.push(`位置描述：${c.snapshot.label}；${value(c.snapshot.actual)} / ${value(c.snapshot.threshold)}元`);for(const a of c.atoms||[])lines.push(`  ${a.label}：${a.status}；实际${value(a.actual)} / 阈值${value(a.threshold)} ${a.unit}；${a.window.start}—${a.window.end}；质量${a.quality}${a.reasons.length?'；'+a.reasons.join('；'):''}`);if(c.validation)lines.push(`复核状态：${c.validation.status}；${c.validation.reasons.join('；')}；下一步：${c.validation.next}`);}
  for(const e of [...new Map(s.conditions.flatMap(c=>c.atoms?.flatMap(a=>a.evidence)||[]).map(e=>[e.source+e.availableAt,e])).values()])lines.push(`证据 ${e.source}；取得 ${e.availableAt||'未知'}；批次 ${e.frameId}`);
  const d=[...(r.decision?.risks||[]),...(r.decision?.opportunities||[]),...(r.decision?.others||[])].find(x=>x.key===t.id+'/'+s.symbol);if(d)for(const a of d.actions)lines.push(`${a.scenario}（假设）：${a.label}；${a.ruleVersion}；${a.validation}`,`下一确认：${a.next.join('；')}；失效：${a.invalidation.join('；')}；阻塞：${a.blockers.join('；')}`);
 }
 lines.push('查看后续对象：回复“查看证据 第2页”等；按股票名称可单独查阅。完整逐项证据和诊断也保存在本机持续观察。');return lines.join('\n');
}
