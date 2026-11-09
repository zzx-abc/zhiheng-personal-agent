// Test transports are explicit fixtures only. No fixture is used by the app or worker.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-test-'));
process.env.MOONSHOT_API_KEY='';
const store=await import('../server/store');
const sql=await import('../server/db');
const {deliberate,claim,processRun}=await import('../server/engine');
const {assertCitations}=await import('../server/model');
const {safePublicUrl}=await import('../server/security');
const {saveConfig,publicConfig}=await import('../server/config');
const reset=()=>{for(const t of ['attachments','reports','evidence','events','runs','tasks','memories','records','topics','usage'])sql.exec(`DELETE FROM ${t}`);saveConfig('','kimi-k2.6',1000000);};
test('Missing API blocks execution, but preserves user input and never invents a response',()=>{reset();const rec=store.addRecord('我想了解收入与订单的区别',null);const run=store.enqueue(rec,'review');assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',run)?.status,'blocked');assert.equal(sql.all('SELECT * FROM reports').length,0);assert.equal(sql.all('SELECT * FROM records').length,1);assert.equal(publicConfig().configured,false);assert.equal(JSON.stringify(store.snapshot()).includes('apiKey'),false)});
test('Follow-up has real manual trigger and repeated click is idempotent',()=>{reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k2.6',1000000);const topic=store.createTopic('甲公司','需求有没有改善');const task=store.createTask(topic,'订单质量','检查甲公司的需求改善证据');const a=store.runTask(task),b=store.runTask(task);assert.equal(a,b);assert.equal(sql.all('SELECT * FROM runs').length,1);assert.equal(sql.one<{trigger:string}>('SELECT trigger FROM tasks WHERE id=?',task)?.trigger,'manual');const first=claim();assert.equal(first?.id,a);assert.equal(claim(),undefined)});
test('Pausing a task cancels its execution and prevents new runs',()=>{reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k2.6',1000000);const topic=store.createTopic('甲公司');const task=store.createTask(topic,'跟进','查甲公司');const run=store.runTask(task);store.pauseTask(task,'paused');assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',run)?.status,'cancelled');assert.throws(()=>store.runTask(task),/不可执行/)});
test('Explicit correction withdraws old rule, stores original correction and invalidates old interpretation',()=>{reset();const topic=store.createTopic('甲公司');const memory=store.addMemory('必须等价格上涨才买','principle',topic);const oldRevision=sql.revision();store.correctMemory(memory,'这只是当时的担心，不是我的交易规则');assert.equal(sql.one<{status:string}>('SELECT status FROM memories WHERE id=?',memory)?.status,'withdrawn');assert.ok(sql.revision()>oldRevision);const correction=sql.one<{source_id:string;content:string}>("SELECT * FROM memories WHERE kind='correction'")!;assert.equal(sql.one<{content:string}>('SELECT content FROM records WHERE id=?',correction.source_id)?.content,correction.content)});
test('Independent reviewers cannot see each other before leader synthesis',async()=>{reset();const seen:{system:string;prompt:string}[]=[];const report={judgment:'明确标注的测试结果',reasons:[{text:'测试依据',sources:['source-1']}],uncertainties:[],next_step:''};const call=async(system:string,prompt:string)=>{seen.push({system,prompt});return system.includes('你是用户唯一面对的 Leader')?{...report,agreement:'测试共识',disagreement:'测试分歧',memory_candidates:[],withdraw_memory_ids:[]}:report};const saved:string[]=[];const fixture=JSON.stringify({current:{id:'source-1',text:'TEST_FIXTURE'}});await deliberate(call,fixture,new Set(['source-1']),[],name=>saved.push(name));assert.equal(seen.length,3);assert.equal(seen[0].prompt,fixture);assert.equal(seen[1].prompt,fixture);assert.ok(JSON.parse(seen[2].prompt).analysis);assert.ok(JSON.parse(seen[2].prompt).challenge);assert.deepEqual(saved,['analysis','challenge','leader'])});
test('Invented citation fails closed',()=>{assert.throws(()=>assertCitations({reasons:[{text:'测试',sources:['invented']}]} ,new Set(['real'])),/未提供的来源/)});
test('Reviewer failure does not silently become successful leader consensus',async()=>{let leaderCalled=false;const call=async(s:string)=>{if(s.includes('质疑 Agent'))throw Error('TEST_FAILURE');if(s.includes('你是用户唯一面对的 Leader'))leaderCalled=true;return {judgment:'测试',reasons:[],uncertainties:[],next_step:''}};await assert.rejects(deliberate(call,'TEST',new Set(),[],()=>{}),/TEST_FAILURE/);assert.equal(leaderCalled,false)});
test('Budget retry resumes completed independent reviews without paying for them again',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);
 const rec=store.addRecord('测试样例：只验证断点接续',null),key=store.enqueue(rec,'review');
 const report={judgment:'测试审议',reasons:[{text:'测试来源',sources:[rec]}],uncertainties:[],next_step:''};
 for(const agent of ['analysis','challenge'])sql.exec('INSERT INTO reports VALUES(?,?,?,?,?)',sql.id(),key,agent,JSON.stringify(report),sql.now());
 sql.exec("UPDATE runs SET status='failed',error='本机月度预算不足' WHERE id=?",key);
 assert.equal(store.enqueue(rec,'review'),key);let calls=0;
 await processRun(claim()!,async system=>{calls++;assert.ok(system.includes('Leader'));return {...report,working_state:null,memory_candidates:[],withdraw_memory_ids:[]}});
 assert.equal(calls,1);assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',key)?.status,'succeeded');assert.equal(sql.all('SELECT * FROM reports WHERE run_id=?',key).length,3);
});
test('A queued review checkpoint cannot survive a background correction',()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);const rec=store.addRecord('测试样例',null),key=store.enqueue(rec,'review');
 sql.exec('INSERT INTO reports VALUES(?,?,?,?,?)',sql.id(),key,'analysis','{}',sql.now());sql.bump();assert.equal(claim(),undefined);assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',key)?.status,'stale');
});
test('Official-source allowlist rejects loopback, misleading domains and credential URLs',()=>{assert.equal(safePublicUrl('https://static.cninfo.com.cn/a.pdf'),true);for(const u of ['http://cninfo.com.cn','https://127.0.0.1','https://cninfo.com.cn.evil.test','https://user:pass@cninfo.com.cn','https://cninfo.com.cn:8443/a'])assert.equal(safePublicUrl(u),false)});
test('Chinese recall preserves original wording and topic association',()=>{reset();const t=store.createTopic('甲公司');const a=store.addRecord('上次主要担心订单质量，不是数量',t);store.addRecord('乙公司新产品发布',null);const results=store.searchHistory('订单到底改善了吗',t);assert.equal(results[0].id,a);assert.equal(results[0].content,'上次主要担心订单质量，不是数量')});
test('Deleting evidence removes attachments, dependent memories and derived output',()=>{reset();const rec=store.addRecord('需要删除的私人表达',null);const file=path.join(process.env.AGENT_DATA_DIR!,'fixture.png');writeFileSync(file,'TEST_FIXTURE');sql.exec('INSERT INTO attachments VALUES(?,?,?,?,?,?)',sql.id(),rec,'fixture','image/png',12,file);const at=sql.now();sql.exec('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)',sql.id(),null,'view','旧归纳','active',rec,'私人表达',at,at,null);store.addRecord('派生内容',null,'analysis','assistant');store.deleteRecord(rec);assert.equal(sql.all('SELECT * FROM memories').length,0);assert.equal(sql.all('SELECT * FROM records').length,0);assert.equal(existsSync(file),false)});
test('Runtime data survives independent database connection',async()=>{reset();store.addRecord('跨日期保存测试',null);const {DatabaseSync}=await import('node:sqlite');const other=new DatabaseSync(path.join(process.env.AGENT_DATA_DIR!,'agent.sqlite'));assert.equal((other.prepare('SELECT COUNT(*) AS n FROM records').get() as {n:number}).n,1);other.close()});
test('Full pipeline persists independently reviewed result and literal personal preference',async()=>{reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k2.6',1000000);const t=store.createTopic('测试公司');const rec=store.addRecord('我希望回答简短一些',t);const runId=store.enqueue(rec,'review');const run=claim()!;const call=async()=>({judgment:'测试样例结果',reasons:[{text:'测试依据',sources:[rec]}],uncertainties:[],next_step:'',agreement:'测试共识',disagreement:'',memory_candidates:[{kind:'preference',content:'简短回答',source_id:rec,quote:'我希望回答简短一些'}],withdraw_memory_ids:[]});await processRun(run,call);assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',runId)?.status,'succeeded');assert.equal(sql.all('SELECT * FROM reports').length,3);const m=sql.one<{status:string;content:string}>("SELECT * FROM memories WHERE kind='preference'")!;assert.equal(m.status,'active');assert.equal(m.content,'我希望回答简短一些')});
test('Correction during inference prevents stale results and memory resurrection',async()=>{reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k2.6',1000000);const t=store.createTopic('测试公司');const memory=store.addMemory('测试旧原则','principle',t);const rec=store.addRecord('测试：继续分析',t);const runId=store.enqueue(rec,'review');const run=claim()!;let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve});const call=async()=>{await waiting;return {judgment:'测试旧结果',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]}};const pending=processRun(run,call);store.correctMemory(memory,'测试纠正：不是我的原则');release();await pending;assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',runId)?.status,'stale');assert.equal(sql.all('SELECT * FROM reports').length,0);assert.equal(sql.all("SELECT * FROM records WHERE role='assistant'").length,0);assert.equal(sql.one<{status:string}>('SELECT status FROM memories WHERE id=?',memory)?.status,'withdrawn')});
test('Explicit cancellation during inference cannot publish a completed answer',async()=>{reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k2.6',1000000);const rec=store.addRecord('测试取消',null);const key=store.enqueue(rec,'chat');const run=claim()!;let release!:()=>void;const waiting=new Promise<void>(r=>release=r);const call=async()=>{await waiting;return {judgment:'测试结果',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]}};const pending=processRun(run,call);store.cancel(key);release();await pending;assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',key)?.status,'cancelled');assert.equal(sql.all("SELECT * FROM records WHERE role='assistant'").length,0)});
test('Backup command produces a restorable SQLite snapshot without credentials',async()=>{reset();store.addRecord('测试备份恢复内容',null);const output=execFileSync(process.execPath,['--import','tsx','scripts/backup.ts'],{cwd:process.cwd(),env:process.env,encoding:'utf8'});const target=output.trim().split('：').at(-1)!;const {DatabaseSync}=await import('node:sqlite');const restored=new DatabaseSync(path.join(target,'agent.sqlite'));assert.equal((restored.prepare('SELECT content FROM records').get() as {content:string}).content,'测试备份恢复内容');assert.equal(existsSync(path.join(target,'credentials.json')),false);restored.close();rmSync(target,{recursive:true,force:true})});
test.after(()=>{sql.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true})});

