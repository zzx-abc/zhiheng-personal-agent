/** Opt-in paid acceptance: real model, isolated labelled fixtures, usage reconciled. */
import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
if(!process.argv.includes('--live'))throw Error('Requires --live');
const root=process.cwd(),source=new DatabaseSync(path.join(root,'data/agent.sqlite'));
const saved=JSON.parse(readFileSync(path.join(root,'data/credentials.json'),'utf8'));
const used=Number((source.prepare("SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?").get(new Date().toISOString().slice(0,7)+'-01') as {n:number}).n);
const budget=Math.min(100000,saved.monthlyTokens-used);if(budget<70000)throw Error('Insufficient remaining test budget; limit unchanged');
const directory=mkdtempSync(path.join(tmpdir(),'zhiheng-learning-live-'));process.env.AGENT_DATA_DIR=directory;
const sql=await import('../server/db'),store=await import('../server/store'),learning=await import('../server/memory-learning');
const {saveConfig}=await import('../server/config'),{processRun,claim}=await import('../server/engine');
saveConfig(saved.apiKey,saved.model,budget,saved.engine);
const results:any[]=[];const assert=(value:unknown,message:string)=>{if(!value)throw Error(message)};
async function run(text:string,parent:string|null){
 const record=store.capture(text,parent),key=store.enqueue(record,'auto'),started=Date.now();console.log('START',results.length+1);
 const timer=setInterval(()=>console.log('PHASE',sql.one<any>('SELECT phase FROM runs WHERE id=?',key)?.phase),25000);
 try{await processRun(claim()!);}finally{clearInterval(timer)}
 const r=sql.one<any>('SELECT * FROM runs WHERE id=?',key),answer=r.result?JSON.parse(r.result):null;
 const events=sql.all<any>('SELECT type,detail FROM events WHERE run_id=?',key).map(e=>({type:e.type,detail:JSON.parse(e.detail)}));
 results.push({status:r.status,seconds:Math.round((Date.now()-started)/1000),answer,events,error:r.error});console.log('RESULT',r.status,results.at(-1).seconds+'s');assert(['succeeded','partial'].includes(r.status),r.error||'No answer');return {record,key,answer,events};
}
try{
 const old=store.capture('验收用虚构记录，非真实持仓：我关注青杉设备是为了验证订单兑现，当时想观察下一次季度披露。',null,'note');
 const first=await run('验收用虚构情境：青杉设备今天下跌，别的方向在涨，我有点想换仓。帮我整理现在该对照哪些依据，只梳理逻辑，不查行情，不给买卖建议。',null);
 const relation=sql.one<{id:string}>('SELECT * FROM memory_links WHERE run_id=? AND target_id=?',first.key,old);
 assert(learning.tagsFor([first.record]).some(t=>t.origin==='model'),'No model-generated source tags');
 assert(first.events.some(e=>e.type==='memory_requested'),'No proactive memory retrieval');assert(relation,'No validated, persistent relationship');
 const correction=await run('这个历史关联不对。这次说的是另一笔短线试仓，和之前等订单兑现的那笔不是同一件事，请不要再串成同一笔持仓。',first.record);
 assert(sql.one<any>('SELECT status FROM memory_links WHERE id=?',relation!.id)?.status==='rejected','Natural feedback was not persisted');
 const later=await run('接着这笔短线试仓，我考虑调整时，哪些信息是现在还没有明确的？只解释当前记录，不查行情。',correction.record);
 assert(!later.events.some(e=>e.type==='memory_selected'&&e.detail.links.some((l:any)=>l.source_id===old)),'Rejected association returned as accepted evidence');
 assert(!later.answer.reasons.some((r:any)=>r.sources.includes(old)),'Answer cited a rejected source');
 assert(later.events.some(e=>e.type==='completed'),'No completed answer after correction');
 console.log('PASS real model: automatic tags, proactive association, natural correction, subsequent answer');
}catch(e){console.error('FAILED',e instanceof Error?e.message:'unknown');process.exitCode=1;}
finally{
 writeFileSync(path.join(root,'data/validation-memory-learning.json'),JSON.stringify({testedAt:new Date().toISOString(),results},null,2),{mode:0o600});
 for(const row of sql.all<any>('SELECT * FROM usage'))source.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('learning-validation:'+row.id,null,row.model.replace(/^(pending:|unconfirmed:|reserved:)?/, '$1learning-validation:'),row.tokens,row.created_at);
 sql.db.close();source.close();rmSync(directory,{recursive:true,force:true});
}
