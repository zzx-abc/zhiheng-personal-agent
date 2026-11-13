import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Snapshot} from '../app/types';
import type {WorkingState} from '../server/working-state';
import {continuityItems,executionReceipt} from '../app/continuity-model';

process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-continuity-'));
process.env.AGENT_TEST_MODE='1';
const sql=await import('../server/db');
const store=await import('../server/store');
const {saveConfig}=await import('../server/config');
const {validateState}=await import('../server/working-state');
const {contextFor,claim}=await import('../server/engine');
const {beatWorker,workerStatus}=await import('../server/worker-status');
function reset(){
 for(const table of ['working_states','events','reports','evidence','memories','runs','records','tasks','topics','usage'])sql.exec(`DELETE FROM ${table}`);
 saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);
}
function fixture(kind:'official_search'|'market_data'|'user_material'|'discussion'='official_search'){
 const topic=store.createTopic('测试样例：订单兑现','测试：订单是否改善？');
 const record=store.addRecord('测试样例：我关注甲公司是因为订单可能改善，涨跌只是我的担心。',topic);
 const run=store.enqueue(record,'review');sql.exec("UPDATE runs SET status='succeeded' WHERE id=?",run);
 const state:WorkingState={thesis:{text:'测试：订单可能改善',owner:'user_hypothesis',sources:[record]},assessment:'测试：只有假设，尚未取得公告。',assumptions:[],evidence:[],open_questions:['测试：是否有实际订单披露'],change_conditions:[],next_action:{kind,question:'测试：甲公司最近披露了哪些订单？',reason:'测试：检查原判断的前提'},change_summary:'测试：建立待验证问题',decision_frame:{original_basis:{quote:'我关注甲公司是因为订单可能改善',source_id:record},evaluation_horizon:null,contemplated_change:null,change_trigger:null}};
 const version=sql.id();sql.exec('INSERT INTO working_states VALUES(?,?,?,?,?,?,?)',version,topic,run,'current',JSON.stringify(state),sql.now(),null);
 return {topic,record,run,version,state};
}
const snapshot=()=>store.snapshot() as unknown as Snapshot;

test('A version-bound check stays in its original fragment, records authorization, and deduplicates clicks',()=>{
 reset();const f=fixture();const other=store.capture('测试：完全独立的盘面观察',null);
 const result=store.continueState(f.version),again=store.continueState(f.version);
 assert.equal(result.runId,again.runId);assert.equal(again.reused,true);
 assert.equal(sql.one<any>('SELECT parent_id FROM record_context WHERE record_id=?',result.recordId)?.parent_id,f.record);
 const row=sql.one<any>('SELECT * FROM records WHERE id=?',result.recordId);assert.equal(row.kind,'action_request');assert.equal(row.topic_id,f.topic);
 assert.equal(sql.one<any>('SELECT topic_id FROM records WHERE id=?',other)?.topic_id,null);
 assert.equal(sql.one<any>('SELECT mode FROM runs WHERE id=?',result.runId)?.mode,'check');
 const event=sql.one<any>("SELECT detail FROM events WHERE run_id=? AND type='continuation_requested'",result.runId);
 assert.equal(JSON.parse(event.detail).stateId,f.version);
 assert.equal(sql.all('SELECT * FROM tasks').length,0,'one check is not automatic monitoring');
 assert.ok(!snapshot().cards.some(c=>JSON.parse(c.source_ids).includes(result.recordId)),'button requests are not personal memory cards');
});

test('Changed, paused, and non-executable suggestions cannot launch old or invented checks',()=>{
 reset();const f=fixture('user_material');assert.throws(()=>store.continueState(f.version),/个人信息/);
 sql.exec('UPDATE working_states SET content=? WHERE id=?',JSON.stringify({...f.state,next_action:{...f.state.next_action,kind:'market_data'}}),f.version);
 store.setTopicStatus(f.topic,'paused');assert.throws(()=>store.continueState(f.version),/暂停/);
 store.setTopicStatus(f.topic,'active');sql.exec("UPDATE working_states SET status='stale' WHERE id=?",f.version);
 assert.throws(()=>store.continueState(f.version),/已有更新/);assert.equal(sql.all('SELECT * FROM runs').length,1);
});

test('Correction immediately disables old state, cancels in-flight work, pauses old tasks, and survives reload',async()=>{
 reset();const f=fixture();const task=store.createTask(f.topic,'测试委托','测试：核实订单');const pending=store.continueState(f.version);
 const corrected=store.correctState(f.version,'测试：只是担心，不是我的交易规则。');
 assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',pending.runId)?.status,'cancelled');
 assert.equal(sql.one<any>('SELECT status FROM tasks WHERE id=?',task)?.status,'paused');
 assert.equal(sql.one<any>('SELECT status FROM working_states WHERE id=?',f.version)?.status,'stale');
 assert.throws(()=>store.continueState(f.version),/已有更新/);
 assert.equal(sql.one<any>('SELECT content FROM records WHERE id=?',f.record)?.content,'测试样例：我关注甲公司是因为订单可能改善，涨跌只是我的担心。');
 const {DatabaseSync}=await import('node:sqlite');const reopened=new DatabaseSync(path.join(process.env.AGENT_DATA_DIR!,'agent.sqlite'));
 assert.equal((reopened.prepare('SELECT kind FROM records WHERE id=?').get(corrected.recordId) as any).kind,'correction');reopened.close();
 const next=store.enqueue(corrected.recordId,'chat');const row=sql.one<any>('SELECT * FROM records WHERE id=?',corrected.recordId);
 const context=await contextFor(sql.one<any>('SELECT * FROM runs WHERE id=?',next)!,row,sql.one<any>('SELECT * FROM topics WHERE id=?',f.topic),[]);
 const packed=JSON.parse(context.context);assert.equal(packed.workingState,null);assert.ok(packed.memories.some((m:any)=>m.content.includes('不是我的交易规则')));
 const item=continuityItems(snapshot())[0];assert.equal(item.state,null);assert.ok(item.stale);
 assert.equal(sql.all('SELECT * FROM usage').length,0);
});

