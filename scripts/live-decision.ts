/** Paid end-to-end validation, isolated from the user's conversations. No simulated AI. */
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';
if(!process.argv.includes('--live'))throw Error('Requires --live');
const root=process.cwd(),source=new DatabaseSync(path.join(root,'data/agent.sqlite'));
const saved=JSON.parse(readFileSync(path.join(root,'data/credentials.json'),'utf8'));
const used=Number((source.prepare("SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?").get(new Date().toISOString().slice(0,7)+'-01') as {n:number}).n);
const budget=Math.min(150000,saved.monthlyTokens-used);
if(budget<110000)throw Error('Insufficient remaining budget; configured limit was not changed');
const directory=mkdtempSync(path.join(tmpdir(),'zhiheng-decision-live-'));process.env.AGENT_DATA_DIR=directory;
const sql=await import('../server/db'),store=await import('../server/store');
const {saveConfig}=await import('../server/config');const {processRun,claim}=await import('../server/engine');
saveConfig(saved.apiKey,saved.model,budget,saved.engine);
const results:any[]=[];const assert=(x:unknown,message:string)=>{if(!x)throw Error(message)};
async function run(text:string,topic:string|null){
 const rec=store.addRecord(text,topic),id=store.enqueue(rec,'auto'),start=Date.now();console.log('START',results.length+1);
 const timer=setInterval(()=>console.log('PHASE',sql.one<any>('SELECT phase FROM runs WHERE id=?',id)?.phase),25000);
 try{await processRun(claim()!);}finally{clearInterval(timer)}
 const r=sql.one<any>('SELECT * FROM runs WHERE id=?',id),answer=r.result?JSON.parse(r.result):null;
 const reports=sql.all('SELECT id FROM reports WHERE run_id=?',id).length;
 results.push({reportData:sql.all<any>('SELECT agent,content FROM reports WHERE run_id=?',id),status:r.status,seconds:Math.round((Date.now()-start)/1000),answer,reports,error:r.error});
 console.log('RESULT',r.status,results.at(-1).seconds+'s',reports+' reports');
 assert(['succeeded','partial'].includes(r.status),r.error||'No completed answer');return {r,answer,reports};
}
try{
 const first=await run('验收样例：我想持续弄清自己的调整依据。我持有甲公司，是因为看好行业景气和订单兑现。我原本想观察接下来两次季度披露。今天持仓亏了，另一边热点一直涨，我有点想换过去。我担心自己拿错方向，但不知道是原逻辑有问题还是被当天涨跌带着走。这里公司匿名，不要联网猜公司；先帮我判断这个思路，不需要买卖建议。',null);
 assert(first.reports===3,'Decision comparison did not receive independent review');
 assert(first.answer.working_state?.decision_frame?.original_basis,'Original decision basis was not preserved');
 assert(first.answer.working_state?.decision_frame?.evaluation_horizon,'Explicit observation horizon was not preserved');
 const topic=first.r.topic_id;assert(topic,'Decision thread missing');
 const correction=await run('你理解错了一点：我说观察两次季度披露，只是为了验证订单，不是承诺拿到那时，更不是不能调整的交易规则。我也没有实际换仓。请修正这个理解，不要重新写一篇分析。',topic);
 assert(correction.reports===1,'A correction unnecessarily repeated independent review');
 assert(correction.answer.working_state?.decision_frame,'Correction failed to update persistent decision context');
 const final=await run('接着上次，我原来关注它的依据是什么？观察两个季度到底意味着什么？我是否已经换仓？简短回答，不用重做研究。',topic);
 assert(final.reports===1,'Simple recall unnecessarily repeated independent review');
 assert(/订单/.test(final.answer.judgment+JSON.stringify(final.answer.reasons)),'Failed to recall decision basis');
 console.log('PASS real Kimi: comparison, sourced baseline, correction and subsequent recall');
}catch(e){console.error('FAILED',e instanceof Error?e.message:'unknown');process.exitCode=1;}
finally{
 writeFileSync(path.join(root,'data/validation-decision.json'),JSON.stringify({testedAt:new Date().toISOString(),results},null,2),{mode:0o600});
 for(const row of sql.all<any>('SELECT * FROM usage'))source.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('decision-validation:'+row.id,null,'decision-validation:'+row.model,row.tokens,row.created_at);
 sql.db.close();source.close();rmSync(directory,{recursive:true,force:true});
}
