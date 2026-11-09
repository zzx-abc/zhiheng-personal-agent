// Synthetic fixtures. No network model calls, production records, or real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-weekly-test-'));
const sql=await import('../server/db'),store=await import('../server/store'),weekly=await import('../server/weekly-review');
const {saveConfig}=await import('../server/config'),{claim}=await import('../server/engine');
const at=new Date('2026-11-09T02:00:00.000Z');
function reset(){for(const t of ['weekly_feedback','weekly_sources','weekly_versions','weekly_reviews','runs','records','topics'])sql.exec(`DELETE FROM ${t}`);sql.exec('UPDATE weekly_schedule SET enabled=0,next_at=NULL,last_checked=NULL');saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);}
function capture(text:string,date='2026-11-05T03:00:00.000Z'){const key=store.capture('测试样例：'+text,null,'note');sql.exec('UPDATE records SET created_at=? WHERE id=?',date,key);return key;}
const sample=(id:string,quote:string)=>({focus:[{text:'测试归纳：记录在思考这个问题',citations:[{source_id:id,quote}]}],changes:[],unresolved:[]});
function runRow(id:string){return sql.one<any>('SELECT * FROM runs WHERE id=?',id)!;}
test('Weekly schedule uses Shanghai Monday 09:00 and the preceding full civil week',()=>{
 assert.equal(weekly.latestWeeklySlot(new Date('2026-11-09T00:59:59Z')),'2026-11-02T01:00:00.000Z');
 assert.equal(weekly.latestWeeklySlot(new Date('2026-11-09T01:00:00Z')),'2026-11-09T01:00:00.000Z');
 assert.deepEqual(weekly.weeklyPeriod('2026-11-09T01:00:00.000Z'),{start:'2026-11-01T16:00:00.000Z',end:'2026-11-08T16:00:00.000Z'});
 assert.equal(weekly.nextWeeklySlot(at),'2026-11-16T01:00:00.000Z');
});
test('Default is off; duplicate ticks create one slot; offline catch-up skips paid backlog',()=>{
 reset();assert.equal(weekly.tickWeekly(at),null);
 weekly.setWeeklyEnabled(true,new Date('2026-10-20T02:00:00Z'));
 const r=weekly.tickWeekly(at)!;assert.ok(r);
 assert.equal(weekly.tickWeekly(at),null);assert.equal(sql.all('SELECT * FROM weekly_reviews').length,1);
 assert.equal(sql.one<any>('SELECT scheduled_for FROM weekly_reviews')?.scheduled_for,'2026-11-09T01:00:00.000Z');
 assert.equal(weekly.weeklySnapshot().schedule.next_at,'2026-11-16T01:00:00.000Z');
 weekly.deleteWeeklyReview(r.reviewId);sql.exec("UPDATE weekly_schedule SET next_at='2026-11-09T01:00:00.000Z'");
 assert.equal(weekly.tickWeekly(at),null,'Deleted auto slots must not be silently regenerated');
});
test('Disabling cancels pending automatic work, and re-enabling starts with a future slot',()=>{
 reset();weekly.setWeeklyEnabled(true,new Date('2026-11-08T01:00:00Z'));const r=weekly.tickWeekly(at)!;
 weekly.setWeeklyEnabled(false,at);assert.equal(runRow(r.runId).status,'cancelled');
 weekly.setWeeklyEnabled(true,at);assert.equal(weekly.weeklySnapshot().schedule.next_at,'2026-11-16T01:00:00.000Z');
});
test('Manual double-click deduplicates active work; empty week skips without a model call',async()=>{
 reset();const r=weekly.requestWeeklyReview(at);assert.deepEqual(weekly.requestWeeklyReview(at),r);
 let calls=0;await weekly.processWeekly(claim()!,async()=>{calls++;throw Error('should not call');});
 assert.equal(calls,0);assert.equal(runRow(r.runId).status,'skipped');
});
test('Missing key stays blocked and failures do not auto retry or invent a report',async()=>{
 reset();capture('需求待确认');saveConfig('','kimi-k3',1000000);const blocked=weekly.requestWeeklyReview(at);assert.equal(runRow(blocked.runId).status,'blocked');
 saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000);const retry=weekly.retryWeeklyReview(blocked.reviewId);
 await weekly.processWeekly(claim()!,async()=>{throw Error('test provider unavailable');});
 assert.equal(runRow(retry.runId).status,'failed');assert.equal(runRow(retry.runId).result,null);assert.equal(claim(),undefined);
});
test('Window selection excludes boundary/future and operational notes, samples across the week, bounds context',async()=>{
 reset();for(let i=0;i<60;i++)capture('独立思考'+i+'。'.repeat(700),new Date(Date.parse('2026-11-03T00:00:00Z')+i*3600000).toISOString());
 capture('恰在结束边界',at.toISOString());capture('不属于本期','2026-10-01T00:00:00Z');
 const r=weekly.requestWeeklyReview(at),w=sql.one<any>('SELECT * FROM weekly_reviews WHERE id=?',r.reviewId)!;
 const c=await weekly.weeklyContext(w);assert.equal(c.coverage.total,60);assert.equal(c.coverage.selected,30);assert.equal(c.coverage.excerpted,true);assert.ok(JSON.stringify(c).length<=24000);
 assert.ok(c.sources.some(s=>s.text.includes('独立思考0')));assert.ok(c.sources.some(s=>s.text.includes('独立思考59')));assert.ok(!c.sources.some(s=>s.text.includes('恰在结束边界')));
});
test('Unknown source, invented quotes, unsupported changes and unrelated old-only claims are rejected',()=>{
 const s={id:'a',text:'测试原话需求待确认',date:at.toISOString(),kind:'note',scope:'period' as const,excerpted:false};
 assert.throws(()=>weekly.validateWeekly(sample('fake','需求待确认'),[s]));assert.throws(()=>weekly.validateWeekly(sample('a','没有说过'),[s]));
 assert.throws(()=>weekly.validateWeekly({focus:[],changes:sample('a','需求待确认').focus,unresolved:[]},[s]));
 assert.throws(()=>weekly.validateWeekly(sample('a','需求待确认'),[{...s,scope:'earlier'}]));
});
test('Successful report stays separate from memory; scoped corrections create a new version and persist',async()=>{
 reset();const source=capture('这个想法只是担心'),r=weekly.requestWeeklyReview(at);
 await weekly.processWeekly(claim()!,async()=>sample(source,'这个想法只是担心'));
 assert.equal(runRow(r.runId).status,'succeeded');assert.equal(sql.all("SELECT * FROM records WHERE role='assistant'").length,0);
 weekly.correctWeeklyReview(r.reviewId,'测试纠正：这是两件事，不代表观点发生变化');
 assert.equal(runRow(r.runId).status,'stale');const retry=weekly.retryWeeklyReview(r.reviewId);
 await weekly.processWeekly(claim()!,async(_sys,prompt)=>{assert.ok(prompt.includes('这是两件事'));return sample(source,'这个想法只是担心');});
 assert.equal(runRow(retry.runId).status,'succeeded');assert.equal(weekly.weeklySnapshot().versions.length,2);
 const cards=store.snapshot().cards;assert.ok(!cards.some(c=>c.body.includes('这是两件事')),'Review correction must not become a global trading memory');
 const {DatabaseSync}=await import('node:sqlite');const reopened=new DatabaseSync(path.join(process.env.AGENT_DATA_DIR!,'agent.sqlite'));assert.equal((reopened.prepare('SELECT count(*) n FROM weekly_versions').get() as any).n,2);reopened.close();
});
test('Correction during generation prevents old result from committing',async()=>{
 reset();const source=capture('我尚未确认'),r=weekly.requestWeeklyReview(at);
 await weekly.processWeekly(claim()!,async()=>{weekly.correctWeeklyReview(r.reviewId,'测试：应理解为研究问题');return sample(source,'我尚未确认');});
 assert.equal(runRow(r.runId).result,null);assert.equal(runRow(r.runId).status,'cancelled');
});
test('Deleting a source purges derived report text; deleting only a review preserves investment originals',async()=>{
 reset();const source=capture('这段原话需要保密'),r=weekly.requestWeeklyReview(at);
 await weekly.processWeekly(claim()!,async()=>sample(source,'这段原话需要保密'));
 sql.exec('DELETE FROM records WHERE id=?',source);assert.equal(runRow(r.runId).result,null);assert.equal(runRow(r.runId).status,'stale');
 const keep=capture('这条原话要保留');weekly.deleteWeeklyReview(r.reviewId);
 assert.ok(sql.one('SELECT id FROM records WHERE id=?',keep));assert.equal(sql.all('SELECT * FROM weekly_versions').length,0);
});
test('Real worker schedules and finishes an empty week without a browser, and marks interrupted work failed',async()=>{
 reset();const interrupted=weekly.requestWeeklyReview(new Date());
 sql.exec("UPDATE runs SET status='running',heartbeat='2000-01-01T00:00:00.000Z' WHERE id=?",interrupted.runId);
 sql.exec("UPDATE weekly_schedule SET enabled=1,next_at='2000-01-03T01:00:00.000Z'");
 const worker=spawn(process.execPath,['--import','tsx','server/worker.ts'],{env:{...process.env,MOONSHOT_API_KEY:''},stdio:'ignore'});
 const stopped=new Promise<void>(resolve=>worker.on('exit',()=>resolve()));
 try{
  const deadline=Date.now()+12000;
  while(Date.now()<deadline&&!sql.one("SELECT id FROM runs WHERE mode='weekly' AND status='skipped'"))await new Promise(r=>setTimeout(r,100));
  assert.ok(sql.one("SELECT id FROM runs WHERE mode='weekly' AND status='skipped'"));
  assert.equal(runRow(interrupted.runId).status,'failed');
  assert.equal(sql.all('SELECT * FROM usage').length,0,'Empty week must not make a paid call');
 }finally{worker.kill('SIGTERM');const kill=setTimeout(()=>worker.kill('SIGKILL'),3000);await stopped;clearTimeout(kill);}
});
test('Deleted in-flight review keeps uncertain charges accountable instead of permanently pending',async()=>{
 reset();const r=weekly.requestWeeklyReview(at);
 sql.exec('INSERT INTO usage VALUES(?,?,?,?,?)',sql.id(),r.runId,'pending:fixture',100,sql.now());
 weekly.deleteWeeklyReview(r.reviewId);const {recoverPendingUsage}=await import('../server/usage-budget');recoverPendingUsage();
 assert.equal(sql.one<any>('SELECT model FROM usage')?.model,'unconfirmed:fixture');sql.exec('DELETE FROM usage');
});
test.after(()=>{sql.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true});});
