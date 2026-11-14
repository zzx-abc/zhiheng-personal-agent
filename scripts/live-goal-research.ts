// Opt-in real model, two isolated owner inboxes, no Feishu network or outbound messages.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
if(!process.argv.includes('--live'))throw Error('Use --live for metered model acceptance');
const production=path.resolve('data'),ledger=new DatabaseSync(path.join(production,'agent.sqlite'));
const settings=JSON.parse(readFileSync(path.join(production,'credentials.json'),'utf8'));
const available=settings.monthlyTokens-Number(ledger.prepare("SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?").get(new Date().toISOString().slice(0,7)+'-01')?.n);
if(available<30000)throw Error('现有模型预算不足；未调整上限。');
const archived=ledger.prepare(`SELECT c.detail,c.created_at,f.payload FROM observation_checks c JOIN observation_frames f ON c.frame_id=f.id JOIN runs r ON r.id=c.run_id WHERE r.status IN ('succeeded','partial') AND json_extract(f.payload,'$.synthetic')=0 AND json_array_length(c.detail,'$.themeReport.themes')>0 ORDER BY c.created_at DESC LIMIT 1`).get();
if(!archived)throw Error('缺少真实已完成主题快照');
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zh-goal-live-'));
process.env.AGENT_TEST_MODE='1';
const d=await import('../server/db'),lib=await import('../server/library/service'),f=await import('../server/feishu/receiver');
await import('../server/notifications');
const cfg=await import('../server/config'),fc=await import('../server/feishu/config'),u=await import('../server/feishu/unified-store'),obs=await import('../server/observation/service'),store=await import('../server/goal-research/store');
cfg.saveConfig(settings.apiKey,settings.model,Math.min(available,80000),settings.engine);
const task=obs.createObservation({}),run=d.id(),frame=d.id(),at=String(archived.created_at);
d.exec("INSERT INTO runs(id,mode,status,revision,created_at,task_id) VALUES(?,'observation','succeeded',0,?,?)",run,at,task);
d.exec('INSERT INTO observation_frames VALUES(?,?,?)',frame,at,String(archived.payload));
d.exec("INSERT INTO observation_checks(run_id,task_id,config_version,epoch,frame_id,outcome,detail,created_at) VALUES(?,?,1,1,?,'baseline',?,?)",run,task,frame,String(archived.detail),at);
fc.saveConnection({appId:'cli_validation',appSecret:'synthetic-only',allowedUsers:['ou_test'],enabled:true,allowedChats:[],collectionMode:false});
writeFileSync(u.profilePath,JSON.stringify({enabled:true,environment:'test',appId:'cli_validation',tenantKey:'test',ownerOpenId:'ou_test',botOpenId:'ou_bot',radarChatId:'oc_group',taskIds:[task]}));
const samples:{variant:string;actions:string[];status:string;tokens:number;brief:string;trace:unknown}[]=[];
const goal='结合我之前保存的端侧AI研报和最近一次雷达结果，判断现在有哪些值得继续研究的对象。我主要关心收入兑现，不是只看概念。给我结论、依据和还缺什么。';
try{
 for(const variant of ['无资料','有资料']){
  if(variant==='有资料'){
   const key=lib.ingest({text:'端侧AI研报（合成验收资料）。富瀚微和星宸科技是作者建议研究的对象。作者预期端侧推理需求上升，文中没有披露分业务收入或客户验收数据。',intent:'collect',instruction:'关心收入兑现，作者预测还需核对。',eventKey:d.id()}).entryIds[0];
   const e=lib.entry(key);const asset=d.one<import('../server/library/types').Asset>('SELECT * FROM library_assets WHERE id=?',e.asset_id)!;
   await (await import('../server/library/parse')).parseAsset(asset);lib.reindex(key);
  }
  const inbound=f.receiveMessage({app_id:'cli_validation',tenant_key:'test',event_id:d.id(),sender:{sender_type:'user',sender_id:{open_id:'ou_test'}},message:{message_id:'om_'+d.id(),chat_id:'oc_dm',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:goal})}});
  assert.ok('runId' in inbound);
  const r=d.one<import('../server/db').Run>('SELECT * FROM runs WHERE id=?',inbound.runId!)!;
  d.exec("UPDATE runs SET status='running' WHERE id=?",r.id);
  await f.processFeishu(r,{download:async()=>{throw Error('disabled')},reply:async()=>{throw Error('disabled')}});
  const item=d.one<import('../server/goal-research/store').Item>('SELECT * FROM research_items WHERE run_id=?',r.id)!;
  const trace=store.stepsFor(r.id),tokens=d.one<{usage:number}>('SELECT usage FROM runs WHERE id=?',r.id)!.usage;
  samples.push({variant,actions:trace.map(x=>x.tool+':'+x.result.status),brief:store.show(item),status:item.status,tokens,trace});
  console.log(JSON.stringify({...samples.at(-1),trace:undefined}));
 }
 assert.ok(samples.every(x=>x.actions.includes('radar:ok')&&x.actions.some(a=>a.startsWith('find_material:'))));
 assert.ok(samples[0].actions.includes('find_material:not_found')&&!samples[0].actions.includes('read_material:ok'));
 assert.ok(samples[1].actions.includes('read_material:ok'));
 assert.ok(samples.every(x=>!x.brief.includes('未形成经过引用核对')));
}finally{
 writeFileSync(path.join(production,'validation-goal-research.json'),JSON.stringify(samples,null,2),{mode:0o600});
 for(const row of d.all<{id:string;model:string;tokens:number;created_at:string}>('SELECT * FROM usage'))ledger.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('research-validation:'+row.id,null,row.model.replace(/^(pending:|unconfirmed:|reserved:)?/,'$1research-validation:'),row.tokens,row.created_at);
 ledger.close();d.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true});
}
