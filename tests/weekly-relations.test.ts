// Synthetic legacy captures: deliberately no reply edges, shared topic != same trade.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-relations-'));
const db=await import('../server/db'),store=await import('../server/store'),weekly=await import('../server/weekly-review');
const {buildReviewPlan}=await import('../server/weekly-relations');
const {allocateDecisionText}=await import('../server/decision-context');
const {saveConfig}=await import('../server/config'),{claim}=await import('../server/engine');
const at=new Date('2026-11-10T04:00:00Z');
function reset(){for(const t of ['weekly_reviews','working_states','runs','records','topics'])db.exec(`DELETE FROM ${t}`);saveConfig('TEST-NOT-A-KEY','kimi-k3',1000000);}
function raw(text:string,topic:string){const id=store.addRecord('测试样例：'+text,topic,'note');db.exec("UPDATE records SET created_at='2026-11-09T01:00:00Z' WHERE id=?",id);return id;}
function fixture(){reset();const topic=store.createTopic('测试：相关行业研究');return {
 thesis:raw('行业研究前言。'.repeat(260)+'核心推理：研究惯性可能让资金先在同方向内部寻找接力，但同主题不保证具体对象补涨。'+'论证边界。'.repeat(260),topic),
 first:raw('甲公司量价转强后我买入；后来基于行业轮动转入乙公司和丙公司。',topic),
 correction:raw('接着前面乙公司和丙公司的那次调整，我现在并没有再换仓的计划，想先判断轮动依据。',topic),
 other:raw('另一件事：上游方向很强，下游偏弱，我考虑下游企业的补涨。这与前面的持仓不是同一笔交易。',topic),
 independent:raw('甲公司另一笔独立短线尝试，只研究价格承接，不沿用行业轮动。',topic)};}
