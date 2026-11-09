/** Opt-in paid validation. Synthetic conversations, real configured model/tools. */
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';
if(!process.argv.includes('--live'))throw Error('Requires --live');
const root=process.cwd(),source=new DatabaseSync(path.join(root,'data/agent.sqlite'));
const saved=JSON.parse(readFileSync(path.join(root,'data/credentials.json'),'utf8'));
const used=Number((source.prepare("SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?").get(new Date().toISOString().slice(0,7)+'-01') as {n:number}).n);
const budget=Math.min(80000,saved.monthlyTokens-used);
if(budget<60000)throw Error('Insufficient remaining validation budget; configured limit unchanged');
const directory=mkdtempSync(path.join(tmpdir(),'zhiheng-fragments-live-'));process.env.AGENT_DATA_DIR=directory;
const sql=await import('../server/db'),store=await import('../server/store');
const {saveConfig}=await import('../server/config');const {processRun,claim}=await import('../server/engine');
saveConfig(saved.apiKey,saved.model,budget,saved.engine);
const results:any[]=[];const assert=(x:unknown,message:string)=>{if(!x)throw Error(message)};
async function run(text:string,parent:string|null){
 const record=store.capture(text,parent),id=store.enqueue(record,'auto'),started=Date.now();console.log('START scenario',results.length+1);
 const timer=setInterval(()=>console.log('PHASE',sql.one<any>('SELECT phase FROM runs WHERE id=?',id)?.phase),25000);
 try{await processRun(claim()!);}finally{clearInterval(timer)}
 const r=sql.one<any>('SELECT * FROM runs WHERE id=?',id),answer=r.result?JSON.parse(r.result):null;
 const events=sql.all<any>('SELECT type,detail FROM events WHERE run_id=?',id).map(e=>({type:e.type,detail:JSON.parse(e.detail)}));
 results.push({status:r.status,seconds:Math.round((Date.now()-started)/1000),answer,events,error:r.error});
 console.log('RESULT',r.status,results.at(-1).seconds+'s');assert(['succeeded','partial'].includes(r.status),r.error||'No answer');return {record,r,answer,events};
}
try{
 const oldTopic=store.createTopic('验收虚构案例：青杉设备订单');
 const original=store.capture('验收用虚构记录，非真实持仓：我当时关注青杉设备，是想验证订单质量改善，不是看到价格涨了。',null,'note');
 sql.exec('UPDATE records SET topic_id=? WHERE id=?',oldTopic,original);
 store.capture('另一条验收用虚构记录：我当时担心自己的持仓，想追热点。',null,'note');
 const market=await run('帮我分析今天早上的A股盘面并作记录。先看上证指数和创业板指，说明行情时间和无法验证的部分。',null);
 assert(!market.events.some(e=>e.type==='memory_requested'),'Overview unnecessarily requested personal history');
 assert(!market.r.topic_id,'Overview inherited or created a persistent investment thesis');
 assert(!/青杉设备/.test(market.answer.judgment),'Unrelated holding entered market overview');
 const recall=await run('回顾我之前关于青杉设备的测试记录：我当时为什么关注它？只找回原话，不查行情。',null);
 assert(recall.events.some(e=>e.type==='memory_retrieved'&&e.detail.cards.some((c:any)=>c.sourceIds.includes(original))),'Recall did not retrieve the original');
 assert(/订单质量/.test(JSON.stringify(recall.answer)),'Recall omitted original basis');
 assert(!recall.r.topic_id,'Historical lookup was incorrectly treated as continuing an old focus');
 assert(sql.one<any>('SELECT root_id FROM record_context WHERE record_id=?',recall.record)?.root_id===recall.record,'Recall merged independent captures');
 const reply=await run('这里说的“订单质量”和“订单数量”有什么区别？只解释概念，不做投资判断。',recall.record);
 assert(!reply.events.some(e=>e.type==='memory_requested'),'A self-contained clarification unnecessarily searched all memory');
 assert(sql.one<any>('SELECT root_id FROM record_context WHERE record_id=?',reply.record)?.root_id===recall.record,'Relevant clarification lost its parent');
 console.log('PASS real model: independent market overview, on-demand recall, local clarification');
}catch(e){console.error('FAILED',e instanceof Error?e.message:'unknown');process.exitCode=1;}
finally{
 writeFileSync(path.join(root,'data/validation-fragments.json'),JSON.stringify({testedAt:new Date().toISOString(),results},null,2),{mode:0o600});
 for(const row of sql.all<any>('SELECT * FROM usage'))source.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('fragment-validation:'+row.id,null,'fragment-validation:'+row.model,row.tokens,row.created_at);
 sql.db.close();source.close();rmSync(directory,{recursive:true,force:true});
}
