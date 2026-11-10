// Labelled synthetic scenarios; never uses real investment records or APIs.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-logic-test-'));
const db=await import('../server/db'),store=await import('../server/store');
const {saveConfig}=await import('../server/config');
const {weeklyContext,weeklyEvidence,validateWeekly,requestWeeklyReview,processWeekly}=await import('../server/weekly-review');
const {validateState,saveState,currentState}=await import('../server/working-state');
const {selectDecisionRecords}=await import('../server/decision-context');
const {claim,contextFor}=await import('../server/engine');
const at=new Date('2026-11-10T04:00:00Z');
function reset(){for(const t of ['weekly_reviews','working_states','runs','records','topics'])db.exec(`DELETE FROM ${t}`);saveConfig('TEST-NOT-A-REAL-KEY','kimi-k3',1000000);}
function record(text:string,parent:string|null=null,time='2026-11-09T04:00:00Z'){const key=store.capture('测试样例：'+text,parent,'note');db.exec('UPDATE records SET created_at=? WHERE id=?',time,key);return key;}
const quote=(source_id:string,quote:string)=>({source_id,quote});
function state(source:string){return {thesis:{text:'测试：等待订单兑现',sources:[source],owner:'user_hypothesis' as const},assessment:'测试：尚未核实',assumptions:[],evidence:[],change_conditions:[],open_questions:[],next_action:null,change_summary:'测试：记录依据',decision_frame:{original_basis:quote(source,'等待订单兑现'),evaluation_horizon:null,contemplated_change:null,change_trigger:null}};}
test('Logic update cannot invent actions, manufacture before/after, or reverse chronology',()=>{
 reset();const a=record('等待订单兑现',null,'2026-11-08T04:00:00Z'),b=record('只想调整，尚未成交',a);
 validateState({...state(a),decision_frame:{...state(a).decision_frame,reported_action:quote(b,'尚未成交')},logic_change:{kind:'unresolved',summary:'测试：待分清调整依据',before:quote(a,'等待订单兑现'),after:quote(b,'只想调整')}},new Set([a,b]));
 assert.throws(()=>validateState({...state(a),decision_frame:{...state(a).decision_frame,reported_action:quote(b,'已经买入')}},new Set([a,b])),/逐字/);
 assert.throws(()=>validateState({...state(a),logic_change:{kind:'plan_change',summary:'测试',before:null,after:quote(b,'只想调整')}},new Set([a,b])),/前后/);
 assert.throws(()=>validateState({...state(a),logic_change:{kind:'plan_change',summary:'测试',before:quote(b,'只想调整'),after:quote(a,'等待订单兑现')}},new Set([a,b])),/时间/);
});
test('Stored correction replaces the current frame and is present on subsequent dialogue',async()=>{
 reset();const topic=store.createTopic('测试：订单验证'),a=record('等待订单兑现');db.exec('UPDATE records SET topic_id=? WHERE id=?',topic,a);
 store.enqueue(a,'chat');let r=claim()!;saveState(r,state(a),new Set([a]));db.exec("UPDATE runs SET status='succeeded' WHERE id=?",r.id);
 const b=record('观察两季不是持有承诺，我未成交',a);store.enqueue(b,'chat');r=claim()!;
 const changed={...state(a),decision_frame:{...state(a).decision_frame,evaluation_horizon:quote(b,'观察两季不是持有承诺'),reported_action:quote(b,'我未成交')},logic_change:{kind:'correction' as const,summary:'测试：修正持有承诺',before:null,after:quote(b,'观察两季不是持有承诺')}};
 saveState(r,changed,new Set([a,b]));db.exec("UPDATE runs SET status='succeeded' WHERE id=?",r.id);
 const c=record('现在我是什么计划？',b);store.enqueue(c,'chat');r=claim()!;
 const context=JSON.parse((await contextFor(r,db.one<any>('SELECT * FROM records WHERE id=?',c)!,db.one<any>('SELECT * FROM topics WHERE id=?',topic),[])).context);
 assert.equal(context.workingState.decision_frame.reported_action.quote,'我未成交');assert.match(currentState(topic)!.content,/不是持有承诺/);
 const cards=store.snapshot().cards;assert.ok(cards.some(c=>c.kind==='reported_action'&&c.body==='我未成交'&&c.status==='active'));
 const {lexicalCards}=await import('../server/cards');assert.ok(lexicalCards('本人报告 行动 未成交').some(c=>c.kind==='reported_action'&&JSON.parse(c.source_ids).includes(b)));
 store.deleteRecord(b);assert.equal(currentState(topic),undefined);
});
test('Weekly context retains prior basis, latest correction and long-record ending without grouping same-stock trades',async()=>{
 reset();const a=record('甲公司等待订单兑现',null,'2026-10-30T04:00:00Z'),b=record('今天担心甲公司下跌。'+'补充背景。'.repeat(500)+'这不是我的规则，也没有成交。',a),c=record('甲公司另一笔短线，仅研究，不沿用原订单依据');
 const review=requestWeeklyReview(at),context=await weeklyContext(db.one<any>('SELECT * FROM weekly_reviews WHERE id=?',review.reviewId)!);
 assert.ok(context.sources.some(s=>s.id===a));assert.match(context.sources.find(s=>s.id===b)!.text,/也没有成交/);
 assert.notEqual(context.sources.find(s=>s.id===b)!.situation_id,context.sources.find(s=>s.id===c)!.situation_id);
 const {catalog}=weeklyEvidence(context);for(const item of catalog.values())assert.ok(db.one<any>('SELECT content FROM records WHERE id=?',item.source_id).content.includes(item.quote));
});
test('Sampling preserves a long discussion start and latest correction under a hard limit',()=>{
 reset();let parent:string|null=null;const ids:string[]=[];
 for(let i=0;i<50;i++){parent=record('讨论'+i,parent,new Date(Date.parse('2026-11-04T00:00:00Z')+i*3600000).toISOString());ids.push(parent);}
 const rows=db.all<any>('SELECT * FROM records ORDER BY created_at');const selected=selectDecisionRecords(rows);
 assert.equal(selected.length,30);assert.ok(selected.some(r=>r.id===ids[0]));assert.ok(selected.some(r=>r.id===ids.at(-1)));
});
test('Cross-discussion reasoning links are rejected even when both citations are real',()=>{
 const sources=[{id:'a',situation_id:'a',text:'甲公司看订单',date:'2026-11-01',kind:'note',scope:'period' as const,excerpted:false},{id:'b',situation_id:'b',text:'甲公司另一笔短线',date:'2026-11-02',kind:'note',scope:'period' as const,excerpted:false}];
 assert.throws(()=>validateWeekly({focus:[],changes:[],unresolved:[],logic:[{situation_id:'a',title:'测试：错误合并',basis:{text:'订单',citations:[quote('a','甲公司看订单')]},change:null,assessment:{text:'转短线',citations:[quote('b','甲公司另一笔短线')]},next_check:null}]},sources),/不同讨论/);
});
test('Quarterly observation cannot become a medium/long-term trade label in the title',()=>{
 const sources=[{id:'a',situation_id:'a',text:'观察两个季度，仅验证订单，不是持有承诺',date:'2026-11-01',kind:'note',scope:'period' as const,excerpted:false}];
 assert.throws(()=>validateWeekly({focus:[],changes:[],unresolved:[],logic:[{situation_id:'a',title:'订单兑现（中长线思路）',basis:null,change:null,assessment:{text:'测试：订单待验证',citations:[quote('a','观察两个季度')]},next_check:null}]},sources),/交易周期/);
});
test('An explicit correction needs one genuine statement, but a claimed plan change needs both versions',()=>{
 const sources=[{id:'a',situation_id:'a',text:'观察两季不是持有承诺',date:'2026-11-01',kind:'note',scope:'period' as const,excerpted:false}];
 const correction={kind:'correction',text:'测试：纠正观察期限的含义',citations:[quote('a','观察两季不是持有承诺')]};
 const logic={situation_id:'a',title:'测试：验证窗口',basis:null,change:correction,assessment:{text:'测试：未承诺持有',citations:correction.citations},next_check:null};
 assert.equal(validateWeekly({focus:[],changes:[],unresolved:[],logic:[logic]},sources).logic[0].change?.kind,'correction');
 assert.throws(()=>validateWeekly({focus:[],changes:[],unresolved:[],logic:[{...logic,change:{...correction,kind:'plan_change'}}]},sources),/前后两条/);
});
test('No execution is not proof of no plan change',()=>{
 const sources=[{id:'a',situation_id:'a',text:'我没有实际换仓',date:'2026-11-01',kind:'note',scope:'period' as const,excerpted:false}];
 assert.throws(()=>validateWeekly({focus:[],changes:[],unresolved:[],logic:[{situation_id:'a',title:'测试：行动与计划',basis:null,change:null,assessment:{text:'用户未实际换仓，故不存在计划改变。',citations:[quote('a','我没有实际换仓')]},next_check:null}]},sources),/计划没有改变/);
});
test('Semantic audit blocks a sourced but misleading review instead of saving it as success',async()=>{
 reset();const a=record('只想调整，尚未成交'),review=requestWeeklyReview(at);let calls=0;
 await processWeekly(claim()!,async(_system,prompt)=>{calls++;if(calls===2)return {rejected:[{index:0,reason:'测试：把想法错误写成了成交'}]};const s=JSON.parse(prompt).sources.find((s:any)=>s.id===a);return {focus:[],changes:[],unresolved:[],logic:[{situation_id:a,title:'测试样例',basis:null,change:null,assessment:{text:'测试错误：已成交',evidence_ids:[s.passages[0].id]},next_check:null}]};});
 const result=db.one<any>('SELECT * FROM runs WHERE id=?',review.runId)!;assert.equal(calls,2);assert.equal(result.status,'failed');assert.equal(result.result,null);assert.match(result.error,/核对发现/);
});
test.after(()=>{db.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true});});
