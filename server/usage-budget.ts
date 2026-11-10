import {all,one,exec,id,now,event,transaction} from './db';
import {config} from './config';
export function usageBreakdown(){
 const rows=all<{model:string;tokens:number}>("SELECT model,SUM(tokens) tokens FROM usage WHERE created_at>=? GROUP BY model",new Date().toISOString().slice(0,7)+'-01');
 let confirmed=0,uncertain=0,pending=0,development=0;
 for(const r of rows){if(/^(reserved:|unconfirmed:)/.test(r.model))uncertain+=r.tokens;else if(r.model.startsWith('pending:'))pending+=r.tokens;else confirmed+=r.tokens;if(r.model.includes('validation:'))development+=r.tokens;}
 return {confirmed,uncertain,pending,development,total:confirmed+uncertain+pending};
}
export function reconcileLegacyReservations(){
 if(one("SELECT value FROM meta WHERE key='reservation-output-v2'"))return;
 transaction(()=>{
  // Previous code reserved 16,000 output tokens despite sending max_tokens=8192.
  // Retain the original input estimate and a conservative output allowance;
  // do NOT claim that interrupted requests were free.
  for(const row of all<{id:string;run_id:string|null;model:string;tokens:number}>("SELECT * FROM usage WHERE model LIKE 'reserved:%'")){
   const tokens=Math.max(0,row.tokens-7808);exec('UPDATE usage SET model=?,tokens=? WHERE id=?','unconfirmed:'+row.model.slice(9),tokens,row.id);
   if(row.run_id){exec('UPDATE runs SET usage=MAX(0,usage-?) WHERE id=?',row.tokens-tokens,row.run_id);event(row.run_id,'budget_reconciled',{usageId:row.id,oldEstimate:row.tokens,newEstimate:tokens,reason:'旧预留输出16000改为实际配置上限8192；未知用量仍计入预算，并非退款'});}
  }
  exec("INSERT INTO meta VALUES('reservation-output-v2',1)");
 });
}
export function recoverPendingUsage(){
 // A crashed worker leaves uncertain charges, never permanently in-flight ones.
 exec("UPDATE usage SET model=REPLACE(model,'pending:','unconfirmed:') WHERE model LIKE 'pending:%' AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs) OR run_id IN (SELECT id FROM runs WHERE status NOT IN ('queued','running')))");
}
export function outputAllowance(system:string){if(system.startsWith('你比较不同交易思路'))return 2048;if(system.startsWith('你整理一个独立问题'))return 3072;if(system.startsWith('你为每周')||system.startsWith('你是独立的交易思路核对者'))return 3072;if(system.includes('你规划'))return 2048;if(system.includes('你是分析 Agent')||system.includes('你是质疑 Agent'))return 3072;if(system.includes('只修复'))return 6144;return 6144;}
export function estimateReservation(system:string,prompt:string,images:number,maxTokens:number){const text=system+prompt,ascii=(text.match(/[\x00-\x7F]/g)||[]).length;return Math.ceil((text.length-ascii)*1.5+ascii*0.6)+images*8192+maxTokens+2048;}
export async function reserveUsage(runId:string,model:string,tokens:number,signal:AbortSignal){
 for(;;){
  signal.throwIfAborted();
  const key=transaction(()=>{const used=usageBreakdown();if(used.total+tokens>config().monthlyTokens){if(used.pending>0)return null;throw Error(`本机月度预算不足，不是模型上下文超限。已确认 ${used.confirmed.toLocaleString()} Token，未确认预估 ${used.uncertain.toLocaleString()} Token，本次需预留约 ${tokens.toLocaleString()} Token。可在设置查看明细；原文已保存。`);}
   const key=id();exec('INSERT INTO usage VALUES(?,?,?,?,?)',key,runId,'pending:'+model,tokens,now());exec('UPDATE runs SET usage=usage+? WHERE id=?',tokens,runId);return key;});
  if(key)return key;
  // Independent reviewers may run in sequence near the budget limit. They still
  // receive independent contexts, and no partially completed call is abandoned.
  await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new Error('任务已取消'))};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve()},200);signal.addEventListener('abort',stop,{once:true});});
 }
}
export function settleUsage(key:string,runId:string,model:string,reported:number|undefined,notCalled=false){transaction(()=>{
 const row=one<{tokens:number}>('SELECT tokens FROM usage WHERE id=?',key);if(!row)return;
 const tokens=notCalled?0:reported??row.tokens;
 exec('UPDATE usage SET model=?,tokens=? WHERE id=?',reported!==undefined||notCalled?model:'unconfirmed:'+model,tokens,key);exec('UPDATE runs SET usage=MAX(0,usage+?) WHERE id=?',tokens-row.tokens,runId);
});}