test('Pause stops both delegated and one-off work; resume does not silently restart anything',()=>{
 reset();const f=fixture();const task=store.createTask(f.topic,'测试委托','测试问题'),a=store.runTask(task);
 const rec=store.addRecord('测试另一个正在处理的问题',f.topic),b=store.enqueue(rec,'chat');
 store.setTopicStatus(f.topic,'paused');assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',a)?.status,'cancelled');assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',b)?.status,'cancelled');
 store.setTopicStatus(f.topic,'active');assert.equal(sql.one<any>('SELECT status FROM tasks WHERE id=?',task)?.status,'paused');assert.equal(sql.all("SELECT * FROM runs WHERE status='queued'").length,0);
 assert.throws(()=>store.setTopicStatus(sql.id(),'active'),/不存在/);
});

test('A generated check cannot become a personal principle or a quoted trading rationale',()=>{
 reset();const f=fixture(),request=store.continueState(f.version);
 const row=sql.one<any>('SELECT content FROM records WHERE id=?',request.recordId)!;
 assert.throws(()=>validateState({...f.state,decision_frame:{...f.state.decision_frame!,original_basis:{quote:row.content,source_id:request.recordId}}},new Set([f.record,request.recordId])),/用户原文/);
 assert.throws(()=>validateState({...f.state,thesis:{text:'测试伪造用户认可',owner:'user_hypothesis',sources:[request.recordId]}},new Set([f.record,request.recordId])),/用户原文/);
});

test('Receipt distinguishes completing an answer from checking external facts and preserves partial findings',()=>{
 reset();const f=fixture();let data=snapshot(),run=data.runs.find(r=>r.id===f.run)!;
 assert.equal(executionReceipt(data,run).checked,false);assert.equal(continuityItems(data)[0].status,'已梳理，尚未查证');
 sql.exec('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)',sql.id(),f.run,'测试披露','https://example.com/test','测试样例正文',null,sql.now(),'excerpt','fixture');
 sql.event(f.run,'research_finished',{status:'answered',missing:[]});
 sql.exec('UPDATE runs SET result=? WHERE id=?',JSON.stringify({evidence_sufficient:false}),f.run);
 data=snapshot();run=data.runs.find(r=>r.id===f.run)!;assert.equal(executionReceipt(data,run).checked,false);
 sql.exec("UPDATE runs SET status='partial',result=? WHERE id=?",JSON.stringify({evidence_sufficient:true,uncertainties:['测试：仍缺回款情况']}),f.run);
 data=snapshot();run=data.runs.find(r=>r.id===f.run)!;assert.equal(executionReceipt(data,run).checked,false);assert.equal(executionReceipt(data,run).externalCount,1);assert.equal(continuityItems(data)[0].status,'还缺证据');
 sql.exec("UPDATE runs SET status='succeeded' WHERE id=?",f.run);data=snapshot();assert.equal(executionReceipt(data,data.runs.find(r=>r.id===f.run)!).checked,true);
 const other=fixture();data=snapshot();assert.equal(executionReceipt(data,data.runs.find(r=>r.id===other.run)!).externalCount,0);
});

test('Manual delegated checks use the state source as an explicit reply, not a new merged topic fragment',()=>{
 reset();const f=fixture(),task=store.createTask(f.topic,'测试委托','测试：继续查订单'),run=store.runTask(task);
 const record=sql.one<any>('SELECT record_id FROM runs WHERE id=?',run)!.record_id;
 assert.equal(sql.one<any>('SELECT parent_id FROM record_context WHERE record_id=?',record)?.parent_id,f.record);
 assert.equal(store.runTask(task),run);
});
test('A queued or retried continuation cannot run after its premise was invalidated elsewhere',()=>{
 reset();const f=fixture(),pending=store.continueState(f.version);
 sql.exec("UPDATE working_states SET status='stale' WHERE id=?",f.version);
 assert.equal(claim(),undefined);assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',pending.runId)?.status,'stale');
 assert.throws(()=>store.enqueue(pending.recordId,'check'),/理解已更新/);
});
test('A legitimate retry retains the version binding and worker presence expires honestly',()=>{
 reset();const f=fixture(),pending=store.continueState(f.version);store.cancel(pending.runId);
 const retry=store.enqueue(pending.recordId,'check');
 assert.equal(JSON.parse(sql.one<any>("SELECT detail FROM events WHERE run_id=? AND type='continuation_requested'",retry)!.detail).stateId,f.version);
 sql.exec("DELETE FROM meta WHERE key='worker_heartbeat'");assert.equal(workerStatus().state,'unknown');
 beatWorker(100000);assert.equal(workerStatus(110000).state,'online');assert.equal(workerStatus(120000).state,'offline');
});
test.after(()=>{sql.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true})});
