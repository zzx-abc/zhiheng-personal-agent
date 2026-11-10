/** Paid end-to-end validation, isolated from the user's conversations. No simulated AI. */
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';
if(!process.argv.includes('--live'))throw Error('Requires --live');
const root=process.cwd(),source=new DatabaseSync(path.join(root,'data/agent.sqlite'));
const saved=JSON.parse(readFileSync(path.join(root,'data/credentials.json'),'utf8'));
const used=Number((source.prepare("SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?").get(new Date().toISOString().slice(0,7)+'-01') as {n:number}).n);
const budget=Math.min(220000,saved.monthlyTokens-used);
if(budget<180000)throw Error('Insufficient remaining budget; configured limit was not changed');
const directory=mkdtempSync(path.join(tmpdir(),'zhiheng-decision-live-'));process.env.AGENT_DATA_DIR=directory;
const sql=await import('../server/db'),store=await import('../server/store');
const {saveConfig}=await import('../server/config');const {processRun,claim}=await import('../server/engine');
saveConfig(saved.apiKey,saved.model,budget,saved.engine);
const results:any[]=[];const assert=(x:unknown,message:string)=>{if(!x)throw Error(message)};
async function run(text:string,parent:string|null){
 const rec=store.capture(text,parent),id=store.enqueue(rec,'auto'),start=Date.now();console.log('START',results.length+1);
 const timer=setInterval(()=>console.log('PHASE',sql.one<any>('SELECT phase FROM runs WHERE id=?',id)?.phase),25000);
 try{await processRun(claim()!);}finally{clearInterval(timer)}
 const r=sql.one<any>('SELECT * FROM runs WHERE id=?',id),answer=r.result?JSON.parse(r.result):null;
 const reports=sql.all('SELECT id FROM reports WHERE run_id=?',id).length;
 results.push({reportData:sql.all<any>('SELECT agent,content FROM reports WHERE run_id=?',id),status:r.status,seconds:Math.round((Date.now()-start)/1000),answer,reports,error:r.error});
 console.log('RESULT',r.status,results.at(-1).seconds+'s',reports+' reports');
 assert(['succeeded','partial'].includes(r.status),r.error||'No completed answer');return {r,answer,reports,rec};
}
try{
 const first=await run('验收样例：我想持续弄清自己的调整依据。我持有甲公司，是因为看好行业景气和订单兑现。我原本想观察接下来两次季度披露。今天持仓亏了，另一边热点一直涨，我有点想换过去。我担心自己拿错方向，但不知道是原逻辑有问题还是被当天涨跌带着走。这里公司匿名，不要联网猜公司；先帮我判断这个思路，不需要买卖建议。',null);
 assert(first.reports===3,'Decision comparison did not receive independent review');
 assert(first.answer.working_state?.decision_frame?.original_basis,'Original decision basis was not preserved');
 assert(first.answer.working_state?.decision_frame?.evaluation_horizon,'Explicit observation horizon was not preserved');
 const topic=first.r.topic_id;assert(topic,'Decision thread missing');
 const correction=await run('你理解错了一点：我说观察两次季度披露，只是为了验证订单，不是承诺拿到那时，更不是不能调整的交易规则。我也没有实际换仓。请修正这个理解，不要重新写一篇分析。',first.rec);
 assert(correction.reports===1,'A correction unnecessarily repeated independent review');
 assert(correction.answer.working_state?.decision_frame,'Correction failed to update persistent decision context');
 const final=await run('接着上次，我原来关注它的依据是什么？观察两个季度到底意味着什么？我是否已经换仓？简短回答，不用重做研究。',correction.rec);
 assert(final.reports===1,'Simple recall unnecessarily repeated independent review');
 assert(/订单/.test(final.answer.judgment+JSON.stringify(final.answer.reasons)),'Failed to recall decision basis');
 assert(correction.answer.working_state?.logic_change?.kind==='correction','Correction not classified');
 const separate=await run('验收用虚构场景：我想持续梳理另一笔甲公司的短线尝试，和上面等待订单兑现的那件事分开。这笔想观察两天的价格承接，还没有成交。请先保存这个独立想法，不需要行情或建议。',final.rec);
 assert(separate.r.topic_id!==topic,'Same-stock separate decision overwrote original focus');
 const weekly=await import('../server/weekly-review');
 const review=weekly.requestWeeklyReview(new Date(Date.now()+1000));
 const timer=setInterval(()=>console.log('Weekly reasoning validation running'),25000);
 try{await weekly.processWeekly(claim()!);}finally{clearInterval(timer)}
 const wr=sql.one<any>('SELECT * FROM runs WHERE id=?',review.runId),weeklyResult=wr.result?JSON.parse(wr.result):null;
 results.push({weeklyStatus:wr.status,weeklyResult,error:wr.error});
 assert(wr.status==='succeeded',wr.error||'Weekly reasoning failed');
 assert(weeklyResult.logic?.length>=2,'Separate decision situations missing from weekly review');
 assert(sql.one("SELECT id FROM events WHERE run_id=? AND type='weekly_logic_audit'",review.runId),'Weekly semantic audit did not execute');
 console.log('PASS real Kimi: reasoning, correction, next-turn recall, same-stock separate decision, weekly reasoning + independent audit');
}catch(e){console.error('FAILED',e instanceof Error?e.message:'unknown');process.exitCode=1;}
finally{
 writeFileSync(path.join(root,'data/validation-decision-logic.json'),JSON.stringify({testedAt:new Date().toISOString(),results},null,2),{mode:0o600});
 for(const row of sql.all<any>('SELECT * FROM usage'))source.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('decision-logic-validation:'+row.id,null,row.model.replace(/^(pending:|unconfirmed:|reserved:)?/,'$1decision-logic-validation:'),row.tokens,row.created_at);
 sql.db.close();source.close();rmSync(directory,{recursive:true,force:true});
}