test('Auto intake creates a sourced focus, keeps user thesis conditional and completes independent review',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);
 const content='测试样例：我认为国产替代有可能成为未来2—4周的主线，请独立检验这个假设。';
 const rec=store.addRecord(content,null),runId=store.enqueue(rec,'auto');let seen=0;
 const call=async(system:string,prompt:string)=>{
  if(system.includes('你先理解用户要完成的任务'))return {route:'review',understanding:'测试：验证短期主线假设',first_help:'测试：长期份额提升不能独立证明短期资金行为。',focus:{id:null,title:'测试国产替代假设',question:'测试：未来2—4周能否成为主线？',quote:'国产替代有可能成为未来2—4周的主线'},followup:null,pause_focus:false,reply:null};
  seen++;assert.ok(prompt.includes('测试国产替代假设'));
  return {judgment:'测试：假设尚待证实',reasons:[{text:'测试原文明确表达可能性',sources:[rec]}],uncertainties:['测试资金证据缺失'],next_step:'测试需要核实',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]};
 };
 await processRun(claim()!,call);assert.equal(seen,3);
 const run=sql.one<{status:string;topic_id:string}>('SELECT status,topic_id FROM runs WHERE id=?',runId)!;
 assert.equal(run.status,'succeeded');assert.ok(run.topic_id);assert.equal(sql.one<{topic_id:string}>('SELECT topic_id FROM records WHERE id=?',rec)?.topic_id,run.topic_id);
 assert.equal(sql.all('SELECT * FROM reports').length,3);assert.equal(sql.all("SELECT * FROM memories WHERE kind='principle'").length,0);
});
test('Natural follow-up saves a manual task with source quote, without inventing background monitoring',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);const topic=store.createTopic('测试需求','测试需求是否改善');
 const rec=store.addRecord('测试：后面帮我继续跟进需求改善的公告',topic);store.enqueue(rec,'auto');
 const reply={judgment:'测试：委托已保存，点击检查才运行',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]};
 await processRun(claim()!,intakeFixture({route:'chat',understanding:'测试委托',first_help:'',focus:null,followup:{title:'测试查需求',question:'测试近期需求公告',quote:'后面帮我继续跟进需求改善的公告'},pause_focus:false,reply}));
 const tasks=sql.all<{trigger:string;last_run_id:string|null}>('SELECT trigger,last_run_id FROM tasks');assert.equal(tasks.length,1);assert.equal(tasks[0].trigger,'manual');assert.equal(tasks[0].last_run_id,null);
});
test('Automatic organization refuses a fabricated task quote and does not save a false promise',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);const topic=store.createTopic('测试关注');const rec=store.addRecord('测试：我只是想了解行业',topic);const run=store.enqueue(rec,'auto');
 await processRun(claim()!,intakeFixture({route:'chat',understanding:'测试',first_help:'',focus:null,followup:{title:'测试任务',question:'测试',quote:'用户没有说过的委托'},pause_focus:false,reply:null}));
 assert.equal(sql.all('SELECT * FROM tasks').length,0);assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',run)?.status,'failed');assert.equal(sql.all("SELECT * FROM records WHERE role='assistant'").length,0);
});
test('No-topic conversations do not import unrelated historical model conclusions',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);
 const first=store.addRecord('TEST_ORCHID_FLOWERING',null);const old=store.enqueue(first,'chat');
 await processRun(claim()!,async()=>({judgment:'UNRELATED_OLD_CONCLUSION',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]}));
 const next=store.addRecord('TEST_SEMICONDUCTOR',null);store.enqueue(next,'chat');
 await processRun(claim()!,async(_system,prompt)=>{assert.ok(!prompt.includes('UNRELATED_OLD_CONCLUSION'));return {judgment:'测试新问题',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]}});
 assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',old)?.status,'succeeded');
});
test('Explicit natural pause pauses related follow-ups, while keeping the acknowledgement valid',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);const topic=store.createTopic('测试方向');store.createTask(topic,'测试任务','测试问题');const rec=store.addRecord('先暂停这个方向，我现在只想观察，不准备买',topic);const run=store.enqueue(rec,'auto');
 await processRun(claim()!,intakeFixture({route:'chat',understanding:'测试暂停',first_help:'',focus:null,followup:null,pause_focus:true,reply:{judgment:'测试已暂停',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]}}));
 assert.equal(sql.one<{status:string}>('SELECT status FROM topics WHERE id=?',topic)?.status,'paused');assert.equal(sql.one<{status:string}>('SELECT status FROM tasks WHERE topic_id=?',topic)?.status,'paused');assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',run)?.status,'succeeded');
});

