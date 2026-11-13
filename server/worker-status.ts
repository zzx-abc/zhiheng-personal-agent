import {exec,one} from './db';

export function beatWorker(at=Date.now()){
 exec("INSERT INTO meta(key,value) VALUES('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",at);
}
export function workerStatus(at=Date.now()){
 const last=one<{value:number}>("SELECT value FROM meta WHERE key='worker_heartbeat'")?.value;
 return {state:!last?'unknown' as const:at-last<15000?'online' as const:'offline' as const,lastSeen:last?new Date(last).toISOString():null};
}
