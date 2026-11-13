import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';
mkdirSync('artifacts',{recursive:true});
const data=mkdtempSync(path.join(tmpdir(),'zhiheng-ui-test-')),base='http://127.0.0.1:3211';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3211'],{env:{...process.env,AGENT_DATA_DIR:data,AGENT_TEST_MODE:'1',MOONSHOT_API_KEY:'',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});let log='',browser;server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b);
const api=async body=>{const r=await fetch(base+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw Error(result.error);return result};
async function verifyOfflineRecovery(page){
 await page.route('**/api/agent',route=>route.abort('failed'));
 await page.getByLabel('说说你的想法').fill('测试样例：断线时保留这段草稿');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.locator('.error-banner[role=alert]')).toContainText('连接不到本机服务');
 await expect(page.getByLabel('说说你的想法')).toHaveValue('测试样例：断线时保留这段草稿');
 await page.unroute('**/api/agent');
 await expect(page.locator('.error-banner[role=alert]')).toHaveCount(0,{timeout:8000});
 await page.reload();
 await expect(page.getByLabel('说说你的想法')).toHaveValue('测试样例：断线时保留这段草稿');
 await page.getByLabel('说说你的想法').fill('');
}
async function verifyLibrary(page){
 await page.getByRole('button',{name:'资料与想法',exact:true}).click();const panel=page.locator('.library-panel');
 await panel.getByLabel('记录原文',{exact:true}).fill('测试样例：我怀疑需求改善的证据不够，代码600001需要核实。');await panel.getByLabel('保存方式',{exact:true}).selectOption('note');await panel.getByLabel('收藏说明',{exact:true}).fill('测试样例：保存疑问，不代表看多。');await panel.getByRole('button',{name:'保存并整理',exact:true}).click();await expect(panel.locator('.library-detail')).toContainText('原文：已保存');
 await panel.getByLabel('记录批注',{exact:true}).fill('测试样例：我只是学习库存方法，不是看好行业。');await panel.getByLabel('这是纠正：旧批注转为历史，后续以这次表达为准',{exact:true}).check();await panel.getByRole('button',{name:'保存批注',exact:true}).click();await expect(panel.locator('.library-detail')).toContainText('v2');
 await panel.getByLabel('找回资料',{exact:true}).fill('库存方法');await panel.getByRole('button',{name:'搜索',exact:true}).click();await expect(panel.locator('.library-list')).toContainText('库存方法');
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Library mobile overflow');await page.screenshot({path:'artifacts/library-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'artifacts/library-desktop.png',fullPage:true});
 const exported=await(await fetch(base+'/api/export')).json();if(!exported.library_entries.length||!exported.libraryAssets.length)throw Error('Library export missing');if(JSON.stringify(exported).includes('appSecret'))throw Error('Feishu credentials exposed');
 await panel.getByRole('button',{name:'删除这条记录',exact:true}).click();await panel.getByRole('button',{name:'确认删除记录',exact:true}).click();await panel.getByRole('button',{name:'搜索',exact:true}).click();await expect(panel.locator('.library-list article')).toHaveCount(0);
 await panel.getByLabel('记录原文',{exact:true}).fill('测试样例：仅分析资料，不长期收藏。');await panel.getByLabel('保存方式',{exact:true}).selectOption('analyze');await panel.getByRole('button',{name:'保存并整理',exact:true}).click();await expect(panel.locator('.library-detail')).toContainText('未加入长期索引');await panel.getByRole('button',{name:'确认加入收藏',exact:true}).click();await expect(panel.getByRole('button',{name:'确认加入收藏',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await page.reload();await page.getByRole('button',{name:'资料与想法',exact:true}).click();await expect(page.locator('.library-list')).toContainText('仅分析资料');await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
}
async function verifyObservations(page){
 await page.getByRole('button',{name:'回到今天',exact:true}).click();await page.getByLabel('说说你的想法').fill('请创建A股主线机会雷达，持续帮我观察A股未来2—4周可能形成的主线机会，有新变化再提醒。');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.transcript')).toContainText('草稿');
 await page.getByRole('button',{name:'回到今天',exact:true}).click();await page.getByRole('button',{name:/持续观察.*让市场观察/}).click();const panel=page.locator('.observation-panel');await expect(panel).toContainText('非全市场');await panel.locator('.observation-select').first().click();await expect(panel).toContainText('运行到期');await panel.getByRole('button',{name:'启用观察',exact:true}).click();await expect(panel.getByRole('button',{name:'暂停观察',exact:true})).toBeVisible();await panel.getByRole('button',{name:'现在检查一次',exact:true}).click();await expect(panel).toContainText('排队中');
 await panel.getByRole('button',{name:'暂停观察',exact:true}).click();await expect(panel.getByRole('button',{name:'恢复观察',exact:true})).toBeVisible();await panel.getByRole('button',{name:'调整配置',exact:true}).click();await panel.getByLabel('运行期限（天；留空直到手动结束）',{exact:true}).fill('28');await panel.getByRole('button',{name:'保存观察配置',exact:true}).click();await expect(panel).toContainText('配置 v2');await panel.getByRole('button',{name:'恢复观察',exact:true}).click();
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Observation mobile overflow');await page.screenshot({path:'artifacts/observation-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'artifacts/observation-desktop.png',fullPage:true});
 await panel.getByRole('button',{name:'回放过去四周已采集的记录'}).click();await expect(panel).toContainText('不发送通知');await panel.getByRole('button',{name:'结束任务',exact:true}).click();await expect(panel.locator('.observation-detail')).toContainText('已结束');
 const exported=await(await fetch(base+'/api/export')).json();if(!exported.observation_tasks.length||!exported.observation_configs.length)throw Error('Observation export missing');
 await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await page.reload();await page.getByRole('button',{name:/持续观察.*让市场观察/}).click();await expect(page.locator('.observation-select')).toContainText('已结束');await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
}
async function verifyThemeRadar(page){
 await page.getByRole('button',{name:/持续观察.*让市场观察/}).click();const panel=page.locator('.observation-panel');await panel.getByRole('button',{name:'新建观察任务',exact:true}).click();await expect(panel.getByLabel('观察模式',{exact:true})).toHaveValue('theme_watch');await expect(panel).toContainText('半导体国产替代');await expect(panel).toContainText('具身智能');await expect(panel).toContainText('端侧AI');await panel.getByLabel('观察目标',{exact:true}).fill('测试样例：三主题隔离体检');await panel.getByRole('button',{name:'保存观察配置',exact:true}).click();await panel.getByRole('button',{name:'启用观察',exact:true}).click();await panel.getByRole('button',{name:'现在检查一次',exact:true}).click();
 const response=await(await fetch(base+'/api/observation')).json(),task=response.tasks.find(t=>t.config.goal==='测试样例：三主题隔离体检');if(!task)throw Error('Theme task not persisted');
 await new Promise((resolve,reject)=>{const code=`import {one,exec} from './server/db.ts';import './server/notifications.ts';import {processObservation} from './server/observation/service.ts';import {collectFrame} from './server/observation/provider.ts';const r=one("SELECT * FROM runs WHERE task_id=? AND status='queued'",${JSON.stringify(task.id)});exec("UPDATE runs SET status='running' WHERE id=?",r.id);await processObservation({...r,status:'running'},async(c,s,t,clock)=>{const f=await collectFrame(c,s,async()=>new Response('SYNTHETIC unavailable',{status:501}),clock);f.synthetic=true;return f});const done=one('SELECT * FROM runs WHERE id=?',r.id);const check=one('SELECT * FROM observation_checks WHERE run_id=?',r.id);if(!check.detail||!JSON.parse(check.detail).themeReport)throw Error(JSON.stringify({done,check}));`;const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:{...process.env,AGENT_DATA_DIR:data,AGENT_TEST_MODE:'1'},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',b=>output+=b);child.on('exit',c=>c===0?resolve():reject(Error(output)));child.on('error',reject)});
 const checked=await(await fetch(base+'/api/observation?task='+task.id)).json();if(!checked.checks.some(c=>c.detail&&JSON.parse(c.detail).themeReport))throw Error(JSON.stringify(checked));
 await expect(panel.locator('[aria-label="多主题体检"]').first()).toBeVisible({timeout:10000});const report=panel.locator('[aria-label="多主题体检"]').first();await expect(report.locator('.theme-stock')).toHaveCount(12);await expect(report).toContainText('宇树科技');await expect(report).toContainText('报价缺失');await expect(report).toContainText('数据不足');
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Theme radar mobile overflow');await report.scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/theme-radar-mobile.png'});await page.setViewportSize({width:1440,height:1000});
 await panel.getByRole('button',{name:'暂停观察',exact:true}).click();await panel.getByRole('button',{name:'调整配置',exact:true}).click();await panel.getByText('维护主题、股票与规则',{exact:true}).click();await panel.getByLabel('编辑主题模板',{exact:true}).selectOption('edge-ai');const definition=JSON.parse(await panel.getByLabel('主题配置JSON',{exact:true}).inputValue());definition.purpose='测试样例：修改主题目的';await panel.getByLabel('主题配置JSON',{exact:true}).fill(JSON.stringify(definition));await panel.getByRole('button',{name:'保存主题版本',exact:true}).click();await panel.getByRole('button',{name:'采用最新版本 2',exact:true}).click();await panel.getByRole('button',{name:'保存观察配置',exact:true}).click();await expect(panel).toContainText('配置 v2');await panel.getByRole('button',{name:'结束任务',exact:true}).click();await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
}

