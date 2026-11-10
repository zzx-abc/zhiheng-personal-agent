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
 const report=JSON.parse(r.result);if(report.logic?.length<2)throw Error('Two distinct decision situations were not preserved');
 if(report.logic.some((l:any)=>/中长线|中线|长线/.test(l.title)))throw Error('Invented trading horizon');
}
try{
 const at=new Date(),slot=weekly.latestWeeklySlot(at),period=weekly.weeklyPeriod(slot);
 let parent:string|null=null;
 for(const [offset,text,independent] of [
  [1,'验收用虚构记录：我持有甲公司，是因为看好行业景气和订单兑现。我想观察两次季度披露。今天甲公司下跌，热点上涨，我有点想换过去，不知道是原逻辑有问题还是被当天涨跌影响。',false],
  [3,'验收纠正：观察两次季度披露只是验证订单的窗口，不是承诺持有到那时，更不是不能调整的规则。我没有实际换仓。',false],
  [5,'验收用虚构记录：这是另一笔甲公司的独立短线尝试，和订单那件事分开看。这笔想观察两天价格承接，还没有成交。',true]
 ] as const){const key=store.capture(text,independent?null:parent,'note');sql.exec('UPDATE records SET created_at=? WHERE id=?',new Date(Date.parse(period.start)+offset*86400000).toISOString(),key);parent=key;}
 weekly.setWeeklyEnabled(true,new Date(Date.parse(slot)-86400000));const first=weekly.tickWeekly(at);if(!first)throw Error('Scheduler did not enqueue the due week');
 await execute(first.runId);
 weekly.correctWeeklyReview(first.reviewId,'验收纠正：订单验证窗口不是中长线的持有周期。另一笔短线尝试与它无关，不要解释成同一笔交易的风格变化。');
 const retry=weekly.retryWeeklyReview(first.reviewId);await execute(retry.runId);
 if(weekly.weeklySnapshot().versions.length!==2||sql.all("SELECT * FROM records WHERE role='assistant'").length)throw Error('Review versions or separation failed');
 if(weekly.tickWeekly(at)!==null)throw Error('Automatic slot duplicated');
 console.log('PASS real model: two distinct trading situations, no invented horizon, independent semantic audit, scoped correction + regeneration');
}catch(e){console.error('FAILED',e instanceof Error?e.message:'unknown');process.exitCode=1;}
finally{
 writeFileSync(path.join(root,'data/validation-weekly-logic.json'),JSON.stringify({testedAt:new Date().toISOString(),results},null,2),{mode:0o600});
 for(const row of sql.all<any>('SELECT * FROM usage'))source.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('weekly-logic-validation:'+row.id,null,row.model.replace(/^(pending:|unconfirmed:|reserved:)?/,'$1weekly-logic-validation:'),row.tokens,row.created_at);
 sql.db.close();source.close();rmSync(directory,{recursive:true,force:true});
}
