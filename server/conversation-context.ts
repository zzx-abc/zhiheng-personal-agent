import {all,one,exec,transaction,type RecordRow,type Run} from './db';

export function captureContext(recordId:string){
 return one<{parent_id:string|null;root_id:string|null}>('SELECT parent_id,root_id FROM record_context WHERE record_id=?',recordId);
}
/** Follow actual reply edges, never neighboring records or a shared null topic. */
export function replyHistory(recordId:string,limit=6){
 const history:RecordRow[]=[];const seen=new Set([recordId]);let parent=captureContext(recordId)?.parent_id;
 while(parent&&history.length<limit&&!seen.has(parent)){
  seen.add(parent);const row=one<RecordRow>("SELECT * FROM records WHERE id=? AND role='user'",parent);
  if(!row)break;history.push(row);parent=captureContext(parent)?.parent_id;
 }
 return history;
}
export function recallRequest(runId:string):{query:string;reason:string}|null{
 const row=one<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='memory_requested' ORDER BY rowid DESC LIMIT 1",runId);
 return row?JSON.parse(row.detail):null;
}
export function recalledTopics(runId:string){
 const selected=one<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='memory_selected' ORDER BY rowid DESC LIMIT 1",runId);
 if(selected){const ids=new Set<string>();for(const l of JSON.parse(selected.detail).links||[]){const topic=one<{topic_id:string|null}>('SELECT topic_id FROM records WHERE id=?',l.source_id)?.topic_id;if(topic)ids.add(topic);}return ids;}
 const ids=new Set<string>();
 for(const row of all<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='memory_retrieved'",runId)){
  for(const card of JSON.parse(row.detail).cards||[]){
   const topic=one<{topic_id:string|null}>('SELECT topic_id FROM memory_cards WHERE id=?',card.id)?.topic_id;
   if(topic)ids.add(topic);
  }
 }
 return ids;
}
export function detachCapture(run:Run,record:RecordRow){
 transaction(()=>{
  // Replies can arrive while the parent is still being classified. Move only
  // this subtree, not sibling fragments that happen to share the former root.
  exec(`WITH RECURSIVE branch(id) AS (
   SELECT ? UNION SELECT c.record_id FROM record_context c JOIN branch b ON c.parent_id=b.id
  ) UPDATE record_context SET root_id=? WHERE record_id IN (SELECT id FROM branch)`,record.id,record.id);
  exec('UPDATE record_context SET parent_id=NULL WHERE record_id=?',record.id);
  exec('UPDATE records SET topic_id=NULL WHERE id=?',record.id);
  exec('UPDATE runs SET topic_id=NULL WHERE record_id=?',record.id);
 });
 run.topic_id=null;record.topic_id=null;
}
