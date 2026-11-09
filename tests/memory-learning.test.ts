// Synthetic cases test the persistence and feedback loop, not investment advice.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-learning-test-'));
const sql=await import('../server/db'),store=await import('../server/store'),learning=await import('../server/memory-learning');
const {saveConfig}=await import('../server/config');const {retrieve}=await import('../server/retrieval');
const {processRun,claim,contextFor}=await import('../server/engine');const {syncCards}=await import('../server/cards');
const reset=()=>{for(const t of ['working_states','events','reports','evidence','attachments','memories','runs','records','tasks','topics'])sql.exec(`DELETE FROM ${t}`);saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000)};
const record=(id:string)=>sql.one<any>('SELECT * FROM records WHERE id=?',id)!;
const answer={judgment:'测试：依据当前记录回答',reasons:[],uncertainties:[],next_step:''};
const plan=(extra:Record<string,unknown>={})=>({context_relation:'independent',memory_query:null,memory_reason:'',route:'chat',data_need:'none',review_required:false,understanding:'测试',first_help:'',focus:null,followup:null,pause_focus:false,reply:answer,...extra});
function tagEntity(id:string,name='甲公司'){learning.saveTags(record(id),[{kind:'entity',label:name,quote:name}]);}
function link(target:string,current_quote='想换仓',target_quote='关注甲公司是为了订单兑现'){return {source_id:target,relation:'basis' as const,reason:'测试：找回原始依据，不能据此认定现在仍持有',current_quote,target_quote,task:1,entity:1,question:1,validity:1};}
async function linked(){
 const target=store.capture('测试：关注甲公司是为了订单兑现',null,'note');tagEntity(target);
 const current=store.capture('测试：甲公司今天跌了，我有点想换仓',null);tagEntity(current);const run=store.enqueue(current,'auto');
 await processRun(claim()!,async(system,prompt)=>{
  if(system.includes('你先理解用户要完成的任务')){const c=JSON.parse(prompt.split('\n可接续')[0]);return plan(c.contextBoundary.historyRequested?{history_links:[link(target)]}:{});}
  assert.ok(prompt.includes('关注甲公司是为了订单兑现'));return {...answer,reasons:[{text:'测试：对照原文',sources:[target]}]};
 });
 assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',run)?.status,'succeeded');
 const relation=sql.one<any>('SELECT * FROM memory_links WHERE run_id=?',run)!;assert.ok(relation);
 return {target,current,run,relation};
}
test('Tags are automatic, sourced, and cannot invent holdings, horizons or psychological labels',()=>{
 reset();const id=store.capture('测试：关注甲公司是为了订单兑现',null,'note');
 assert.ok(learning.tagsFor([id]).some(t=>t.label==='原始依据'&&t.origin==='rule'));
 learning.saveTags(record(id),[{kind:'entity',label:'乙公司',quote:'甲公司'},{kind:'horizon',label:'长期',quote:'原文没有说过'},{kind:'theme',label:'冲动',quote:'关注甲公司'}]);
 assert.ok(!learning.tagsFor([id]).some(t=>['乙公司','长期','冲动'].includes(t.label)));
 tagEntity(id);assert.ok(learning.tagsFor([id]).some(t=>t.label==='甲公司'));
 assert.equal(sql.all('SELECT * FROM usage').length,0,'Local note tagging must not call a paid model');
});
test('Corrected tags survive reindexing and later model extraction; originals never change',()=>{
 reset();const id=store.capture('测试：我想换仓，尚未成交',null,'note');const old=learning.tagsFor([id]).find(t=>t.label==='考虑调整')!;
 learning.correctTag(old.id,'只是研究备选');syncCards();learning.saveTags(record(id),[{kind:'intent',label:'考虑调整',quote:'想换仓'}]);
 assert.ok(!learning.tagsFor([id]).some(t=>t.label==='考虑调整'));assert.ok(learning.tagsFor([id]).some(t=>t.label==='只是研究备选'&&t.origin==='user'));
 assert.equal(record(id).content,'测试：我想换仓，尚未成交');assert.equal(sql.all('SELECT * FROM tag_feedback').length,1);
});
test('Adjustment intent proactively retrieves a baseline without asking the user to request history',async()=>{
 reset();const {target,current,run}=await linked();
 assert.ok(sql.one("SELECT id FROM events WHERE run_id=? AND type='memory_requested'",run));
 assert.equal(record(current).topic_id,null);assert.equal(sql.one<any>('SELECT root_id FROM record_context WHERE record_id=?',current)?.root_id,current);
 assert.equal(sql.one<any>('SELECT status FROM memory_links WHERE run_id=?',run)?.status,'proposed');
 const selection=learning.selectedLinks(run)!;assert.equal(selection[0].source_id,target);
});
test('A rejected relationship changes the next prompt and search; identical tags never bypass it',async()=>{
 reset();const {target,current,relation}=await linked();learning.applyLinkFeedback(relation.id,'rejected','测试：这次是短线试仓，不是原来的那笔持仓');
 const next=store.capture('测试：甲公司又涨了，我仍想换仓',current);tagEntity(next);const key=store.enqueue(next,'auto');const run=claim()!;
 const result=await retrieve('甲公司 订单兑现 原始依据',null,key);assert.ok(!result.records.some(r=>r.id===target));
 sql.event(key,'memory_requested',{query:'甲公司 订单兑现',reason:'测试主动查找'});
 const c=JSON.parse((await contextFor(run,record(next),undefined,[])).context);
 assert.ok(!c.history.some((r:any)=>r.id===target));assert.ok(c.history.some((r:any)=>r.id===current&&r.relationToCurrent==='reply_chain'&&r.text.includes('今天跌了')));assert.ok(c.relationshipFeedback.some((f:any)=>f.note.includes('短线试仓')));
 assert.deepEqual(learning.validateLinks(record(next),[link(target)],new Set([target])),[]);
 store.cancel(key);
 const {DatabaseSync}=await import('node:sqlite');const other=new DatabaseSync(path.join(process.env.AGENT_DATA_DIR!,'agent.sqlite'));assert.equal((other.prepare('SELECT status FROM memory_links WHERE id=?').get(relation.id) as any).status,'rejected');other.close();
});
test('Feedback transfers narrowly to similar tasks, not every future question about the same stock',async()=>{
 reset();const {target,relation}=await linked();learning.applyLinkFeedback(relation.id,'rejected','测试：不是同一笔');
 const similar=store.capture('测试：甲公司我想换仓',null);tagEntity(similar);
 assert.equal(learning.feedbackWeight(similar,target),.45);assert.ok(!learning.blockedSources(similar).has(target),'Independent situation is a warning, not a permanent ban');
 const other=store.capture('测试：甲公司的财报术语是什么意思',null);tagEntity(other);assert.equal(learning.feedbackWeight(other,target),1);
 learning.applyLinkFeedback(relation.id,'confirmed');assert.equal(learning.feedbackWeight(similar,target),1.15);
 learning.applyLinkFeedback(relation.id,'proposed');assert.equal(learning.feedbackWeight(similar,target),1);assert.equal(sql.all('SELECT * FROM link_feedback').length,3);
});
test('Changing a tag invalidates the old cross-fragment matching signature',async()=>{
 reset();const {target,current,relation}=await linked();learning.applyLinkFeedback(relation.id,'confirmed');
 const similar=store.capture('测试：甲公司我想换仓',null);tagEntity(similar);assert.equal(learning.feedbackWeight(similar,target),1.15);
 const entity=learning.tagsFor([current]).find(t=>t.kind==='entity')!;learning.correctTag(entity.id,'另一项独立观察');
 assert.equal(learning.feedbackWeight(similar,target),1);assert.equal(sql.one<any>('SELECT status FROM memory_links WHERE id=?',relation.id)?.status,'confirmed');
});

