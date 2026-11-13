import {beatWorker} from './worker-status';
import {tickObservations,processObservation} from './observation/service';
import {collectNotifications,deliverNotification} from './notifications';
import {processWeekly,tickWeekly} from './weekly-review';
import { exec,now } from './db';
import { claim,processRun } from './engine';
import {indexCards} from './retrieval';
import {reconcileLegacyReservations,recoverPendingUsage} from './usage-budget';
reconcileLegacyReservations();recoverPendingUsage();
beatWorker();const pulse=setInterval(()=>beatWorker(),5000);pulse.unref();
let quitting=false,delivery:Promise<void>|null=null;
// Notification delivery must also progress while a long model request is running.
const notices=setInterval(()=>{if(quitting||delivery)return;delivery=(async()=>{collectNotifications();await deliverNotification();})().catch(()=>{console.error('通知后台暂时不可用，请检查本机通知设置');}).finally(()=>{delivery=null;});},2000);notices.unref();
const stop=()=>{quitting=true;clearInterval(pulse);clearInterval(notices);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
console.log('知衡后台已启动：执行手动任务、已开启的回顾与持续观察；未启用的任务不执行。');
async function loop(){while(!quitting){
 exec("UPDATE runs SET status='failed',phase='interrupted',error='后台执行中断。已保留记录，请手动重试以避免重复调用。',finished_at=? WHERE status='running' AND heartbeat<?",now(),new Date(Date.now()-30000).toISOString());
 recoverPendingUsage();
 tickWeekly();
 tickObservations();
 const run=claim();if(run){if(run.mode==='weekly')await processWeekly(run);else if(run.mode==='observation')await processObservation(run);else await processRun(run);}else {await indexCards();await new Promise(r=>setTimeout(r,1500));}
}if(delivery)await delivery;process.exit(0);}
loop().catch(e=>{console.error('后台停止：',e.message);process.exit(1);});
