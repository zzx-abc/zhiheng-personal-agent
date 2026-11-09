// Synthetic fixtures exercise real persistence and context assembly; no paid model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-fragment-test-'));
const sql=await import('../server/db');
const store=await import('../server/store');
const {saveConfig}=await import('../server/config');
const {processRun,claim,contextFor}=await import('../server/engine');
const {captureContext}=await import('../server/conversation-context');
const answer={judgment:'测试样例：只回答当前问题',reasons:[],uncertainties:[],next_step:''};
const plan=(extra:Record<string,unknown>={})=>({context_relation:'independent',memory_query:null,memory_reason:'',route:'chat',data_need:'none',review_required:false,understanding:'测试：本次任务',first_help:'',focus:null,followup:null,pause_focus:false,reply:answer,...extra});
const reset=()=>{for(const t of ['working_states','events','reports','evidence','attachments','memories','runs','records','tasks','topics'])sql.exec(`DELETE FROM ${t}`);saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000)};
function current(id:string){return sql.one<any>('SELECT * FROM records WHERE id=?',id)!}
function result(run:string){const r=sql.one<any>('SELECT * FROM runs WHERE id=?',run)!;assert.equal(r.status,'succeeded',r.error);return r}

test('Independent captures and legacy same-topic records retain separate identities across reopen',async()=>{
 reset();const topic=store.createTopic('测试同一公司');
 const old1=store.addRecord('测试旧片段一',topic),old2=store.addRecord('测试旧片段二',topic);
 const a=store.capture('测试：今早盘面',null,'note'),b=store.capture('测试：行业订单',null,'note');
 const reply=store.capture('测试：对上一条补充',a,'note');
 const rows=store.snapshot().records as any[];
 for(const id of [old1,old2,a,b])assert.equal(rows.find(r=>r.id===id).fragment_id,id);
 assert.equal(rows.find(r=>r.id===reply).fragment_id,a);
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(process.env.AGENT_DATA_DIR!,'agent.sqlite'));
 assert.equal((db.prepare('SELECT parent_id FROM record_context WHERE record_id=?').get(reply) as any).parent_id,a);db.close();
 assert.throws(()=>store.capture('测试：已删除的对象','missing'),/不存在/);
});

test('A new market overview has no old holdings, recent unfiled notes, or global thesis in any prompt',async()=>{
 reset();store.addRecord('PRIVATE_OLD_HOLDING_A_AND_B',null);store.addMemory('PRIVATE_OLD_THESIS','view',null);
 const topic=store.createTopic('PRIVATE_TOPIC');store.addRecord('PRIVATE_TOPIC_RECORD',topic);
 const rec=store.capture('测试：分析今天早上的盘面并记录',null),key=store.enqueue(rec,'auto');let calls=0;
 await processRun(claim()!,async(_system,prompt)=>{calls++;assert.ok(!prompt.includes('PRIVATE_'));const c=JSON.parse(prompt.split('\n可接续')[0]);assert.equal(c.history.length,0);return plan()});
 result(key);assert.equal(calls,1);assert.equal(current(rec).topic_id,null);
 assert.equal(sql.all("SELECT id FROM events WHERE run_id=? AND type='memory_retrieved'",key).length,0);
});

test('An explicit reply sees its parent and answer, never an unrelated adjacent fragment',async()=>{
 reset();const parent=store.capture('TEST_PARENT_BASIS',null);const first=store.enqueue(parent,'auto');
 await processRun(claim()!,async()=>plan({reply:{...answer,judgment:'TEST_PARENT_ANSWER'}}));result(first);
 store.capture('UNRELATED_ADJACENT_FRAGMENT',null,'note');
 const rec=store.capture('测试：你刚才的判断依据是什么？',parent),key=store.enqueue(rec,'auto');
 await processRun(claim()!,async(_system,prompt)=>{assert.ok(prompt.includes('TEST_PARENT_BASIS'));assert.ok(prompt.includes('TEST_PARENT_ANSWER'));assert.ok(!prompt.includes('UNRELATED_ADJACENT_FRAGMENT'));return plan({context_relation:'continue'})});
 result(key);assert.equal(captureContext(rec)?.root_id,parent);
});

