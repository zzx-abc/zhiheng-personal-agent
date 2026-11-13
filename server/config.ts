import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { dataDir, one } from './db';
import {usageBreakdown} from './usage-budget';
const configPath = path.join(dataDir, 'credentials.json');
export function config() {
 let saved: {apiKey?:string;model?:string;monthlyTokens?:number;engine?:'dsh'|'direct'} = {};
 if (existsSync(configPath)) saved = JSON.parse(readFileSync(configPath,'utf8'));
 return { engine: saved.engine || 'dsh' as 'dsh'|'direct', apiKey: saved.apiKey || process.env.MOONSHOT_API_KEY || '', model: saved.model || process.env.KIMI_MODEL || 'kimi-k2.6', monthlyTokens: saved.monthlyTokens || Number(process.env.MONTHLY_TOKEN_LIMIT || 1000000) };
}
export function saveConfig(apiKey: string|undefined, model:string, monthlyTokens:number,engine:'dsh'|'direct'='dsh') {
 const old = config();
 const tmp = configPath+'.tmp';
 writeFileSync(tmp,JSON.stringify({apiKey:apiKey === undefined ? old.apiKey : apiKey, model,monthlyTokens,engine}),{mode:0o600});
 chmodSync(tmp,0o600); renameSync(tmp,configPath);
}
export function publicConfig() { const c=config();return {usage:usageBreakdown(),configured:!!c.apiKey,model:c.model,monthlyTokens:c.monthlyTokens,usedTokens:Number(one<{total:number}>("SELECT COALESCE(SUM(tokens),0) total FROM usage WHERE created_at>=?",new Date().toISOString().slice(0,7)+'-01')?.total || 0),runtime:c.engine==='dsh'?'deepseek-harness':'kimi-direct',harnessStatus:'startup-verified-live-pending',background:'本机运行 · 手动跟进 / 可选回顾与持续观察 · 休眠时暂停'}; }
