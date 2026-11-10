/** Deterministic boundaries and sampling. A discussion is not proof of one trade. */
import {one,all,type RecordRow} from './db';
import {captureContext,replyHistory} from './conversation-context';
import type {WorkingState} from './working-state';
export function situationId(record:RecordRow){return captureContext(record.id)?.root_id||record.id;}
export function selectDecisionRecords(rows:RecordRow[],limit=30){
 if(rows.length<=limit)return rows;
 const groups=new Map<string,RecordRow[]>();
 for(const row of rows){const key=situationId(row);groups.set(key,[...(groups.get(key)||[]),row]);}
 let values=[...groups.values()];
 if(values.length>limit)values=Array.from({length:limit},(_,i)=>values[Math.round(i*(values.length-1)/(limit-1))]);
 // Latest (including corrections), original basis, then intermediate records.
 const queues=values.map(g=>[g.at(-1)!,g[0],...g.slice(1,-1).reverse()].filter((r,i,a)=>a.findIndex(x=>x.id===r.id)===i));
 const selected:RecordRow[]=[];
 while(selected.length<limit&&queues.some(q=>q.length))for(const q of queues){const r=q.shift();if(r)selected.push(r);if(selected.length===limit)break;}
 return selected.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
}
export function decisionBackground(selected:RecordRow[],end:string){
 const originals=new Map<string,RecordRow>(),hints:unknown[]=[];
 const selectedIds=new Set(selected.map(r=>r.id));
 const add=(r:RecordRow)=>{if(!selectedIds.has(r.id)&&r.created_at<end&&originals.size<6)originals.set(r.id,r);};
 for(const r of selected){
  const chain=replyHistory(r.id,100);if(chain.length){add(chain.at(-1)!);add(chain[0]);}
 }
 // State is a map to originals, never a replacement for them or a new fact.
 const states=all<{content:string;record_id:string;created_at:string}>(`SELECT w.content,r.record_id,w.created_at FROM working_states w JOIN runs r ON r.id=w.run_id WHERE w.status IN ('current','superseded') AND w.created_at<? ORDER BY w.created_at DESC`,end);
 const seen=new Set<string>();
 for(const s of states){
  if(!selectedIds.has(s.record_id)||seen.has(s.record_id)||hints.length>=4)continue;
  seen.add(s.record_id);const state=JSON.parse(s.content) as WorkingState;
  if(!state.decision_frame)continue;
  const frame=Object.fromEntries(Object.entries(state.decision_frame).map(([key,q])=>{
   if(!q)return [key,null];const raw=one<RecordRow>("SELECT * FROM records WHERE id=? AND role='user'",q.source_id);
   if(!raw||!raw.content.includes(q.quote)||raw.created_at>=end)return [key,null];
   add(raw);return [key,selectedIds.has(raw.id)||originals.has(raw.id)?q:null];
  }));
  const hint={record_id:s.record_id,asOf:s.created_at,decision_frame:frame,authority:'模型整理的定位线索，请回到原话判断；不是用户规则'};
  if(JSON.stringify([...hints,hint]).length<=2000)hints.push(hint);
 }
 return {originals:[...originals.values()],hints};
}
/** Keep both original basis and the later qualification/correction in long input. */
export function decisionExcerpts(text:string,limit:number){
 if(text.length<=limit)return [text];
 const half=Math.floor(limit/2);return [text.slice(0,half),text.slice(-(limit-half))];
}
