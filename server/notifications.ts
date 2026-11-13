import {catalog as radarCatalog} from './feishu/unified-store';
import {strategyCard} from './feishu/strategy-card';
import {stampDelivery,routeGuard,startAttempt,finishAttempt,sendRadar,routeReady} from './feishu/radar-delivery';
import {radarRoute,profile,profilePresent} from './feishu/unified-store';
import {feishuResult,sendFeishu} from './feishu/receiver';
import {feishuTransport} from './feishu/runtime';
import {existsSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import path from 'node:path';
import {db,dataDir,all,one,exec,id,now,transaction,type Run} from './db';
import {safePublicUrl} from './security';

// Secrets never enter SQLite, exports, snapshots, or notification receipts.
const credentialsPath=path.join(dataDir,'notification-credentials.json');
type Credentials={webhook:string;secret:string;generation?:number};
type Settings={enabled:number;enabled_at:string|null;generation:number};
type Receipt={id:string;run_id:string|null;kind:string;status:string;generation:number;created_at:string;updated_at:string;error:string|null};
db.exec(`CREATE TABLE IF NOT EXISTS notification_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,enabled_at TEXT,generation INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO notification_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT);
CREATE INDEX IF NOT EXISTS notification_queue ON notification_outbox(status,created_at);`);

function credentials():Credentials {
 if(!existsSync(credentialsPath))return {webhook:'',secret:''};
 try{return JSON.parse(readFileSync(credentialsPath,'utf8'));}catch{throw Error('通知配置无法读取，请重新保存飞书连接');}
}
const settings=()=>one<Settings>('SELECT * FROM notification_settings WHERE id=1')!;
export function validWebhook(value:string){return /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]{16,100}$/.test(value);}
export function notificationSnapshot(){
 const c=credentials(),s=settings();
 return {configured:!!c.webhook,signed:!!c.secret,enabled:!!s.enabled,receipts:all<Receipt>('SELECT * FROM notification_outbox ORDER BY created_at DESC,rowid DESC LIMIT 10')};
}
export function saveNotifications(input:{webhook?:string;secret?:string;enabled:boolean}){
 transaction(()=>{
 const old=credentials(),c={webhook:input.webhook??old.webhook,secret:input.secret??(input.webhook!==undefined&&input.webhook!==old.webhook?'':old.secret)},s=settings();
 if(c.webhook&&!validWebhook(c.webhook))throw Error('请填写飞书自定义机器人的 HTTPS Webhook 地址');
 if(input.enabled&&!c.webhook)throw Error('请先保存飞书 Webhook');
 const changed=c.webhook!==old.webhook||c.secret!==old.secret;
  // A new destination or a fresh enable starts a new epoch: no historical flood.
  if(changed||old.generation!==s.generation||Number(input.enabled)!==s.enabled){
   // A crash between file replacement and DB commit fails closed via generation.
   const temp=credentialsPath+'.tmp';writeFileSync(temp,JSON.stringify({...c,generation:s.generation+1}),{mode:0o600});chmodSync(temp,0o600);renameSync(temp,credentialsPath);
   exec("UPDATE notification_outbox SET status='cancelled',updated_at=?,error='通知已关闭或连接已变更' WHERE status='queued' AND kind!='library_feishu' AND (kind!='observation' OR NOT EXISTS(SELECT 1 FROM feishu_delivery_meta m WHERE m.receipt_id=notification_outbox.id AND m.channel='app'))",now());
   exec('UPDATE notification_settings SET enabled=?,enabled_at=?,generation=generation+1 WHERE id=1',input.enabled?1:0,input.enabled?now():null);
  }
 });
}
export function disconnectNotifications(){saveNotifications({webhook:'',secret:'',enabled:false});}
export function requestNotificationTest(){
 if(!credentials().webhook)throw Error('请先保存飞书 Webhook');
 return transaction(()=>{
  const active=one<{id:string}>("SELECT id FROM notification_outbox WHERE kind='test' AND status IN ('queued','sending')");if(active)return active.id;
  if(one("SELECT id FROM notification_outbox WHERE kind='test' AND created_at>?",new Date(Date.now()-30000).toISOString()))throw Error('刚刚已请求测试，请等待 30 秒再试');
  const key=id(),at=now();exec("INSERT INTO notification_outbox VALUES(?,NULL,'test','queued',?,?,?,NULL)",key,settings().generation,at,at);return key;
 });
}
function eligible(run:Run){if(run.mode==='observation'){try{return JSON.parse(run.result||'{}').observation?.notify===true;}catch{return false;}}return !!run.task_id||run.mode==='weekly'||run.mode==='check'||!!one("SELECT id FROM events WHERE run_id=? AND type='continuation_requested'",run.id);}
function current(run:Run){
 if(!['succeeded','partial','failed','blocked'].includes(run.status))return false;
 if(run.mode==='observation'){
  const result=JSON.parse(run.result||'{}').observation;
  const task=one<{config_version:number;epoch:number;ends_at:string|null}>('SELECT config_version,epoch,ends_at FROM observation_tasks WHERE task_id=?',run.task_id);
  if(!result||!task||task.config_version!==result.taskVersion||task.epoch!==result.epoch||result.expiresAt<=now()||task.ends_at&&task.ends_at<=now())return false;
 }
 if(run.topic_id&&one<{status:string}>('SELECT status FROM topics WHERE id=?',run.topic_id)?.status!=='active')return false;
 if(run.task_id){const task=one<{status:string;last_run_id:string|null}>('SELECT status,last_run_id FROM tasks WHERE id=?',run.task_id);if(task?.status!=='active'||(task.last_run_id&&task.last_run_id!==run.id))return false;}
 // An older weekly version must not be delivered after a newer retry exists.
 if(run.mode==='weekly'&&one(`SELECT v.run_id FROM weekly_versions v JOIN weekly_versions owner ON owner.review_id=v.review_id WHERE owner.run_id=? AND v.rowid>owner.rowid`,run.id))return false;
 return true;
}
export function collectNotifications(){
 for(const r of all<Run>("SELECT * FROM runs WHERE mode IN ('library','feishu_ingest') AND status IN ('succeeded','partial','failed') AND NOT EXISTS(SELECT 1 FROM notification_outbox n WHERE n.run_id=runs.id)")){const result=feishuResult(r);if(result){const at=now();exec('INSERT OR IGNORE INTO notification_outbox VALUES(?,?,?,?,?,?,?,NULL)',id(),r.id,'library_feishu','queued',result.generation,at,at);}}
 const s=settings();if(!s.enabled||!s.enabled_at)return;
 transaction(()=>{
  const runs=all<Run&{finished_at:string|null}>(`SELECT * FROM runs WHERE status IN ('succeeded','partial','failed','blocked') AND (task_id IS NOT NULL OR mode IN ('weekly','check') OR EXISTS (SELECT 1 FROM events e WHERE e.run_id=runs.id AND e.type='continuation_requested')) AND COALESCE(finished_at,created_at)>=? AND NOT EXISTS (SELECT 1 FROM notification_outbox n WHERE n.run_id=runs.id) ORDER BY COALESCE(finished_at,created_at)`,s.enabled_at);
  for(const r of runs){if(!eligible(r)||!current(r)||profilePresent()&&r.mode!=='observation')continue;const route=radarRoute();if(r.mode==='observation'&&((r.finished_at||r.created_at)<route.cutoff||!routeReady()||route.channel==='app'&&!profile()?.taskIds.includes(r.task_id!)))continue;const at=now(),receipt=id();exec('INSERT OR IGNORE INTO notification_outbox VALUES(?,?,?,?,?,?,?,NULL)',receipt,r.id,r.mode==='weekly'?'weekly':r.mode==='observation'?'observation':'task','queued',s.generation,at,at);if(r.mode==='observation'&&!stampDelivery(receipt,r))exec("UPDATE notification_outbox SET status='cancelled',error='事件已由同一逻辑目标收取，未重复入队' WHERE id=?",receipt);}
 });
}
const clip=(x:unknown,n=400)=>typeof x==='string'?x.slice(0,n):'';
const stamp=(at:string)=>new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function notificationText(item:Receipt){
 if(item.kind==='test')return '知衡 · 飞书连接测试\n这是一条测试通知，不是投资分析。\n之后可接收每周回顾与委托核实任务的结果。自动通知是否开启，以知衡设置为准。';
 const run=one<Run&{finished_at:string}>('SELECT * FROM runs WHERE id=?',item.run_id);if(!run||!eligible(run)||!current(run))return null;
 if(run.mode==='observation'){const text=clip(JSON.parse(run.result||'{}').observation?.text,7000);if(!text)return null;if(!text.includes('知衡｜策略观察'))return text;radarCatalog();const refs=all<{number:number}>('SELECT e.number FROM radar_event_refs e JOIN observation_signals s ON s.id=e.signal_id WHERE s.run_id=?',run.id).map(e=>'E-'+e.number);return text+'\n'+(refs.length?'事件 '+refs.join('、')+'；@知衡 并带编号发送“查看证据 / 查看全部对象”；私聊可带编号分析。':'查看依据：开发电脑上的知衡 → 持续观察 → 检查记录。')+'\n运行诊断保存在本机，不提供无法访问的手机链接。';}
 const label=run.status==='succeeded'?'已完成':run.status==='partial'?'部分完成':'未完成';
 const lines=[`知衡 · ${item.kind==='weekly'?'每周回顾':'委托核实'}${label}`,`执行时间：${stamp(run.finished_at||item.created_at)}（北京时间）`];
 const title=run.task_id?one<{title:string}>('SELECT title FROM tasks WHERE id=?',run.task_id)?.title:run.topic_id?one<{title:string}>('SELECT title FROM topics WHERE id=?',run.topic_id)?.title:null;
 if(title)lines.push('关注事项：'+clip(title,100));
 if(['failed','blocked'].includes(run.status)){lines.push('本次未取得可交付结果。请回到本机知衡查看失败原因后重试；未自动重复调用模型。');return lines.join('\n');}
 let result;try{result=JSON.parse(run.result||'null')}catch{return null;}if(!result)return null;
 if(item.kind==='weekly'){
  const review=one<{period_start:string;period_end:string}>('SELECT w.* FROM weekly_reviews w JOIN weekly_versions v ON v.review_id=w.id WHERE v.run_id=?',run.id);
  if(review)lines.push(`回顾范围：${stamp(review.period_start)} — ${stamp(review.period_end)}`);
  for(const logic of (Array.isArray(result.logic)?result.logic:[]).slice(0,2))lines.push(clip(logic.title,80)+'：'+clip(logic.assessment?.text,280));
  if(!result.logic?.length)for(const f of (Array.isArray(result.focus)?result.focus:[]).slice(0,2))lines.push(clip(f.text,280));
  const gap=result.unresolved?.[0]?.text;if(gap)lines.push('仍待厘清：'+clip(gap,180));
 }else{
  lines.push('本次判断（模型整理）：'+clip(result.judgment));
  if(result.changes)lines.push('这次的变化：'+clip(result.changes,240));
  if(result.uncertainties?.[0])lines.push('仍待核实：'+clip(result.uncertainties[0],180));
  lines.push(result.evidence_sufficient===true?'本次证据核对通过；不代表投资结果已确定。':'当前证据仍有缺口，请勿将整理结果视为已经核实的事实。');
  for(const e of all<{title:string;url:string;retrieved_at:string}>('SELECT title,url,retrieved_at FROM evidence WHERE run_id=? ORDER BY rowid LIMIT 3',run.id))if(safePublicUrl(e.url))lines.push(`公开来源：${clip(e.title,80)}\n${e.url}\n读取于：${stamp(e.retrieved_at)}`);
 }
 if(run.status==='partial')lines.push('仅保留通过核对的部分，完整范围及缺口见本机结果。');
 lines.push('在运行知衡的 Mac 上查看完整依据。手机暂不能直接打开本机页面。');
 return lines.filter(Boolean).join('\n');
}
export function feishuPayload(text:string,secret:string,timestamp=Math.floor(Date.now()/1000).toString(),card=false){
 return {...(card?{msg_type:'interactive',card:strategyCard(text)}:{msg_type:'text',content:{text}}),...(secret?{timestamp,sign:createHmac('sha256',timestamp+'\n'+secret).update('').digest('base64')}:{})};
}
export async function deliverNotification(send:typeof fetch=fetch){
 // An interrupted/ambiguous POST is not safe to retry automatically.
 exec("UPDATE notification_outbox SET status='unknown',error='发送中断，飞书可能已接收；未自动重发，请先查看群消息',updated_at=? WHERE status='sending' AND updated_at<?",now(),new Date(Date.now()-60000).toISOString());
 exec("UPDATE feishu_delivery_attempts SET status='unknown',error='发送中断，未自动重发' WHERE status='sending' AND receipt_id IN (SELECT id FROM notification_outbox WHERE status='unknown')");
 const item=transaction(()=>{const r=one<Receipt>("SELECT * FROM notification_outbox WHERE status='queued' ORDER BY created_at,rowid LIMIT 1");if(!r)return null;exec("UPDATE notification_outbox SET status='sending',updated_at=? WHERE id=?",now(),r.id);return r;});if(!item)return;
 const finish=(status:string,error:string|null=null)=>transaction(()=>{exec('UPDATE notification_outbox SET status=?,error=?,updated_at=? WHERE id=?',status,error,now(),item.id);finishAttempt(item.id,status,error);});
 try{
  if(process.env.AGENT_TEST_MODE==='1'&&send===fetch){finish('cancelled','隔离测试禁止向外部通知渠道发送');return;}
  if(item.kind==='observation'){if(!settings().enabled){finish('cancelled','通知已关闭');return;}const run=one<Run>('SELECT * FROM runs WHERE id=?',item.run_id);if(!run){finish('cancelled','来源已删除');return;}if(!stampDelivery(item.id,run)){finish('cancelled','事件已有通知记录，未重复发送');return;}if(!routeGuard(item.id)||!notificationText(item)){finish('cancelled','旧路由、来源失效或任务已暂停');return;}startAttempt(item.id);if(radarRoute().channel==='app'){const result=await sendRadar(run,item.id,feishuTransport);finish(result.status,result.error);return;}}
  if(item.kind==='library_feishu'){const run=one<Run>('SELECT * FROM runs WHERE id=?',item.run_id);if(!run){finish('cancelled','来源已删除');return;}startAttempt(item.id);const result=await sendFeishu(run,item.id,feishuTransport);finishAttempt(item.id,result.status,result.error,result.messageId);finish(result.status,result.error);return;}
  if(profilePresent()&&item.kind!=='observation'&&item.kind!=='test'){finish('cancelled','统一入口开启后，私人回顾/任务结果仅在本机查看，未授权发群');return;}
  const s=settings(),c=credentials();
  if(!c.webhook||c.generation!==s.generation||s.generation!==item.generation||(!s.enabled&&item.kind!=='test')){finish('cancelled','通知已关闭、连接已变更或配置待重新保存');return;}
  const body=notificationText(item);if(!body){finish('cancelled','来源已删除、纠正、暂停或被新版本替代');return;}
  if(!validWebhook(c.webhook)){finish('failed','飞书地址格式不正确，请重新保存');return;}
  // Never allow generated text to leak a saved secret or mention a group member.
  let text=body.replace(/https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[^\s]+/g,'[私密连接已隐藏]').replace(/[<>]/g,'');
  for(const value of [c.webhook,c.secret])if(value)text=text.split(value).join('[已隐藏]');
  const response=await send(c.webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(feishuPayload(text,c.secret,undefined,item.kind==='observation'&&text.includes('知衡｜策略观察'))),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok){finish(response.status>=500?'unknown':'failed',`飞书 HTTP ${response.status}；请检查机器人配置后手动处理，未自动重发`);return;}
  const result=await response.json();
  const code=typeof result.code==='number'?result.code:typeof result.StatusCode==='number'?result.StatusCode:null;
  if(code===0){finish('sent');return;}
  finish(code===null?'unknown':'failed',code===null?'飞书返回无法识别，未自动重发':`飞书拒绝发送（错误码 ${code}）；请检查签名、关键词或机器人状态`);
 }catch{finish('unknown','网络超时或发送中断，飞书可能已接收；未自动重发，请先查看群消息');}
}
export function retryNotification(key:string){
 const receipt=one<Receipt>('SELECT * FROM notification_outbox WHERE id=?',key);
 if(!receipt||!['failed','unknown'].includes(receipt.status))throw Error('这条通知当前不可重试');
 if(receipt.kind==='observation')throw Error('雷达通知不自动重发；请核对平台消息和路由状态，避免重复推送');
 if(receipt.kind==='library_feishu')throw Error('资料回复请在原对话重新查询；未知发送结果不盲目重发');
 if(!credentials().webhook||(!settings().enabled&&receipt.kind!=='test'))throw Error('请先连接并开启通知');
 if(!notificationText(receipt))throw Error('来源已失效，不能重发旧结果');
 exec("UPDATE notification_outbox SET status='queued',generation=?,error=NULL,updated_at=? WHERE id=?",settings().generation,now(),key);
}
