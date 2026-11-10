/** Explicit paid validation with fictional records. Never reads personal conversation history. */
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';
if(!process.argv.includes('--live'))throw Error('Requires --live; this uses the configured model and budget');
const root=process.cwd(),source=new DatabaseSync(path.join(root,'data/agent.sqlite'));
const saved=JSON.parse(readFileSync(path.join(root,'data/credentials.json'),'utf8'));
const used=Number((source.prepare("SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?").get(new Date().toISOString().slice(0,7)+'-01') as {n:number}).n);
const budget=Math.min(80000,saved.monthlyTokens-used);if(budget<40000)throw Error('Insufficient validation budget; limit unchanged');
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
 const at=new Date(),topic=store.createTopic('合成场景：方向与接力'),ids:string[]=[];
 const texts=[
  '合成场景：我在研究虚构设备行业的机会，不是实际持仓。'+('研究边界：这里讨论的是个人判断，行业前提尚未核实。\n'.repeat(55))+'核心推理：我认为资金可能因研究惯性在相关方向寻找接力，但同一主题不保证具体个股补涨，传导仍需证据。'+('材料附注：以下观察都只是待验证想法。\n'.repeat(55)),
  '合成场景：我先因甲设备量价转强而参与，后来按行业内部接力的想法转到乙材料和丙工具，两只暂时偏弱。',
  '合成场景：接着前面的乙材料和丙工具，我目前没有再次调整的计划，只是不知道如何验证先前的接力判断。',
  '合成场景：另外一个独立问题，上游组件上涨，下游模块相对弱，我基于产业联系考虑下游补涨，尚未执行。',
  '合成场景：另开一笔甲设备的短线观察，和那次行业接力调整无关，仅观察两天价格承接，还没有成交。',
  ...Array.from({length:30},(_,i)=>'合成独立笔记 '+i+'：今天只记录一个资料标题，没有做新的判断。')
 ];
 for(let i=0;i<texts.length;i++){const id=store.addRecord(texts[i],topic,'note');sql.exec('UPDATE records SET created_at=? WHERE id=?',new Date(at.getTime()-(36-i)*3600000).toISOString(),id);ids.push(id);}
 const first=weekly.requestWeeklyReview(at);await execute(first.runId);
 const result=JSON.parse(sql.one<any>('SELECT result FROM runs WHERE id=?',first.runId)!.result);
 if(result.coverage.selected!==35||result.coverage.excerpted)throw Error('Small total corpus should be read completely');
 const main=result.reviewPlan.groups.find((g:any)=>g.source_ids.includes(ids[1]));
 if(!main?.source_ids.includes(ids[2]))throw Error('Legacy continuation was not linked');
 if(main.source_ids.includes(ids[4]))throw Error('Independent same-company trade was merged');
 if(!result.insights?.length)throw Error('No useful cross-situation reasoning comparison');
 if(sql.all('SELECT * FROM record_context').length)throw Error('Review must not rewrite original capture relationships');
 console.log('PASS real model: 35 complete legacy records, long thesis middle, continuation, separate trade, reasoning comparison');
}catch(e){console.error('FAILED',e instanceof Error?e.message:'unknown');process.exitCode=1;}
finally{
 writeFileSync(path.join(root,'data/validation-weekly-relations.json'),JSON.stringify({testedAt:new Date().toISOString(),results},null,2),{mode:0o600});
 for(const row of sql.all<any>('SELECT * FROM usage'))source.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('weekly-relations-validation:'+row.id,null,row.model.replace(/^(pending:|unconfirmed:|reserved:)?/,'$1weekly-relations-validation:'),row.tokens,row.created_at);
 sql.db.close();source.close();rmSync(directory,{recursive:true,force:true});
}
