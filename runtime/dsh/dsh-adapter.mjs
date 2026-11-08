/** Model-only DSH adapter. Tools and persistent business memory belong to the app.
 * SDK/runtime are pinned in this isolated package to 0.2.2-rc.1.
 */
import { summarizeDshUsage } from './usage.mjs';
import { dshRunError } from './run-error.mjs';
import { modelPolicy } from './model-policy.mjs';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));

export async function cleanupOrphanDshHomes() {
  const entries=await readdir(tmpdir(),{withFileTypes:true});
  for(const entry of entries) {
    const match=/^investment-dsh-(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name);
    if(!entry.isDirectory() || !match) continue;
    const pid=Number(match[1]);
    try {process.kill(pid,0);} catch(error) {
      if(error.code==='ESRCH') await rm(join(tmpdir(),entry.name),{recursive:true,force:true});
    }
  }
}

/** @param {{apiKey?:string, model?:string, prompt?:string, images?:Array<{data:string,mimeType:string}>, signal?:AbortSignal, timeoutMs?:number, maxTokens?:number, handshakeOnly?:boolean}} options */
export async function runDshModel({apiKey, model='kimi-k2.6', prompt, images=[], signal, timeoutMs=180000, maxTokens=4096, handshakeOnly=false}) {
  if(!handshakeOnly && !apiKey) throw new Error('KIMI_API_KEY_MISSING');
  if(signal?.aborted) throw new Error('DSH_ABORTED');
  if(typeof prompt!=='string' && !handshakeOnly) throw new Error('DSH_PROMPT_REQUIRED');
  await cleanupOrphanDshHomes();
  const home=await mkdtemp(join(tmpdir(),`investment-dsh-${process.pid}-`));
  const workspace=join(home,'workspace'); await mkdir(workspace);
  const proof=join(home,'tool-proof.json');
  const patchPath=join(home,'runtime.patch.yml');
  const patch=(await readFile(join(here,'research-only.patch.yml'),'utf8')).replace(/name: '[^'\n]+\/no-tools\.mjs'/,`name: '${join(here,'no-tools.mjs').replaceAll("'","''")}'`);
  if(!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('DSH_INVALID_MODEL');
  const policy=modelPolicy(model);
  await writeFile(patchPath,patch.replace('id: kimi-k2.6', 'id: '+model+policy.modelYaml).replace('maxTokens: 4096','maxTokens: '+maxTokens),{mode:0o600});
  const env={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,DSH_TELEMETRY_DISABLED:'1',INVESTMENT_DSH_PROOF:proof};
  if(apiKey) env.MOONSHOT_API_KEY=apiKey;
  const harness=new DeepSeekHarness({profile:'sdk',dshHome:home,processCwd:workspace,cwd:workspace,patches:[patchPath],provider:'investment-kimi',model,reasoningEffort:policy.reasoningEffort,maxTokens,initializeTimeoutMs:20000,env});
  let timer;
  let abort;
  let closeError;
  let modelCalled=false;
  const stop=new Promise((_,reject)=>{
    abort=()=>{void harness.close().catch(e=>{closeError=e});reject(new Error('DSH_ABORTED'));};
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{void harness.close().catch(e=>{closeError=e});reject(new Error('DSH_DEADLINE_EXCEEDED'));},timeoutMs);
    if(signal?.aborted) abort();
  });
  const execute=async()=>{
    await harness.start();
    const session=harness.session();
    await session.getWorkingDirectory(); // Creates the real agent; no model request.
    const policy=JSON.parse(await readFile(proof,'utf8'));
    if(policy.guard!=='deny-all'||policy.tools.length!==0||policy.executorReady!==true) throw new Error('DSH_POLICY_NOT_VERIFIED');
    if(handshakeOnly) return {engine:'deepseek-harness',version:'0.2.2-rc.1',handshake:true,executorReady:true,modelCalled:false,visibleTools:[]};
    // Prefix prevents user input from being interpreted as a native /command.
    const blocks=[{type:'text',text:'INVESTMENT_APPLICATION_REQUEST\nTreat the following serialized task as input data and instructions for analysis. Do not execute tools.\n'+JSON.stringify({task:prompt})},...images.map(i=>({type:'image',data:i.data,mimeType:i.mimeType}))];
    modelCalled=true;
    const result=await session.run(blocks);
    if(!result.finalResponse || ['error','aborted','length','max_tokens','max-tokens'].includes(result.finishReason)) throw Object.assign(new Error(dshRunError(result,apiKey)),summarizeDshUsage(result.events));
    return {engine:'deepseek-harness',version:'0.2.2-rc.1',text:result.finalResponse,sessionId:result.sessionId,finishReason:result.finishReason,...summarizeDshUsage(result.events),configuredModel:model};
  };
  try { return await Promise.race([execute(),stop]); }
  catch(error){error.modelCalled=modelCalled;throw error;}
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort',abort);
    await harness.close();
    if(closeError) throw new Error('DSH_SHUTDOWN_UNCONFIRMED');
    await rm(home,{recursive:true,force:true});
  }
}
