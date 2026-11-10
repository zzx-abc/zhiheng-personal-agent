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

/** Shared content budget: short captures do not waste an equal per-record quota.
 * Keep whole arguments whenever possible. Only overflow inputs use bounded,
 * paragraph-based excerpts including the middle; originals are never rewritten.
 */
export function allocateDecisionText(rows:RecordRow[],budget=16000){
 const full=rows.reduce((n,r)=>n+r.content.length,0);
 if(full<=budget)return new Map(rows.map(r=>[r.id,[r.content]]));
 const allocations=new Map<string,number>();let remaining=budget;
 // Protect short clarifications first; redistribute unused space to long theses.
 for(const r of [...rows].sort((a,b)=>a.content.length-b.content.length)){
  const left=rows.length-allocations.size,limit=Math.min(r.content.length,Math.floor(remaining/left));
  allocations.set(r.id,limit);remaining-=limit;
 }
 return new Map(rows.map(r=>{
  const limit=allocations.get(r.id)!;if(limit<=0)return [r.id,[]];if(r.content.length<=limit)return [r.id,[r.content]];
  const paragraphs=r.content.match(/[^\n]+\n*|\n+/g)||[r.content];
  const ranked=paragraphs.map((text,index)=>({text,index,score:(index===0||index===paragraphs.length-1?8:0)+( /因为|所以|因此|但是|并不|不意味|假设|轮动|切换|验证|不是|纠正|依据/.test(text)?4:0)})).sort((a,b)=>b.score-a.score||a.index-b.index);
  const chosen:{text:string;index:number}[]=[];let available=limit;
  for(const p of ranked){if(p.text.length<=available){chosen.push(p);available-=p.text.length;}}
  if(!chosen.length){const size=Math.floor(limit/3);return [r.id,[r.content.slice(0,size),r.content.slice(Math.floor(r.content.length/2),Math.floor(r.content.length/2)+size),r.content.slice(-(limit-2*size))]];}
  return [r.id,chosen.sort((a,b)=>a.index-b.index).map(p=>p.text)];
 }));
}