async function verifyNotifications(page){
 await page.getByRole('button',{name:'连接与设置',exact:true}).click();
 const panel=page.locator('.notification-settings');await expect(panel).toContainText('飞书通知');
 await panel.getByLabel('飞书 Webhook',{exact:true}).fill('https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-8000-000000000000');
 await panel.getByRole('button',{name:'保存飞书连接',exact:true}).click();await expect(panel).toContainText('已连接 · 自动通知尚未开启');
 await panel.getByRole('button',{name:'发送测试通知',exact:true}).click();await expect(panel).toContainText('等待后台发送');
 // No worker runs in this isolated UI test: no message is sent externally.
 await page.reload();await page.getByRole('button',{name:'连接与设置',exact:true}).click();await expect(panel).toContainText('等待后台发送');
 const state=await(await fetch(base+'/api/agent')).text();if(state.includes('00000000-0000-4000-8000-000000000000'))throw Error('Webhook exposed in snapshot');
 await panel.getByRole('button',{name:'开启自动通知',exact:true}).click();await expect(panel).toContainText('已开启 · 完成后主动告诉你');await expect(panel).toContainText('已取消');
 await panel.getByRole('button',{name:'关闭自动通知',exact:true}).click();await expect(panel).toContainText('自动通知尚未开启');
 const exportData=await(await fetch(base+'/api/export')).text();if(!exportData.includes('notification_outbox')||exportData.includes('00000000-0000-4000-8000-000000000000'))throw Error('Notification export unsafe or incomplete');
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Notification mobile overflow');await page.screenshot({path:'artifacts/notification-settings-mobile.png',fullPage:true});
 await panel.getByRole('button',{name:'移除飞书连接',exact:true}).click();await panel.getByRole('button',{name:'确认移除连接',exact:true}).click();await expect(panel.getByRole('button',{name:'发送测试通知',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
}
async function verifyContinuity(page){
 const topic=(await api({action:'topic',title:'测试样例 · 换仓前核对依据',question:'测试样例：订单假设是否有新证据？'})).id;
 const db=new DatabaseSync(path.join(data,'agent.sqlite')),record=randomUUID(),run=randomUUID(),version=randomUUID(),at=new Date().toISOString();
 const original='测试样例：我关注甲公司是因为订单可能改善，今天回落让我有点犹豫。';
 db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(record,topic,'user','message',original,at,null);
 db.prepare('INSERT INTO record_context VALUES(?,?,?)').run(record,null,record);
 db.prepare('INSERT INTO runs(id,record_id,topic_id,mode,status,revision,created_at) VALUES(?,?,?,?,?,?,?)').run(run,record,topic,'review','succeeded',0,at);
 const work={thesis:{text:'测试样例：订单改善假设',owner:'user_hypothesis',sources:[record]},assessment:'测试样例：回落是这次的触发，订单假设还需要公开证据。',assumptions:[],evidence:[],change_conditions:[],open_questions:['测试样例：订单披露是否改善'],next_action:{kind:'official_search',question:'测试样例：核实甲公司的近期订单披露',reason:'测试样例：检查原来的依据'},change_summary:'测试样例：首次整理',decision_frame:{original_basis:{quote:'我关注甲公司是因为订单可能改善',source_id:record},evaluation_horizon:null,contemplated_change:null,change_trigger:null}};
 db.prepare('INSERT INTO working_states VALUES(?,?,?,?,?,?,?)').run(version,topic,run,'current',JSON.stringify(work),at,null);db.close();
 const task=(await api({action:'task',topicId:topic,title:'测试样例 · 后续核实',question:'测试样例：核实订单改善假设'})).id;
 await page.getByRole('button',{name:'回到今天',exact:true}).click();await page.getByLabel('说说你的想法').fill('');await page.reload();
 const focus=page.getByRole('article',{name:'测试样例 · 换仓前核对依据',exact:true});
 await expect(focus).toBeVisible();await expect(focus).toContainText('尚未检查');
 await focus.getByRole('button',{name:/你原来的依据/}).click();await expect(page.getByRole('dialog',{name:'原始依据'})).toContainText(original);await page.getByRole('button',{name:'关闭窗口'}).click();
 await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:'artifacts/continuity-home-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/continuity-home-mobile.png',fullPage:true});
 await focus.getByRole('button',{name:'核实这一步',exact:true}).click();await expect(focus).toContainText('等待连接模型');
 await page.reload();await expect(focus).toContainText('等待连接模型');
 const queued=await(await fetch(base+'/api/agent')).json(),request=queued.records.find(r=>r.kind==='action_request'&&r.topic_id===topic);
 if(request.parent_id!==record||request.fragment_id!==record)throw Error('Continuation lost original fragment');
 await focus.getByRole('button',{name:'查看讨论',exact:true}).click();await expect(page.locator('.user-text').filter({hasText:original})).toBeVisible();await expect(page.getByText('你委托的检查',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'回到今天',exact:true}).click();await focus.getByRole('button',{name:'理解不对',exact:true}).click();
 await focus.getByLabel('这件事哪里理解错了？').fill('测试样例：这只是我的担心，不是交易规则。');await focus.getByRole('button',{name:'保存这次纠正',exact:true}).click();
 await expect(focus).toContainText('理解已更新，待重新梳理');await expect(focus.locator('.focus-basis')).toHaveCount(0);
 await page.getByLabel('说说你的想法').fill('测试样例：正在输入的独立新想法');await focus.getByRole('button',{name:'接着纠正后的理解'}).click();await expect(page.getByLabel('说说你的想法')).toHaveValue('测试样例：正在输入的独立新想法');
 await page.getByLabel('说说你的想法').fill('');await page.reload();await expect(focus).toContainText('旧理解已停用');
 const corrected=await(await fetch(base+'/api/agent')).json();if(corrected.tasks.find(t=>t.id===task).status!=='paused')throw Error('Correction left old delegated premise active');
 if(corrected.runs.find(r=>r.record_id===request.id).status!=='cancelled')throw Error('Correction left old check runnable');
 await focus.getByRole('button',{name:'先放一放'}).click();await page.locator('.more-focus>summary').filter({hasText:/已暂停/}).click();await expect(focus).toContainText('已暂停');
 await focus.getByRole('button',{name:'恢复关注'}).click();await expect(focus).toContainText('理解已更新');
 if((await(await fetch(base+'/api/agent')).json()).runs.some(r=>r.topic_id===topic&&r.status==='queued'))throw Error('Resume silently started paid work');
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Continuity mobile overflow');
 await page.screenshot({path:'artifacts/continuity-correction-mobile.png',fullPage:true});
}

try{
 for(let i=0;i<60;i++){try{if((await fetch(base+'/api/agent')).ok)break}catch{}await new Promise(r=>setTimeout(r,500));if(i===59)throw Error(log)}
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
 await expect(page.getByRole('heading',{name:'今天，想清楚哪一步？'})).toBeVisible();await expect(page.getByLabel('说说你的想法')).toBeVisible();await expect(page.locator('.sidebar,.context-panel')).toHaveCount(0);await page.screenshot({path:'artifacts/redesign-home-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'每周回顾',exact:true}).click();await expect(page.getByRole('dialog',{name:'每周回顾'})).toBeVisible();await page.getByRole('button',{name:'关闭窗口'}).click();
 await page.goto(base+'/#weekly');await expect(page.getByRole('dialog',{name:'每周回顾'})).toBeVisible();await page.getByRole('button',{name:'关闭窗口'}).click();await page.goto(base);await expect(page.getByLabel('说说你的想法')).toBeVisible();
 await verifyOfflineRecovery(page);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/redesign-home-mobile.png',fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
 // Delay a successful POST: a user typing the next draft must not lose it.
 let releasePost,postStored;const stored=new Promise(resolve=>postStored=resolve),release=new Promise(resolve=>releasePost=resolve);
 const holdPost=async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();postStored();await release;await route.fulfill({response});};
 await page.route('**/api/agent',holdPost);
 await page.getByLabel('说说你的想法').fill('测试样例：我担心订单质量，这不是交易规则。');await page.getByLabel('只记下来',{exact:true}).check();await page.getByRole('button',{name:'发送',exact:true}).click();
 await Promise.race([stored,new Promise((_,reject)=>setTimeout(()=>reject(Error('POST fixture did not finish')),10000))]);
 await page.getByLabel('说说你的想法').fill('测试样例：正在输入的下一条草稿');releasePost();
 await expect(page.locator('.user-text').filter({hasText:'测试样例：我担心订单质量，这不是交易规则。'})).toBeVisible();
 await expect(page.getByLabel('说说你的想法')).toHaveValue('测试样例：正在输入的下一条草稿');
 await page.unroute('**/api/agent',holdPost);await page.getByLabel('说说你的想法').fill('');await page.reload();await page.locator('.fragment-card').filter({hasText:'测试样例：我担心订单质量，这不是交易规则。'}).getByRole('button').click();await expect(page.locator('.user-text').filter({hasText:'测试样例：我担心订单质量，这不是交易规则。'})).toBeVisible();
 // A new home capture must not inherit the currently open fragment or its topic.
 await page.getByRole('button',{name:'回到今天',exact:true}).click();
 await page.getByLabel('说说你的想法').fill('测试样例：这是一条独立的盘面观察。');
 await page.getByLabel('只记下来',{exact:true}).check();await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.locator('.user-text').filter({hasText:'测试样例：这是一条独立的盘面观察。'})).toBeVisible();
 await expect(page.locator('.user-text').filter({hasText:'测试样例：我担心订单质量，这不是交易规则。'})).toHaveCount(0);
 await page.getByLabel('说说你的想法').fill('测试样例：对这条观察补充一个依据。');await page.getByLabel('只记下来',{exact:true}).check();await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.locator('.user-text').filter({hasText:'测试样例：这是一条独立的盘面观察。'})).toBeVisible();
 await expect(page.locator('.user-text').filter({hasText:'测试样例：对这条观察补充一个依据。'})).toBeVisible();
 await page.reload();await expect(page.locator('.fragment-card')).toHaveCount(2);
 await page.screenshot({path:'artifacts/fragments-home-mobile.png',fullPage:true});
 await page.locator('.fragment-card').filter({hasText:'测试样例：这是一条独立的盘面观察。'}).getByRole('button').click();
 const captures=(await(await fetch(base+'/api/agent')).json()).records;
 const first=captures.find(r=>r.content==='测试样例：我担心订单质量，这不是交易规则。'),second=captures.find(r=>r.content==='测试样例：这是一条独立的盘面观察。'),reply=captures.find(r=>r.content==='测试样例：对这条观察补充一个依据。');
 if(first.fragment_id===second.fragment_id||reply.fragment_id!==second.fragment_id||reply.parent_id!==second.id)throw Error('Fragment boundaries were lost');
 // Persistent entry must also work from a conversation, without creating a task.
 await page.getByRole('button',{name:'每周回顾',exact:true}).click();await expect(page.getByRole('dialog',{name:'每周回顾'})).toBeVisible();await page.getByRole('button',{name:'关闭窗口'}).click();
 await page.getByLabel('只记下来',{exact:true}).uncheck();
 await page.getByLabel('说说你的想法').fill('测试样例：我想检查当前依据。');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByText('这一条已保存，尚未完成',{exact:true})).toBeVisible();
 const topic=(await api({action:'topic',title:'测试样例 · 订单兑现',question:'测试：订单是否兑现？'})).id;
 const db=new DatabaseSync(path.join(data,'agent.sqlite')),rec=randomUUID(),run=randomUUID(),at=new Date().toISOString();db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(rec,topic,'user','message','测试样例：我原来关注它是因为行业景气和订单兑现。',at,null);db.prepare('INSERT INTO runs(id,record_id,topic_id,mode,status,revision,created_at) VALUES(?,?,?,?,?,?,?)').run(run,rec,topic,'review','succeeded',0,at);
 const work={thesis:{text:'测试样例：订单改善是否成立',owner:'user_hypothesis',sources:[rec]},assessment:'测试样例：只有假设，还没有外部证据。',assumptions:[],evidence:[],change_conditions:[],open_questions:['测试样例：订单是否真的兑现'],next_action:null,change_summary:'测试样例：留下原来的依据。',decision_frame:{original_basis:{quote:'我原来关注它是因为行业景气和订单兑现',source_id:rec},evaluation_horizon:null,contemplated_change:null,change_trigger:null}};db.prepare('INSERT INTO working_states VALUES(?,?,?,?,?,?,?)').run(randomUUID(),topic,run,'current',JSON.stringify(work),at,null);const relation=randomUUID();const syntheticAnswer={working_state:work,judgment:'测试样例：本次尝试对照之前的订单质量担心。',reasons:[{text:'测试样例：找到原话',sources:[first.id]}],uncertainties:[],next_step:''};
 db.prepare('UPDATE runs SET result=? WHERE id=?').run(JSON.stringify(syntheticAnswer),run);
 db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(randomUUID(),topic,'assistant','analysis',JSON.stringify(syntheticAnswer),at,run);
 db.prepare('INSERT INTO memory_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(relation,run,rec,first.id,'compare','测试样例：核对订单相关的两次表达，不认为是同一笔持仓。','行业景气和订单兑现','担心订单质量',.9,'','proposed',at,at);
 db.close();
 await page.getByRole('button',{name:'回到今天',exact:true}).click();
 await page.locator('.fragment-card').filter({hasText:'我原来关注它是因为行业景气和订单兑现'}).locator('.fragment-open').click();
 await expect(page.getByLabel('这件事的判断脉络')).toContainText('原来的依据');
 await page.getByText('核对周期、条件与实际行动',{exact:true}).click();
 await expect(page.getByLabel('这件事的判断脉络')).toContainText('当前整理中未明确');
 await page.screenshot({path:'artifacts/decision-trace-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'我的脉络',exact:true}).click();await expect(page.getByRole('heading',{name:'你的判断，有迹可循。'})).toBeVisible();await expect(page.locator('.memory-card').filter({hasText:'原来的依据'})).toBeVisible();await page.screenshot({path:'artifacts/redesign-memory-desktop.png',fullPage:true});
 await page.locator('.memory-card').filter({hasText:'原来的依据'}).click();await expect(page.getByRole('dialog')).toContainText('行业景气和订单兑现');await page.locator('.source-preview').click();await expect(page.getByRole('dialog',{name:'原始依据'})).toContainText('我原来关注它');await page.getByRole('button',{name:'关闭窗口'}).click();await page.getByRole('button',{name:'关闭窗口'}).click();
 await page.getByLabel('搜索记忆').fill('订单兑现');await expect(page.locator('.memory-card').first()).toBeVisible();await page.getByLabel('清空搜索').click();await page.getByRole('button',{name:'变化脉络',exact:true}).click();await expect(page.locator('.timeline')).toContainText('留下原来的依据');await page.getByRole('button',{name:'记忆卡片',exact:true}).click();
 await api({action:'memory',content:'测试样例：我必须一直持有到两个季度后',kind:'principle',topicId:topic});await page.getByRole('button',{name:'原则',exact:true}).click();await expect(page.locator('.memory-card').filter({hasText:'测试样例：我必须一直持有'})).toBeVisible();await page.locator('.memory-card').filter({hasText:'测试样例：我必须一直持有'}).click();await page.getByRole('button',{name:'纠正这条理解'}).click();await page.getByLabel('准确的理解应该是').fill('测试样例：两个季度只是验证节点，不是持有承诺。');await page.getByRole('button',{name:'保存纠正'}).click();await page.getByRole('button',{name:'全部',exact:true}).click();await expect(page.locator('.memory-card').filter({hasText:'两个季度只是验证节点'}).first()).toBeVisible();
 // User feedback and tag corrections must persist across a browser reload.
 await page.getByRole('button',{name:'原文',exact:true}).click();
 await page.locator('.memory-card').filter({hasText:'测试样例：我担心订单质量，这不是交易规则。'}).first().click();
 await page.locator('.tag-editor').getByRole('button',{name:'订单兑现',exact:true}).click();
 await page.getByLabel('修改标签').fill('订单可信度');await page.getByRole('button',{name:'保存标签',exact:true}).click();
 await expect(page.locator('.tag-editor').getByRole('button',{name:/订单可信度/})).toBeVisible();
 await page.getByRole('button',{name:'关闭窗口'}).click();
 await page.getByRole('button',{name:'回到今天',exact:true}).click();
 await page.locator('.fragment-card').filter({hasText:'测试样例：我原来关注它是因为行业景气和订单兑现。'}).getByRole('button').click();
 await page.locator('.memory-links summary').click();
 await expect(page.locator('.memory-link')).toContainText('不认为是同一笔持仓');
 await page.getByRole('button',{name:'关联准确',exact:true}).click();await expect(page.locator('.memory-link')).toContainText('你已确认');
 await page.getByRole('button',{name:'撤销这个反馈',exact:true}).click();
 await page.getByRole('button',{name:'说明哪里不对',exact:true}).click();
 await page.getByLabel('这两条应该怎样理解？').fill('测试样例：这两次不是同一笔持仓，请不要串在一起。');
 await page.getByRole('button',{name:'保存关联纠正',exact:true}).click();await expect(page.locator('.memory-link')).toContainText('你已否认');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/memory-feedback-mobile.png',fullPage:true});
 await page.reload();await page.locator('.fragment-card').filter({hasText:'测试样例：我原来关注它是因为行业景气和订单兑现。'}).getByRole('button').click();
 await page.locator('.memory-links summary').click();await expect(page.locator('.memory-link')).toContainText('你已否认');
 await page.setViewportSize({width:1440,height:1000});
 const learned=await(await fetch(base+'/api/agent')).json();if(!learned.memoryLinks.some(l=>l.id===relation&&l.status==='rejected'))throw Error('Relationship feedback not persisted');
 if(!learned.cards.some(c=>c.tags?.some(t=>t.label==='订单可信度'&&t.origin==='user')))throw Error('Tag correction not persisted');
 await api({action:'task',topicId:topic,title:'测试样例 · 检查公告',question:'测试样例：核实订单'});await page.getByRole('button',{name:/^跟进/}).click();await page.getByRole('button',{name:'立即检查'}).click();await expect(page.getByText('这一条已保存，尚未完成',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'连接与设置'}).click();await expect(page.getByRole('button',{name:'测试连接'})).toBeDisabled();await expect(page.getByRole('dialog')).toContainText('不是模型上下文窗口');await page.screenshot({path:'artifacts/redesign-settings.png',fullPage:true});await page.getByRole('button',{name:'关闭窗口'}).click();
 // Weekly UI uses explicitly labelled synthetic output, never a fake live model.
 await page.getByRole('button',{name:'回到今天',exact:true}).click();await page.locator('.weekly-entry').filter({hasText:'每周回顾'}).click();
 await page.getByLabel('每周一 09:00 自动回顾上周').check();await expect(page.getByRole('dialog')).toContainText('下一次：');
 await page.reload();await page.locator('.weekly-entry').filter({hasText:'每周回顾'}).click();await expect(page.getByLabel('每周一 09:00 自动回顾上周')).toBeChecked();
 await page.getByLabel('每周一 09:00 自动回顾上周').uncheck();
 await page.getByRole('button',{name:'现在回顾最近 7 天',exact:true}).click();await expect(page.locator('.weekly-card')).toContainText('等待连接模型');
 const weekly=(await(await fetch(base+'/api/agent')).json()).weekly,w=weekly.reviews[0],wv=weekly.versions[0];
 const qa=new DatabaseSync(path.join(data,'agent.sqlite'));
 qa.prepare("UPDATE runs SET status='partial',error='测试样例：跨问题比较未通过核对，已隐藏',result=? WHERE id=?").run(JSON.stringify({focus:[{text:'测试样例：本周记录过对订单质量的担心。',citations:[{source_id:first.id,quote:'我担心订单质量'}]}],changes:[],unresolved:[],logic:[{situation_id:first.id,title:'测试样例：订单是否兑现',basis:null,change:null,assessment:{text:'测试样例：这是担心，未形成交易规则。',citations:[{source_id:first.id,quote:'我担心订单质量'}]},next_check:{text:'测试样例：先区分订单数量和回款质量的验证依据。',citations:[{source_id:first.id,quote:'我担心订单质量'}]},resume_source_id:first.id}],coverage:{total:2,selected:2,excerpted:false,imagesNotRead:0}}),wv.run_id);qa.close();
 await expect(page.locator('.weekly-card')).toContainText('本周记录过对订单质量');
 await expect(page.locator('.weekly-card')).toContainText('部分完成');await expect(page.locator('.weekly-card')).toContainText('跨问题比较未通过核对');
 await page.setViewportSize({width:390,height:844});await expect(page.locator('.toast')).toHaveCount(0,{timeout:8000});await page.screenshot({path:'artifacts/weekly-review-result-mobile.png'});
 await expect(page.locator('.weekly-logic')).toContainText('未形成交易规则');await page.locator('.weekly-item summary').first().click();await page.locator('.weekly-item .source-preview').first().click();await expect(page.getByRole('dialog',{name:'原始依据'})).toContainText('我担心订单质量');await page.getByRole('button',{name:'关闭窗口'}).click();
 await page.getByRole('button',{name:'接着梳理这一步 →',exact:true}).click();
 await expect(page.getByLabel('说说你的想法')).toContainText('不是我已认可的规则');
 await expect(page.getByRole('dialog',{name:'每周回顾'})).toHaveCount(0);
 await page.getByLabel('说说你的想法').fill('测试样例：不能丢的未发送草稿');
 await page.getByRole('button',{name:'每周回顾',exact:true}).click();
 await page.getByRole('button',{name:'接着梳理这一步 →',exact:true}).click();
 await expect(page.locator('.toast')).toContainText('已有未发送的草稿');await expect(page.getByRole('dialog',{name:'每周回顾'})).toBeVisible();
 await expect(page.getByLabel('说说你的想法')).toHaveValue('测试样例：不能丢的未发送草稿');
 await page.getByRole('button',{name:'纠正这份回顾',exact:true}).click();await page.getByLabel('这份回顾哪里理解错了？').fill('测试样例：只是当时的担心，不能变成原则。');await page.getByRole('button',{name:'保存回顾纠正',exact:true}).click();await expect(page.locator('.weekly-correction')).toContainText('不能变成原则');
 await page.getByRole('button',{name:'重新生成这期',exact:true}).click();await expect(page.locator('.weekly-card')).toContainText('等待连接模型');await expect(page.locator('.weekly-history')).toBeVisible();
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Weekly mobile overflow');await page.screenshot({path:'artifacts/weekly-review-mobile.png',fullPage:true});
 const weeklyExport=await(await fetch(base+'/api/export')).json();if(!weeklyExport.weekly_reviews?.length||!weeklyExport.weekly_feedback?.length||weeklyExport.format!=='zhiheng-export-v5')throw Error('Weekly export incomplete');
 await page.getByRole('button',{name:'删除回顾',exact:true}).click();await page.getByRole('button',{name:'确认删除回顾',exact:true}).click();await expect(page.locator('.weekly-card')).toHaveCount(0);await page.getByRole('button',{name:'关闭窗口'}).click();
 if(!(await(await fetch(base+'/api/agent')).json()).records.some(r=>r.id===first.id))throw Error('Deleting review deleted investment original');
 const exported=await(await fetch(base+'/api/export')).json();if(!exported.records.length||!exported.memory_cards||!exported.record_context?.length||!exported.record_tags?.length||!exported.link_feedback?.length||JSON.stringify(exported).includes('apiKey'))throw Error('Export failed');const security=await fetch(base+'/api/agent',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({action:'topic',title:'not allowed'})});if(security.ok)throw Error('Cross-site mutation allowed');
 await page.getByRole('button',{name:'我的脉络',exact:true}).click();await page.getByRole('button',{name:'原文',exact:true}).click();await page.locator('.memory-card').first().click();await page.getByRole('button',{name:'删除关联原文与记忆'}).click();await page.getByRole('button',{name:'确认删除原文及记忆'}).click();
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Memory mobile overflow');await page.screenshot({path:'artifacts/redesign-memory-mobile.png',fullPage:true});await verifyContinuity(page);await verifyNotifications(page);await verifyObservations(page);await verifyThemeRadar(page);await verifyLibrary(page);if(errors.length)throw Error(errors.join('\n'));console.log('PASS theme radar configuration/ten core objects/partial data/versions/mobile; personal records capture/correction/search/delete/export/retention/mobile; weekly schedule, report sources/correction/versions/export/delete; complete redesign: capture, reopen, no-key failure, cards/search/timeline, source, correction, tasks, usage, export, deletion, security and mobile layout');
}finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(r=>setTimeout(r,1000));if(server.exitCode===null)server.kill('SIGKILL');rmSync(data,{recursive:true,force:true})}
