import {syncFeishu,feishuTransport} from './feishu/runtime';
import {processFeishu} from './feishu/receiver';
import {processLibrary,recoverLibrary} from './library/processor';
import {indexLibrary} from './library/service';
import {beatWorker} from './worker-status';
import {tickObservations,processObservation} from './observation/service';
import {collectNotifications,deliverNotification} from './notifications';
import {processWeekly,tickWeekly} from './weekly-review';
import {exec,one,now,type Run} from './db';
import {claim,processRun} from './engine';
import {indexCards} from './retrieval';
import {reconcileLegacyReservations,recoverPendingUsage} from './usage-budget';
import {WorkerLanes} from './worker-lanes';
import {openSync,closeSync,unlinkSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {dataDir} from './db';
// A per-database process lock fences new workers. Migration CLI also requires old-version workers stopped.
const lock=path.join(dataDir,'worker.lock');
try{const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);}catch{let alive=true;try{process.kill(Number(readFileSync(lock,'utf8')),0);}catch{alive=false;}if(alive)throw Error('已有后台正在运行，拒绝启动第二个发送者');unlinkSync(lock);const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);}
process.on('exit',()=>{try{if(readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);}catch{}});
reconcileLegacyReservations();recoverPendingUsage();beatWorker();
// Exclusive worker lock held. Resume only journaled read-only research, prior to delivery.
exec("UPDATE runs SET status='queued',phase='research_resume' WHERE mode='feishu_ingest' AND status='running' AND id IN (SELECT run_id FROM research_items)");
let quitting=false;const lanes=new WorkerLanes();
const pulse=setInterval(()=>beatWorker(),5000);pulse.unref();
const stop=()=>{quitting=true;clearInterval(pulse);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
const dedicated=['feishu_ingest','library','weekly','observation'];
async function execute(run:Run){const pulse=setInterval(()=>exec("UPDATE runs SET heartbeat=? WHERE id=? AND status='running'",now(),run.id),2000);try{if(run.mode==='feishu_ingest')await processFeishu(run,feishuTransport);else if(run.mode==='library')await processLibrary(run);else if(run.mode==='weekly')await processWeekly(run);else if(run.mode==='observation')await processObservation(run);else await processRun(run);}catch{exec("UPDATE runs SET status='failed',finished_at=?,error='后台作业未完成；原始输入已保留' WHERE id=? AND status='running'",now(),run.id);}finally{clearInterval(pulse);}}
async function loop(){while(!quitting){
 exec("UPDATE runs SET status='failed',phase='interrupted',error='后台执行中断，已保留原始输入；未自动重试。',finished_at=? WHERE status='running' AND heartbeat<?",now(),new Date(Date.now()-30000).toISOString());
 recoverPendingUsage();recoverLibrary();tickWeekly();tickObservations();
 lanes.launch('connection',syncFeishu);
 lanes.launch('delivery',async()=>{collectNotifications();await deliverNotification();});
 for(const mode of dedicated)if(!lanes.busy(mode)){const run=claim([mode]);if(run)lanes.launch(mode,()=>execute(run));}
 if(!lanes.busy('general')){const run=claim(dedicated,true);if(run)lanes.launch('general',()=>execute(run));}
 if(!lanes.busy('library')&&!lanes.busy('feishu_ingest'))lanes.launch('index',async()=>{await indexCards();await indexLibrary();});
 await new Promise(r=>setTimeout(r,1000));
 }await lanes.drain();process.exit(0);}
console.log('知衡后台已启动：雷达、资料、会话、发送分别排队；只运行已授权任务。');
loop().catch(()=>{console.error('后台停止，请检查本机运行状态');process.exit(1);});
