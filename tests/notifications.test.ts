import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {webcrypto} from 'node:crypto';

process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-notifications-'));
process.env.AGENT_TEST_MODE='1';
const sql=await import('../server/db');
const n=await import('../server/notifications');
const hook='https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-8000-000000000000';
const secret='synthetic-notification-signing-secret';
const responses=(value:unknown,status=200)=>(async()=>new Response(JSON.stringify(value),{status})) as typeof fetch;
beforeEach(()=>{sql.exec('DELETE FROM notification_outbox');sql.exec('DELETE FROM runs');sql.exec('DELETE FROM topics');n.disconnectNotifications();});
after(()=>{sql.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true});});
function enable(){n.saveNotifications({webhook:hook,secret,enabled:true});sql.exec("UPDATE notification_settings SET enabled_at='2026-01-01T00:00:00.000Z'");}
function run(mode='check',status='succeeded',at='2026-02-01T00:00:00.000Z'){
 const key=sql.id();sql.exec('INSERT INTO runs(id,mode,status,revision,created_at,finished_at,result) VALUES(?,?,?,?,?,?,?)',key,mode,status,0,at,at,JSON.stringify({judgment:'测试样例：订单仍未得到直接验证',changes:'测试样例：新增一份材料',uncertainties:['测试样例：回款质量未知'],evidence_sufficient:false}));return key;
}
test('notification credentials are private, omitted from snapshots and rejected for arbitrary endpoints',()=>{
 n.saveNotifications({webhook:hook,secret,enabled:false});const value=n.notificationSnapshot();assert.equal(value.configured,true);assert.equal(value.enabled,false);assert.equal(value.signed,true);assert.ok(!JSON.stringify(value).includes(secret));assert.ok(!JSON.stringify(value).includes(hook));
 assert.equal(statSync(path.join(sql.dataDir,'notification-credentials.json')).mode&0o777,0o600);
 for(const url of ['http://127.0.0.1:1234/hook',hook+'?redirect=x',hook.replace('open.feishu.cn','open.feishu.cn.evil.test'),hook+'#x'])assert.throws(()=>n.saveNotifications({webhook:url,enabled:false}));
});
test('Feishu signature uses seconds and HMAC of empty bytes with timestamp-newline-secret key',async()=>{
 const payload=n.feishuPayload('测试样例',secret,'1599360473');const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode('1599360473\n'+secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 assert.equal(await webcrypto.subtle.verify('HMAC',key,Buffer.from(payload.sign!,'base64'),new Uint8Array()),true);assert.equal(payload.timestamp,'1599360473');assert.equal(n.feishuPayload('测试样例','').sign,undefined);
});
test('enable skips historical backlog and ordinary chat; collection and delivery are deduplicated',async()=>{
 run('weekly','succeeded','2025-12-01T00:00:00.000Z');run('chat');enable();const key=run();n.collectNotifications();n.collectNotifications();assert.equal(n.notificationSnapshot().receipts.length,1);assert.equal(sql.one<{run_id:string}>('SELECT run_id FROM notification_outbox')!.run_id,key);
 let sent=0;await Promise.all([n.deliverNotification((async()=>{sent++;return new Response('{"code":0}')}) as typeof fetch),n.deliverNotification(responses({code:0}))]);n.collectNotifications();assert.equal(sent,1);assert.equal(n.notificationSnapshot().receipts[0].status,'sent');assert.equal(n.notificationSnapshot().receipts.length,1);
});
test('ordinary chats do not starve notifications; button-delegated auto runs are eligible',()=>{
 enable();for(let i=0;i<105;i++)run('chat');const delegated=run('auto');sql.event(delegated,'continuation_requested',{stateId:'synthetic'});n.collectNotifications();assert.equal(n.notificationSnapshot().receipts.length,1);
});
test('partial task message preserves evidence gaps and official source timestamps',async()=>{
 enable();const key=run('check','partial');sql.exec('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)',sql.id(),key,'测试公告','https://www.cninfo.com.cn/test','测试正文',null,'2026-02-01T00:00:00.000Z','body','test');n.collectNotifications();let payload:Record<string,any>={};
 await n.deliverNotification((async(_url,init)=>{payload=JSON.parse(String(init?.body));assert.equal(init?.redirect,'error');return new Response('{"code":0}');}) as typeof fetch);
 assert.match(payload.content.text,/部分完成/);assert.match(payload.content.text,/证据仍有缺口/);assert.match(payload.content.text,/公开来源/);assert.match(payload.content.text,/读取于/);assert.ok(payload.sign);assert.ok(!payload.content.text.includes('127.0.0.1'));
});
test('paused topics and corrected or deleted results cannot be sent from the queue',async()=>{
 enable();const topic=sql.id(),at=sql.now();sql.exec('INSERT INTO topics VALUES(?,?,?,?,?,?)',topic,'测试样例','问题','active',at,at);const key=run();sql.exec('UPDATE runs SET topic_id=? WHERE id=?',topic,key);n.collectNotifications();sql.exec("UPDATE topics SET status='paused' WHERE id=?",topic);
 const noSend=(async()=>{assert.fail('invalidated result was sent');}) as typeof fetch;await n.deliverNotification(noSend);assert.equal(n.notificationSnapshot().receipts[0].status,'cancelled');
 const corrected=run();n.collectNotifications();sql.exec("UPDATE runs SET status='stale' WHERE id=?",corrected);await n.deliverNotification(noSend);assert.equal(n.notificationSnapshot().receipts[0].status,'cancelled');
 const deleted=run();n.collectNotifications();sql.exec('DELETE FROM runs WHERE id=?',deleted);await n.deliverNotification(noSend);assert.ok(!sql.one('SELECT id FROM notification_outbox WHERE run_id=?',deleted));
});
test('disable and destination changes cancel queued delivery; test can run while auto delivery is off',async()=>{
 enable();run();n.collectNotifications();n.saveNotifications({enabled:false});await n.deliverNotification((async()=>assert.fail('disabled delivery')) as typeof fetch);assert.equal(n.notificationSnapshot().receipts[0].status,'cancelled');
 const key=n.requestNotificationTest();assert.equal(n.requestNotificationTest(),key);await n.deliverNotification(responses({code:0}));assert.equal(sql.one<{status:string}>('SELECT status FROM notification_outbox WHERE id=?',key)!.status,'sent');assert.throws(()=>n.requestNotificationTest(),/30/);
 n.saveNotifications({webhook:hook.replace('000000000000','111111111111'),enabled:false});assert.equal(n.notificationSnapshot().signed,false);
});
test('provider refusal is not success even with legacy zero; diagnostics do not retain raw secrets',async()=>{
 enable();run();n.collectNotifications();await n.deliverNotification(responses({code:19021,StatusCode:0,msg:secret+hook}));const receipt=n.notificationSnapshot().receipts[0];assert.equal(receipt.status,'failed');assert.match(receipt.error!,/19021/);assert.ok(!JSON.stringify(receipt).includes(secret));assert.ok(!JSON.stringify(receipt).includes(hook));
 n.retryNotification(receipt.id);await n.deliverNotification(responses({code:0}));assert.equal(n.notificationSnapshot().receipts[0].status,'sent');
});
test('ambiguous timeout and interrupted POSTs are never automatically resent',async()=>{
 enable();run();n.collectNotifications();await n.deliverNotification((async()=>{throw Error(hook+secret)}) as typeof fetch);const receipt=n.notificationSnapshot().receipts[0];assert.equal(receipt.status,'unknown');assert.ok(!receipt.error!.includes(secret));n.collectNotifications();await n.deliverNotification((async()=>assert.fail('automatic resend')) as typeof fetch);
 sql.exec("UPDATE notification_outbox SET status='sending',updated_at='2026-01-01T00:00:00.000Z'");await n.deliverNotification((async()=>assert.fail('crash resend')) as typeof fetch);assert.equal(n.notificationSnapshot().receipts[0].status,'unknown');
});
test('revised weekly versions are suppressed; message preserves report range and partial status',async()=>{
 enable();const key=run('weekly','partial'),review=sql.id();sql.exec('INSERT INTO weekly_reviews VALUES(?,?,?,?,?,?)',review,'2026-01-25T16:00:00.000Z','2026-02-01T16:00:00.000Z','manual',null,sql.now());sql.exec('INSERT INTO weekly_versions VALUES(?,?,?)',key,review,sql.now());
 sql.exec('UPDATE runs SET result=? WHERE id=?',JSON.stringify({logic:[{title:'测试样例：订单假设',assessment:{text:'测试样例：担心不是规则'}}],unresolved:[{text:'测试样例：需求待验证'}]}),key);
 n.collectNotifications();let text='';await n.deliverNotification((async(_u,init)=>{text=JSON.parse(String(init?.body)).content.text;return new Response('{"code":0}')}) as typeof fetch);assert.match(text,/回顾范围/);assert.match(text,/担心不是规则/);assert.match(text,/部分完成/);
 const retry=run('weekly','partial');sql.exec('INSERT INTO weekly_versions VALUES(?,?,?)',retry,review,sql.now());n.collectNotifications();sql.exec('INSERT INTO weekly_versions VALUES(?,?,?)',run('weekly','queued'),review,sql.now());await n.deliverNotification((async()=>assert.fail('old weekly version')) as typeof fetch);assert.equal(sql.one<{status:string}>('SELECT status FROM notification_outbox WHERE run_id=?',retry)!.status,'cancelled');
});
test('queued receipts survive a separate process without browser or model calls',async()=>{
 n.saveNotifications({webhook:hook,enabled:false});const key=n.requestNotificationTest();
 await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',"import {notificationSnapshot} from './server/notifications.ts';if(!notificationSnapshot().receipts.some(r=>r.status==='queued'))process.exit(2);"],{cwd:process.cwd(),env:process.env,stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('persistence check failed')));});
 assert.equal(n.notificationSnapshot().receipts[0].id,key);const raw=readFileSync(path.join(sql.dataDir,'notification-credentials.json'),'utf8');assert.ok(raw.includes(hook));
});
