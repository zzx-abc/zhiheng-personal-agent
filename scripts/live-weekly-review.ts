/** Explicit paid validation with fictional records. Never reads personal conversation history. */
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';
if(!process.argv.includes('--live'))throw Error('Requires --live; this uses the configured model and budget');
const root=process.cwd(),source=new DatabaseSync(path.join(root,'data/agent.sqlite'));
const saved=JSON.parse(readFileSync(path.join(root,'data/credentials.json'),'utf8'));
const used=Number((source.prepare("SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?").get(new Date().toISOString().slice(0,7)+'-01') as {n:number}).n);
const budget=Math.min(35000,saved.monthlyTokens-used);if(budget<25000)throw Error('Insufficient validation budget; limit unchanged');
const directory=mkdtempSync(path.join(tmpdir(),'zhiheng-weekly-live-'));process.env.AGENT_DATA_DIR=directory;
const sql=await import('../server/db'),store=await import('../server/store'),weekly=await import('../server/weekly-review');
const {saveConfig}=await import('../server/config'),{claim}=await import('../server/engine');
saveConfig(saved.apiKey,saved.model,budget,saved.engine);
const results:unknown[]=[];
async function execute(runId:string){
 const started=Date.now(),timer=setInterval(()=>console.log('Weekly real-model validation running'),25000);
 try{await weekly.processWeekly(claim()!);}finally{clearInterval(timer)}
 const r=sql.one<any>('SELECT * FROM runs WHERE id=?',runId);
 results.push({status:r.status,seconds:Math.round((Date.now()-started)/1000),result:r.result?JSON.parse(r.result):null,error:r.error});
 console.log('RESULT',r.status,Math.round((Date.now()-started)/1000)+'s');
 if(r.status!=='succeeded')throw Error(r.error||'No completed review');
}
try{
 const at=new Date(),slot=weekly.latestWeeklySlot(at),period=weekly.weeklyPeriod(slot);
 for(const [offset,text] of [
  [1,'验收用虚构记录：关注青杉设备，想验证订单是否兑现；尚未确认，不代表买入。'],
  [3,'验收用虚构记录：青杉设备的订单问题仍在研究。我又在考虑另一笔短线试仓，两件事要分开看。'],
  [5,'验收用虚构记录：之前只想看订单数量，现在想先核实回款质量。还没有找到答案。']
 ] as const){const key=store.capture(text,null,'note');sql.exec('UPDATE records SET created_at=? WHERE id=?',new Date(Date.parse(period.start)+offset*86400000).toISOString(),key);}
 weekly.setWeeklyEnabled(true,new Date(Date.parse(slot)-86400000));const first=weekly.tickWeekly(at);if(!first)throw Error('Scheduler did not enqueue the due week');
 await execute(first.runId);
 weekly.correctWeeklyReview(first.reviewId,'验收纠正：回款质量和短线试仓是不同问题，不要总结为同一笔交易的风格变化。');
 const retry=weekly.retryWeeklyReview(first.reviewId);await execute(retry.runId);
 if(weekly.weeklySnapshot().versions.length!==2||sql.all("SELECT * FROM records WHERE role='assistant'").length)throw Error('Review versions or separation failed');
 if(weekly.tickWeekly(at)!==null)throw Error('Automatic slot duplicated');
 console.log('PASS real model: scheduled review, citations, scoped correction, regeneration, no duplicate slot');
}catch(e){console.error('FAILED',e instanceof Error?e.message:'unknown');process.exitCode=1;}
finally{
 writeFileSync(path.join(root,'data/validation-weekly-review.json'),JSON.stringify({testedAt:new Date().toISOString(),results},null,2),{mode:0o600});
 for(const row of sql.all<any>('SELECT * FROM usage'))source.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('weekly-validation:'+row.id,null,row.model.replace(/^(pending:|unconfirmed:|reserved:)?/,'$1weekly-validation:'),row.tokens,row.created_at);
 sql.db.close();source.close();rmSync(directory,{recursive:true,force:true});
}