test('Association validation rejects fabricated quotes, wrong objects and low relevance',()=>{
 reset();const a=store.capture('测试：乙公司今天我想换仓',null),b=store.capture('测试：关注甲公司是为了订单兑现',null);tagEntity(a,'乙公司');tagEntity(b);
 assert.deepEqual(learning.validateLinks(record(a),[link(b)],new Set([b])),[]);
 const c=store.capture('测试：甲公司今天我想换仓',null);tagEntity(c);
 assert.deepEqual(learning.validateLinks(record(c),[{...link(b),target_quote:'伪造原话'}],new Set([b])),[]);
 assert.deepEqual(learning.validateLinks(record(c),[{...link(b),task:0}],new Set([b])),[]);
 assert.equal(learning.validateLinks(record(c),[link(b)],new Set([b])).length,1);
});
test('Natural relationship correction updates persistent feedback before answering',async()=>{
 reset();const {current,relation,target}=await linked();const rec=store.capture('测试：这个关联不对，不是同一件事',current),key=store.enqueue(rec,'auto');let final=false;
 await processRun(claim()!,async(system,prompt)=>{
  if(system.includes('你先理解用户要完成的任务'))return plan({context_relation:'continue',link_feedback:{id:relation.id,decision:'rejected',quote:'这个关联不对，不是同一件事',note:'测试：不是同一件事'}});
  final=true;assert.ok(prompt.includes('relationshipFeedback'));assert.ok(!JSON.parse(prompt.split('\n程序执行回执')[0]).history.some((r:any)=>r.id===target));return answer;
 });
 assert.ok(final);assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',key)?.status,'succeeded');assert.equal(sql.one<any>('SELECT status FROM memory_links WHERE id=?',relation.id)?.status,'rejected');
});
test('Explicit revisiting can retrieve a rejected source without erasing the earlier correction',async()=>{
 reset();const {target,current,relation}=await linked();learning.applyLinkFeedback(relation.id,'rejected','测试：别当成同一笔');
 const next=store.capture('测试：我想找回那条甲公司订单原话，重新比较',current);const key=store.enqueue(next,'auto');
 const found=await retrieve('甲公司 订单兑现',null,key);assert.ok(found.records.some(r=>r.id===target));
 assert.ok(learning.relationContext(next).some(f=>f.status==='rejected'));
 store.cancel(key);
});
test('An interrupted answer cannot persist model relationship proposals as learned facts',async()=>{
 reset();const target=store.capture('测试：关注甲公司是为了订单兑现',null,'note');tagEntity(target);
 const current=store.capture('测试：甲公司我想换仓',null);tagEntity(current);const key=store.enqueue(current,'auto');
 await processRun(claim()!,async(system,prompt)=>{
  if(system.includes('你先理解用户要完成的任务'))return plan(JSON.parse(prompt.split('\n可接续')[0]).contextBoundary.historyRequested?{history_links:[link(target)]}:{});
  throw Error('TEST_INTERRUPTED');
 });
 assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',key)?.status,'failed');assert.equal(sql.all('SELECT * FROM memory_links').length,0);
});

test('Deleting a source removes tags, associations and feedback that refer to it',async()=>{
 reset();const {target,relation}=await linked();learning.applyLinkFeedback(relation.id,'confirmed');store.deleteRecord(target);
 assert.equal(sql.all('SELECT * FROM record_tags WHERE record_id=?',target).length,0);assert.equal(sql.all('SELECT * FROM memory_links').length,0);assert.equal(sql.all('SELECT * FROM link_feedback').length,0);
});
test.after(()=>{sql.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true})});
