import { writeFileSync } from 'node:fs';
export const name = 'investment-no-tools';
export const inject = ['tools', 'agents'];
export function apply(ctx) {
  const requests=new WeakMap();
  ctx.on('agent/request', ({agent},next) => {
    const n=requests.get(agent)||0;
    if(n>=1) throw new Error('Investment model-only runtime: one model request per role.');
    requests.set(agent,n+1);
    return next();
  });
  ctx.tools.guard(() => 'Investment model-only runtime: all tool execution denied.');
  ctx.on('agent/created', async ({agent}) => {
    agent.ctx.tools.restrict({allow: []});
    const visible=ctx.tools.schemas(agent);
    if(visible.length) throw new Error('Unexpected tools in investment runtime: '+visible.map(x=>x.name).join(','));
    // An empty batch checks the required executor without invoking any tool or
    // model. Merely creating an agent does not catch a missing executor.
    await ctx.tools.execute({calls:[],agent,signal:new AbortController().signal});
    if(process.env.INVESTMENT_DSH_PROOF) writeFileSync(process.env.INVESTMENT_DSH_PROOF, JSON.stringify({tools:[],guard:'deny-all',executorReady:true,version:'0.2.2-rc.1'}));
  });
}