function intakeFixture(plan:any){return async(system:string)=>system.includes('你先理解用户要完成的任务')?plan:plan.reply;}
test('Rejoining a focus refreshes memory before answering and withdrawing an old rule',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);const topic=store.createTopic('测试旧议题','测试问题');const memory=store.addMemory('TEST_TOPIC_RULE','principle',topic);const rec=store.addRecord('上次那个判断，你理解错了，那不是我的交易规则',null);const run=store.enqueue(rec,'auto');let refreshed=false;
 const reply={judgment:'测试已纠正',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[memory]};
 await processRun(claim()!,async(system,prompt)=>{
  if(system.includes('你先理解用户要完成的任务'))return {history_links:[{source_id:sql.one<any>('SELECT source_id FROM memories WHERE id=?',memory)!.source_id,relation:'recall',reason:'测试：核对需要纠正的旧规则',current_quote:'不是我的交易规则',target_quote:'TEST_TOPIC_RULE',task:1,entity:1,question:1,validity:1}],memory_query:'TEST_TOPIC_RULE',memory_reason:'测试：找到需要纠正的旧理解',route:'chat',understanding:'测试接续',first_help:'',focus:{id:topic,title:'测试旧议题',question:'测试问题',quote:''},followup:null,pause_focus:false,reply:{...reply,withdraw_memory_ids:[]}};
  refreshed=true;assert.ok(prompt.includes('TEST_TOPIC_RULE'));return reply;
 });assert.ok(refreshed);assert.equal(sql.one<{status:string}>('SELECT status FROM memories WHERE id=?',memory)?.status,'withdrawn');assert.equal(sql.one<{status:string}>('SELECT status FROM runs WHERE id=?',run)?.status,'succeeded');
});
test('Paused parent cannot be bypassed by restoring or executing its task',()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);const topic=store.createTopic('测试暂停');const task=store.createTask(topic,'测试任务','测试问题');sql.exec("UPDATE topics SET status='paused' WHERE id=?",topic);assert.throws(()=>store.runTask(task),/先恢复关注/);store.pauseTask(task,'paused');assert.throws(()=>store.pauseTask(task,'active'),/先恢复关注/);
});
test('A missing target produces an execution receipt and cannot reuse an invented completion',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);store.enqueue(store.addRecord('后面帮我继续跟进一下',null),'auto');let checked=false;
 await processRun(claim()!,async(system,prompt)=>{
  const reply={judgment:'测试：要跟进哪个方向？',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]};
  if(system.includes('你先理解用户要完成的任务'))return {route:'chat',understanding:'测试委托',first_help:'',focus:null,followup:{title:'测试',question:'测试',quote:'后面帮我继续跟进一下'},pause_focus:false,reply:{...reply,judgment:'FALSE_COMPLETION'}};
  checked=true;assert.ok(prompt.includes('"needsTarget":true'));return reply;
 });assert.ok(checked);assert.equal(sql.all('SELECT * FROM tasks').length,0);assert.ok(!JSON.stringify(sql.all("SELECT content FROM records WHERE role='assistant'")).includes('FALSE_COMPLETION'));
});
test('Natural focus correction updates the persistent question and marks older analyses stale',async()=>{
 reset();saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);const topic=store.createTopic('测试国产替代','未来两周是否成为主线？');const rec=store.addRecord('你理解错了，我研究的是长期国产替代，不是未来两周主线',topic);store.enqueue(rec,'auto');
 const reply={judgment:'测试已更新问题',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[]};
 await processRun(claim()!,intakeFixture({route:'chat',understanding:'测试更正',first_help:'',focus:{id:topic,title:'测试长期国产替代',question:'长期国产替代的前提是否成立？',quote:'我研究的是长期国产替代'},followup:null,pause_focus:false,reply}));
 assert.equal(sql.one<{question:string}>('SELECT question FROM topics WHERE id=?',topic)?.question,'长期国产替代的前提是否成立？');assert.ok(sql.one("SELECT id FROM events WHERE type='focus_corrected'"));
});

test('Search freshness cannot overwrite an older date in the official document URL',async()=>{
 const {assessSourceTime}=await import('../server/source-time');const begin=new Date('2026-10-09'),end=new Date('2026-11-08');
 const old=assessSourceTime('https://static.cninfo.com.cn/finalpage/2026-06-04/1225350392.PDF','2026-11-06',begin,end);assert.equal(old.outside,true);assert.equal(old.pathDate,'2026-06-04');
 const unknown=assessSourceTime('https://www.sse.com.cn/document.pdf','2026-11-06',begin,end);assert.equal(unknown.pathDate,null);assert.equal(unknown.uncertain,true);
 const current=assessSourceTime('https://static.sse.com.cn/stock/disclosure/announcement/c/202610/688047_20261021_XCJS.pdf','2026-10-22',begin,end);assert.equal(current.outside,false);assert.equal(current.pathDate,'2026-10-21');
});