test('A new task typed inside a discussion separates before final answering and never updates its old focus',async()=>{
 reset();const topic=store.createTopic('测试旧换仓问题'),parent=store.capture('PRIVATE_OLD_HOLDING',null);
 sql.exec('UPDATE records SET topic_id=? WHERE id=?',topic,parent);
 const rec=store.capture('测试：分析今早整个市场，不是我的持仓',parent),key=store.enqueue(rec,'auto');let answered=false;
 const pendingReply=store.capture('测试：请再补充一下这个新问题',rec,'note'),sibling=store.capture('测试：另一个旧讨论的追问',parent,'note');
 await processRun(claim()!,async(system,prompt)=>{
  if(system.includes('你先理解用户要完成的任务'))return plan();
  answered=true;assert.ok(!prompt.includes('PRIVATE_OLD_HOLDING'));assert.ok(!prompt.includes('测试旧换仓问题'));return answer;
 });
 result(key);assert.ok(answered);assert.equal(current(rec).topic_id,null);assert.equal(captureContext(rec)?.parent_id,null);assert.equal(captureContext(rec)?.root_id,rec);
 assert.equal(captureContext(pendingReply)?.root_id,rec);assert.equal(captureContext(sibling)?.root_id,parent);
});

test('Explicit recall retrieves sources without merging fragments or rewriting an old topic',async()=>{
 reset();const topic=store.createTopic('测试旧公司'),original=store.capture('测试：青杉设备当时关注的是订单质量，不是数量',null,'note');
 sql.exec('UPDATE records SET topic_id=? WHERE id=?',topic,original);store.capture('UNRELATED_PRICE',null,'note');
 const rec=store.capture('测试：我之前为什么关注青杉设备？',null),key=store.enqueue(rec,'auto');let recalled=false;
 await processRun(claim()!,async(system,prompt)=>{
  const c=JSON.parse(prompt.split('\n可接续')[0].split('\n程序执行回执')[0]);
  if(system.includes('你先理解用户要完成的任务')){
   if(c.contextBoundary.historyRequested){recalled=true;assert.ok(prompt.includes('订单质量'));return plan();}
   assert.ok(!prompt.includes('订单质量'));return plan({memory_query:'青杉设备 订单质量',memory_reason:'找回用户当时关注的依据'});
  }
  assert.ok(prompt.includes(original));assert.ok(!prompt.includes('UNRELATED_PRICE'));return {...answer,reasons:[{text:'测试：依据原话',sources:[original]}]};
 });
 result(key);assert.ok(recalled);assert.equal(current(rec).topic_id,null);assert.equal(captureContext(rec)?.root_id,rec);assert.equal(captureContext(original)?.root_id,original);
});

test('A model cannot attach an unseen focus; identical new focus titles are not a merge key',async()=>{
 reset();const old=store.createTopic('测试同名关注'),rec=store.capture('测试：我想持续验证新的独立假设',null),key=store.enqueue(rec,'auto');
 await processRun(claim()!,async system=>system.includes('你先理解用户要完成的任务')?plan({focus:{id:null,title:'测试同名关注',question:'测试新假设',quote:'我想持续验证新的独立假设'}}):answer);result(key);assert.notEqual(current(rec).topic_id,old);
 const bad=store.capture('测试：独立观察',null),badRun=store.enqueue(bad,'auto');
 await processRun(claim()!,async()=>plan({focus:{id:old,title:'测试同名关注',question:'测试',quote:'独立观察'}}));
 assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',badRun)?.status,'failed');assert.equal(current(bad).topic_id,null);
});

test('A reply queued before its parent finishes can continue the newly established focus',async()=>{
 reset();const parent=store.capture('测试：我想持续验证订单',null),reply=store.capture('测试：继续这个问题',parent);
 const topic=store.createTopic('测试新建立的关注');sql.exec('UPDATE records SET topic_id=? WHERE id=?',topic,parent);
 const key=store.enqueue(reply,'auto');let final=false;
 await processRun(claim()!,async(system,prompt)=>{
  if(system.includes('你先理解用户要完成的任务'))return plan({context_relation:'continue'});
  final=true;assert.ok(prompt.includes('测试新建立的关注'));return answer;
 });
 result(key);assert.ok(final);assert.equal(current(reply).topic_id,topic);
});

test('Deleting a parent leaves surviving originals accessible as independent fragments',()=>{
 reset();const a=store.capture('测试父片段',null,'note'),b=store.capture('测试子片段',a,'note');store.deleteRecord(a);
 assert.equal(current(b).content,'测试子片段');assert.equal(captureContext(b)?.parent_id,null);assert.equal((store.snapshot().records as any[]).find(r=>r.id===b).fragment_id,b);
});
test.after(()=>{sql.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true})});
