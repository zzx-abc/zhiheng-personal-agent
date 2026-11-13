// Explicit read-only live probe. Never loads personal config or sends a notification.
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
if(!process.argv.includes('--live'))throw Error('真实只读采集需要显式 --live；不调用模型，不发送消息');
const dir=mkdtempSync(path.join(tmpdir(),'zhiheng-radar-live-'));process.env.AGENT_DATA_DIR=dir;process.env.AGENT_TEST_MODE='1';
const {observationConfigSchema}=await import('../server/observation/types');const {collectFrame}=await import('../server/observation/provider');const {detect}=await import('../server/observation/detectors');const {db}=await import('../server/db');
try{
 const c=observationConfigSchema.parse({}),f=await collectFrame(c,AbortSignal.timeout(180000)),result=detect(f,c,[],true);
 mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/radar-live-validation.json',JSON.stringify({frame:f,baseline:result},null,2),{mode:0o600});
 console.log(JSON.stringify({observedAt:f.observedAt,coverage:f.coverage,validGroups:result.validGroups,metrics:result.metrics.map(m=>({id:m.id,valid:m.valid,coverage:m.coverage,missing:m.missing})),externalMessages:0,modelCalls:0}));
}finally{db.close();rmSync(dir,{recursive:true,force:true});}
