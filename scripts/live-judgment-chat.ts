// Real-model regression. Owner data is never used as a prompt. No Feishu transport is connected.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
if(!process.argv.includes('--live'))throw Error('需 --live 才使用现有模型预算');
const production=path.resolve('data'),ledger=new DatabaseSync(path.join(production,'agent.sqlite'));
const settings=JSON.parse(readFileSync(path.join(production,'credentials.json'),'utf8'));
const used=Number(ledger.prepare('SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?').get(new Date().toISOString().slice(0,7)+'-01')?.n);
const budget=Math.min(50000,settings.monthlyTokens-used);
if(budget<24000)throw Error('当前月度余额不足以运行验收');
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zh-judgment-'));
process.env.AGENT_TEST_MODE='1';
const d=await import('../server/db'),f=await import('../server/feishu/receiver');
await import('../server/notifications');
const cfg=await import('../server/config'),fc=await import('../server/feishu/config'),u=await import('../server/feishu/unified-store');
cfg.saveConfig(settings.apiKey,settings.model,budget,settings.engine);
fc.saveConnection({appId:'cli_validation',appSecret:'synthetic-only',allowedUsers:['ou_test'],enabled:true,allowedChats:[],collectionMode:false});
writeFileSync(u.profilePath,JSON.stringify({enabled:true,environment:'test',appId:'cli_validation',tenantKey:'test',ownerOpenId:'ou_test',botOpenId:'ou_bot',radarChatId:'oc_group',taskIds:[d.id()]}));
async function dm(text:string){
 const inbound=f.receiveMessage({app_id:'cli_validation',tenant_key:'test',event_id:d.id(),sender:{sender_type:'user',sender_id:{open_id:'ou_test'}},message:{message_id:'om_'+d.id(),chat_id:'oc_dm',chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}});
 assert.ok('runId' in inbound);
 const run=d.one<import('../server/db').Run>('SELECT * FROM runs WHERE id=?',inbound.runId)!;
 await f.processFeishu(run,{reply:async()=>{throw Error('disabled')},download:async()=>{throw Error('disabled')}});
 const result=JSON.parse(d.one<{result:string}>('SELECT result FROM runs WHERE id=?',run.id)!.result).feishu;
 const quote=d.one<{quote:string}>('SELECT quote FROM judgment_uses WHERE run_id=?',run.id)?.quote||'';
 console.log(JSON.stringify({question:text,text:result.text,quote}));
 assert.doesNotMatch(result.text,/未完成接收或处理|这次对话未完成/);
 return {run:run.id,quote,text:result.text as string};
}
try{
 const seed=await dm('合成验收：我因为持续放量开始观察江丰电子，后来我把资金换到另一只，因为我判断机会会轮到同方向的补涨股。');
 assert.ok(d.one('SELECT 1 FROM judgment_turns WHERE run_id=?',seed.run));
 d.exec("UPDATE records SET created_at='2023-01-03T06:00:00Z' WHERE id=?",seed.run);
 const first=await dm('我当初为什么关注江丰电子？');assert.match(first.quote,/放量/);
 const quiet=await dm('江丰电子公告里的会计口径是什么意思？');assert.ok(!quiet.quote);assert.doesNotMatch(quiet.text,/放量|补涨股/);
 const question='这回看的是另一家公司，方向我还看好，可涨的都是别的票，又有点想换。';
 const compare=await dm(question);assert.match(compare.quote,/换到|轮到/);
 const fix=await dm('那只是一次尝试，不是我的交易规则。');assert.match(fix.text,/已记下你的纠正/);
 const again=await dm(question);assert.equal(again.quote,'');
 assert.doesNotMatch(compare.text,/候选|索引编号/);
 console.log('PASS');
}finally{
 let total=0;
 for(const u of d.all<{id:string;model:string;tokens:number;created_at:string}>('SELECT * FROM usage')){
  ledger.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?)').run('judgment-validation:'+u.id,null,u.model.replace(/^(pending:|unconfirmed:|reserved:)?/,'$1judgment-validation:'),u.tokens,u.created_at);total+=u.tokens;
 }
 console.log('USAGE',total);ledger.close();d.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true});
}
