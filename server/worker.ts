import { exec,now } from './db';
import { claim,processRun } from './engine';
import {indexCards} from './retrieval';
import {reconcileLegacyReservations,recoverPendingUsage} from './usage-budget';
reconcileLegacyReservations();recoverPendingUsage();
let quitting=false;process.on('SIGTERM',()=>{quitting=true;});process.on('SIGINT',()=>{quitting=true;});
console.log('知衡后台已启动：仅执行手动提交的任务，未启用定时监测。');
async function loop(){while(!quitting){
 exec("UPDATE runs SET status='failed',phase='interrupted',error='后台执行中断。已保留记录，请手动重试以避免重复调用。',finished_at=? WHERE status='running' AND heartbeat<?",now(),new Date(Date.now()-30000).toISOString());
 recoverPendingUsage();
 const run=claim();if(run)await processRun(run);else {await indexCards();await new Promise(r=>setTimeout(r,1500));}
}process.exit(0);}
loop().catch(e=>{console.error('后台停止：',e.message);process.exit(1);});