function excerpt(catalog:Map<string,{source_id:string;quote:string}>,id:string){return [...catalog].find(([,c])=>c.source_id===id)![0];}
test('Legacy captures retain the complete central argument; short notes leave space to long theses',async()=>{
 const ids=fixture();const topic=db.one<any>('SELECT topic_id FROM records WHERE id=?',ids.first).topic_id;for(let i=0;i<30;i++)raw('独立笔记'+i+'，只记录资料标题。',topic);const r=weekly.requestWeeklyReview(at);const c=await weekly.weeklyContext(db.one<any>('SELECT * FROM weekly_reviews WHERE id=?',r.reviewId)!);
 const original=db.one<any>('SELECT content FROM records WHERE id=?',ids.thesis).content;
 assert.equal(c.sources.find(s=>s.id===ids.thesis)!.text,original);assert.equal(c.coverage.excerpted,false);assert.equal(c.coverage.selected,35);
 const e=weekly.weeklyEvidence(c);assert.match(e.prompt,/研究惯性可能/);assert.ok(e.prompt.length<=24000);
 const map=allocateDecisionText(db.all<any>('SELECT * FROM records'),600);for(const [id,parts] of map)for(const p of parts)assert.ok(db.one<any>('SELECT content FROM records WHERE id=?',id).content.includes(p));
});
test('Cited continuations connect legacy fragments, context and comparison do not merge transactions',async()=>{
 const ids=fixture(),r=weekly.requestWeeklyReview(at),c=await weekly.weeklyContext(db.one<any>('SELECT * FROM weekly_reviews WHERE id=?',r.reviewId)!);const {catalog}=weekly.weeklyEvidence(c),e=(id:string)=>excerpt(catalog,id);
 const plan=buildReviewPlan({links:[{from:e(ids.first),to:e(ids.correction),relation:'continues',reason:'测试：明确接着同一次调整'}, {from:e(ids.thesis),to:e(ids.first),relation:'context',reason:'测试：行业框架用于解释调整'}, {from:e(ids.first),to:e(ids.other),relation:'compares',reason:'测试：都涉及从强方向推到接力的待验证步骤'}]},catalog,c.sources);
 const group=plan.groups.find(g=>g.source_ids.includes(ids.first))!;
 assert.ok(group.source_ids.includes(ids.correction));assert.deepEqual(group.context_ids,[ids.thesis]);assert.ok(!group.source_ids.includes(ids.other));assert.ok(!group.source_ids.includes(ids.independent));
 assert.equal(db.all('SELECT * FROM record_context').length,0,'Review links must not migrate or merge raw captures');
 const sameReplyChain=c.sources.filter(s=>new Set<string>([ids.first,ids.independent]).has(s.id)).map(s=>({...s,situation_id:'shared-discussion'}));
 assert.equal(buildReviewPlan({links:[]},catalog,sameReplyChain).groups.length,2,'A reply chain alone must not merge different trades');
 const cite=(id:string)=>catalog.get(e(id))!;
 const report=weekly.validateWeekly({focus:[],changes:[],unresolved:[],logic:[{situation_id:group.id,title:'测试：调整依据',basis:{text:'测试：行业前提',citations:[cite(ids.thesis)]},change:{kind:'correction',text:'测试：仍在核对',citations:[cite(ids.correction)]},assessment:{text:'测试：共同主题不保证接力',citations:[cite(ids.first)]},next_check:null}],insights:[{text:'测试：两次不同判断中都存在接力推断，尚非稳定规律',citations:[cite(ids.first),cite(ids.other)]}]},c.sources,plan);
 assert.equal(report.insights.length,1);
 const selected={focus:[],changes:[],unresolved:[],logic:[{situation_id:'G'+(plan.groups.indexOf(group)+1),title:'测试：别名还原',basis:null,change:null,assessment:{text:'测试：同一问题',evidence_ids:[e(ids.first),e(ids.correction)]},next_check:null}]};
 assert.equal(weekly.resolveWeeklySelection(selected,catalog,c.sources,plan).logic[0].situation_id,group.id);
 selected.logic[0].situation_id=ids.correction;
 assert.equal(weekly.resolveWeeklySelection(selected,catalog,c.sources,plan).logic[0].situation_id,group.id);
 selected.logic[0].assessment.evidence_ids.push(e(ids.independent));
 assert.throws(()=>weekly.resolveWeeklySelection(selected,catalog,c.sources,plan),/不同讨论/);

 assert.throws(()=>weekly.validateWeekly({...report,insights:[{text:'测试错误对照',citations:[cite(ids.first),cite(ids.independent)]}]},c.sources,plan),/比较关系/);
});
test('Invented endpoints, rejected links and indirect rejoining are rejected',async()=>{
 const ids=fixture(),r=weekly.requestWeeklyReview(at),c=await weekly.weeklyContext(db.one<any>('SELECT * FROM weekly_reviews WHERE id=?',r.reviewId)!);const {catalog}=weekly.weeklyEvidence(c),e=(id:string)=>excerpt(catalog,id);
 const invalid=buildReviewPlan({focus:['E999'],links:[{from:'E999',to:e(ids.first),relation:'continues',reason:'测试错误来源'},{from:e(ids.thesis),to:e(ids.thesis),relation:'continues',reason:'测试同源冗余'}]},catalog,c.sources);
 assert.equal(invalid.links.length,0);assert.deepEqual(invalid.rejected_candidates?.map(r=>r.code),['unknown_source','same_original','invalid_focus']);
 const a={from:e(ids.first),to:e(ids.correction),relation:'continues',reason:'测试直接延续'},b={from:e(ids.correction),to:e(ids.other),relation:'continues',reason:'测试错误的间接延续'};
 const indirect=buildReviewPlan({links:[a,b]},catalog,c.sources,[{source_id:ids.first,target_id:ids.other}]);assert.equal(indirect.links.length,1);assert.ok(!indirect.groups.find(g=>g.source_ids.includes(ids.first))!.source_ids.includes(ids.other));assert.equal(indirect.rejected_candidates?.[0].code,'indirect_denied');
 const denied=buildReviewPlan({links:[{...a,relation:'context'}]},catalog,c.sources,[{source_id:ids.first,target_id:ids.correction}]);assert.equal(denied.links.length,0);assert.equal(denied.rejected_candidates?.[0].code,'denied');
});
test('Planning, writing and full-report audit run in order; source deletion clears derived links and report',async()=>{
 const ids=fixture(),r=weekly.requestWeeklyReview(at);const stages:string[]=[];
 await weekly.processWeekly(claim()!,async(system,prompt)=>{
  const c=JSON.parse(prompt);
  if(system.startsWith('你为每周')){stages.push('link');const get=(id:string)=>c.sources.find((s:any)=>s.id===id).passages[0].id;return {focus:[get(ids.first)],links:[{from:get(ids.first),to:get(ids.correction),relation:'continues',reason:'测试：明确接着那次调整'}]};}
  if(system.includes('独立的交易思路核对者')){stages.push('audit');assert.ok(c.reviewPlan.links.length);assert.ok(c.report.logic.length);return {rejected:[]};}
  stages.push('write');const group=c.reviewPlan.groups.find((g:any)=>g.source_ids.includes(ids.first));return {focus:[],changes:[],unresolved:[],logic:[{situation_id:group.id,title:'测试：调整的推理',basis:null,change:null,assessment:{text:'测试：继续核对',evidence_ids:[c.sources.find((s:any)=>s.id===ids.correction).passages[0].id]},next_check:null}]};
 });
 assert.deepEqual(stages,['link','write','audit']);let run=db.one<any>('SELECT * FROM runs WHERE id=?',r.runId)!;assert.equal(run.status,'succeeded');assert.ok(JSON.parse(run.result).reviewPlan.links.length);
 db.exec('DELETE FROM records WHERE id=?',ids.correction);run=db.one<any>('SELECT * FROM runs WHERE id=?',r.runId)!;assert.equal(run.result,null);assert.equal(run.status,'stale');
});
test('A boundary failure gets one bounded repair and then a full audit; repeated crossing still fails',async()=>{
 for(const mode of ['logic-repaired','changes-repaired','unsupported-repaired','still-invalid']){
  const repaired=mode!=='still-invalid';
  const ids=fixture(),r=weekly.requestWeeklyReview(at);let writes=0,audits=0;
  const original=await weekly.weeklyContext(db.one<any>('SELECT * FROM weekly_reviews WHERE id=?',r.reviewId));const {catalog}=weekly.weeklyEvidence(original);const eid=(id:string)=>excerpt(catalog,id);
  await weekly.processWeekly(claim()!,async(system,prompt)=>{
   const payload=JSON.parse(prompt),c=payload.input||payload;
   if(system.startsWith('你为每周'))return {focus:[eid(ids.first)],links:[]};
   if(system.includes('独立的交易思路核对者')){audits++;return {rejected:[]};}
   writes++;const group=c.reviewPlan.groups.find((g:any)=>g.source_ids.includes(ids.first));
   assert.ok(!c.sources.some((s:any)=>s.id===ids.independent),'Independent source must not be visible to the writer');
   const source=(writes===2&&repaired)||mode==='changes-repaired'||mode==='unsupported-repaired'?ids.first:ids.independent;
   return {focus:[],changes:mode==='changes-repaired'&&writes===1?[{text:'Test unsupported change',evidence_ids:[ids.first,ids.independent].map(eid)}]:[],unresolved:[],logic:[{situation_id:group.alias,title:'测试：保持独立',basis:null,change:null,assessment:{text:mode==='unsupported-repaired'&&writes===1?'测试：每次都只能靠临时情绪决策':'测试：仅原文支持的推断',evidence_ids:[eid(source)]},next_check:null}]};
  });
  const run=db.one<any>('SELECT * FROM runs WHERE id=?',r.runId)!;
  assert.equal(writes,2);assert.equal(audits,repaired?1:0);assert.equal(run.status,repaired?'succeeded':'failed');
  if(!repaired)assert.equal(run.result,null);
 }
});
test('Independent writers see only their own materials; comparison runs separately on permitted endpoints',async()=>{
 for(const rejectComparison of [false,true]){
 const ids=fixture(),r=weekly.requestWeeklyReview(at);let writes=0,comparisons=0;
 await weekly.processWeekly(claim()!,async(system,prompt)=>{
  const c=JSON.parse(prompt);
  if(system.startsWith('你为每周')){const get=(id:string)=>c.sources.find((s:any)=>s.id===id).passages[0].id;return {focus:[get(ids.first),get(ids.other)],links:[{from:get(ids.first),to:get(ids.other),relation:'compares',reason:'测试：不同问题中接力推理可对照'},{from:get(ids.independent),to:get(ids.thesis),relation:'compares',reason:'测试：未使用的候选，不应进入成品'}]};}
  if(system.startsWith('你比较不同交易思路')){comparisons++;assert.equal(c.sources.length,2);return {insights:[{text:'测试：待验证推理对照，不是同一笔交易',evidence_ids:c.sources.map((s:any)=>s.passages[0].id)}]};}
  if(system.includes('独立的交易思路核对者')){assert.equal(c.report.logic.length,2);assert.equal(c.report.insights.length,1);assert.equal(c.reviewPlan.links.length,1,'Unused candidate links do not enter report audit');return {rejected:rejectComparison?[{section:'insights',index:0,reason:'测试：把买入后表现误当作买入前提'},{section:'links',index:0,reason:'测试：比较关系依据不足'}]:[]};}
  writes++;assert.equal(c.sources.length,1);assert.equal(c.reviewPlan.groups.length,1);assert.equal(c.reviewPlan.links.length,0);
  return {focus:[],changes:[],unresolved:[],logic:[{situation_id:c.reviewPlan.groups[0].alias,title:'测试：独立的问题',basis:null,change:null,assessment:{text:'测试：仅根据当前材料',evidence_ids:[c.sources[0].passages[0].id]},next_check:null}]};
 });
 const run=db.one<any>('SELECT * FROM runs WHERE id=?',r.runId)!;assert.equal(run.status,rejectComparison?'partial':'succeeded',run.error);assert.equal(writes,2);assert.equal(comparisons,1);assert.equal(JSON.parse(run.result).reviewPlan.links.length,rejectComparison?0:1);assert.equal(JSON.parse(run.result).logic.length,2);assert.equal(JSON.parse(run.result).insights.length,rejectComparison?0:1);
 }
});
test.after(()=>{db.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true});});
