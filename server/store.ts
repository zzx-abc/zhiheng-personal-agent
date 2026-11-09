import {weeklySnapshot} from './weekly-review';
import {ensureRuleTags} from './memory-learning';
import { all,one,exec,id,now,transaction,revision,bump,event, type RecordRow, type Memory, type Topic, type Run } from './db';
import { config,publicConfig } from './config';
import { unlinkSync,existsSync } from 'node:fs';
import {stateVersions} from './working-state';
import {cardSnapshot,retrievalStatus,syncCards} from './cards';
export function snapshot() { return {weekly:weeklySnapshot(),cards:cardSnapshot(),memoryLinks:all(`SELECT l.*,(SELECT f.note FROM link_feedback f WHERE f.link_id=l.id ORDER BY f.rowid DESC LIMIT 1) feedback_note,(SELECT f.source_id FROM link_feedback f WHERE f.link_id=l.id ORDER BY f.rowid DESC LIMIT 1) feedback_source_id FROM memory_links l ORDER BY l.created_at DESC`),retrieval:retrievalStatus(),workingStates:stateVersions(),topics:all('SELECT * FROM topics ORDER BY updated_at DESC'),records:all(`SELECT r.*,c.parent_id,COALESCE(c.root_id,owner.id,r.id) fragment_id FROM records r LEFT JOIN runs x ON r.run_id=x.id LEFT JOIN records owner ON owner.id=x.record_id LEFT JOIN record_context c ON c.record_id=COALESCE(owner.id,r.id) ORDER BY r.created_at`),attachments:all('SELECT id,record_id,name,mime,bytes FROM attachments'),memories:all('SELECT * FROM memories ORDER BY updated_at DESC'),tasks:all('SELECT * FROM tasks ORDER BY updated_at DESC'),runs:all('SELECT * FROM runs WHERE id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT 100) OR id IN (SELECT last_run_id FROM tasks) OR id IN (SELECT run_id FROM working_states) ORDER BY created_at DESC'),reports:all('SELECT * FROM reports'),evidence:all('SELECT * FROM evidence'),events:all("SELECT * FROM events WHERE id IN (SELECT id FROM events ORDER BY rowid DESC LIMIT 300) OR type='research_finished' ORDER BY rowid DESC"),config:publicConfig()}; }
export function createTopic(title:string,question='') { const key=id(),at=now();exec('INSERT INTO topics VALUES(?,?,?,?,?,?)',key,title,question,'active',at,at);return key; }
export function addRecord(content:string,topicId:string|null,kind='message',role='user',runId:string|null=null) {if(topicId&&!one('SELECT id FROM topics WHERE id=?',topicId))throw Error('关注事项不存在');const key=id();exec('INSERT INTO records VALUES(?,?,?,?,?,?,?)',key,topicId,role,kind,content,now(),runId);ensureRuleTags(one<RecordRow>('SELECT * FROM records WHERE id=?',key)!);return key;}
/** New captures are independent. Only an explicit reply carries a parent. */
export function capture(content:string,parentId:string|null,kind='message') {
 return transaction(()=>{
  const parent=parentId?one<RecordRow>("SELECT * FROM records WHERE id=? AND role='user'",parentId):undefined;
  if(parentId&&!parent)throw Error('要继续的原文已不存在，请作为新想法发送');
  const key=addRecord(content,parent?.topic_id||null,kind);
  const root=parent?one<{root_id:string|null}>('SELECT root_id FROM record_context WHERE record_id=?',parent.id)?.root_id||parent.id:key;
  exec('INSERT INTO record_context VALUES(?,?,?)',key,parent?.id||null,root);
  return key;
 });
}
export function enqueue(recordId:string,mode:string,taskId:string|null=null) {
 return transaction(()=>{
 const record=one<RecordRow>('SELECT * FROM records WHERE id=?',recordId); if(!record)throw Error('记录不存在');
 if(taskId){const task=one<{status:string}>('SELECT status FROM tasks WHERE id=?',taskId);if(!task||task.status!=='active')throw Error('任务已暂停或结束');const active=one<Run>("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running')",taskId);if(active)return active.id;}
 const existing=one<Run>("SELECT * FROM runs WHERE record_id=? AND status IN ('queued','running')",recordId);if(existing)return existing.id;
 const checkpoint=one<Run>("SELECT * FROM runs WHERE record_id=? AND status='failed' AND error LIKE '%月度预算%' AND revision=? ORDER BY created_at DESC LIMIT 1",recordId,revision());
 if(checkpoint?.task_id&&(!one("SELECT id FROM tasks WHERE id=? AND status='active'",checkpoint.task_id)||!one("SELECT id FROM topics WHERE id=? AND status='active'",checkpoint.topic_id)))throw Error('关联委托或关注已暂停，不能继续旧任务');
 if(checkpoint&&all<{agent:string}>('SELECT agent FROM reports WHERE run_id=?',checkpoint.id).map(x=>x.agent).sort().join(',')==='analysis,challenge'){exec("UPDATE runs SET status='queued',phase='waiting',error=NULL,finished_at=NULL WHERE id=?",checkpoint.id);event(checkpoint.id,'resume_requested',{checkpoint:'independent_reviews',revision:revision()});return checkpoint.id;}
 const key=id();exec('INSERT INTO runs(id,task_id,record_id,topic_id,mode,status,revision,created_at,error) VALUES(?,?,?,?,?,?,?,?,?)',key,taskId,recordId,record.topic_id,mode,config().apiKey?'queued':'blocked',revision(),now(),config().apiKey?null:'请先在设置中配置 Kimi API Key。原始输入已保存。');
 if(taskId)exec('UPDATE tasks SET last_run_id=?,updated_at=? WHERE id=?',key,now(),taskId);
 event(key,'queued',{mode,reason:config().apiKey?'ready':'missing_api_key'});return key;
 });
}
export function createTask(topicId:string,title:string,question:string) { const topic=one<Topic>('SELECT * FROM topics WHERE id=?',topicId);if(!topic||topic.status!=='active')throw Error('请先选择有效的关注事项');const key=id(),at=now();exec('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)',key,topicId,title,question,'active','manual',at,at,null);return key; }
export function runTask(taskId:string) {const task=one<{topic_id:string;question:string;status:string}>('SELECT * FROM tasks WHERE id=?',taskId);if(!task||task.status!=='active')throw Error('任务不可执行');if(one<Topic>('SELECT * FROM topics WHERE id=?',task.topic_id)?.status!=='active')throw Error('关联关注已暂停，请先恢复关注再执行');const active=one<Run>("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running')",taskId);if(active)return active.id;return enqueue(addRecord(task.question,task.topic_id,'check'),'check',taskId);}
export function cancel(runId:string) {exec("UPDATE runs SET status='cancelled',finished_at=? WHERE id=? AND status IN ('queued','running','blocked')",now(),runId);event(runId,'cancelled',{});}
export function pauseTask(taskId:string,status:string) {if(status==='active'){const task=one<{topic_id:string}>('SELECT topic_id FROM tasks WHERE id=?',taskId);if(!task||one<Topic>('SELECT * FROM topics WHERE id=?',task.topic_id)?.status!=='active')throw Error('关联关注已暂停，请先恢复关注再恢复跟进');}exec('UPDATE tasks SET status=?,updated_at=? WHERE id=?',status,now(),taskId);if(status!=='active')for(const r of all<Run>("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running','blocked')",taskId))cancel(r.id);}
export function addMemory(content:string,kind:string,topicId:string|null) {const source=addRecord(content,topicId,'explicit_memory');const key=id(),at=now();transaction(()=>{exec('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)',key,topicId,kind,content,'active',source,content,at,at,null);bump();});return key;}
export function correctMemory(memoryId:string,correction:string) {const m=one<Memory>('SELECT * FROM memories WHERE id=?',memoryId);if(!m)throw Error('记忆不存在');transaction(()=>{exec("UPDATE memories SET status='withdrawn',updated_at=? WHERE id=?",now(),memoryId);const source=addRecord(correction,m.topic_id,'correction');const at=now();exec('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)',id(),m.topic_id,'correction',correction,'active',source,correction,at,at,memoryId);bump();invalidateGenerated(m.topic_id);});}
export function invalidateGenerated(topicId:string|null){
 if(topicId)exec("UPDATE working_states SET status='stale' WHERE topic_id=? AND status='current'",topicId);else exec("UPDATE working_states SET status='stale' WHERE status='current'");
 const runs=topicId?all<Run>('SELECT * FROM runs WHERE topic_id=?',topicId):all<Run>('SELECT * FROM runs');
 for(const r of runs){if(r.status==='succeeded'||r.status==='partial'){exec("UPDATE runs SET status='stale',error='相关记忆已更新，此分析仅供查看历史，不能作为当前结论' WHERE id=?",r.id);} }
}
export function deleteRecord(recordId:string) {
 const row=one<RecordRow>('SELECT * FROM records WHERE id=?',recordId);if(!row)return;
 const paths=all<{path:string}>('SELECT path FROM attachments WHERE record_id=?',recordId);
 transaction(()=>{bump();
 // Generated reports may quote any earlier record. Remove derived outputs conservatively.
 exec("DELETE FROM working_states");exec("DELETE FROM records WHERE role='assistant'");exec('DELETE FROM reports');exec('DELETE FROM evidence');exec('DELETE FROM events');
 exec("UPDATE runs SET status='stale',result=NULL,error='来源删除后已清除派生分析。需要时请重新分析。',finished_at=? WHERE status!='cancelled'",now());
 exec("DELETE FROM memories WHERE status='candidate'");exec('DELETE FROM records WHERE id=?',recordId);
 });
 syncCards();
 for(const f of paths)if(existsSync(f.path))unlinkSync(f.path);
}
export function searchHistory(query:string,topicId:string|null) {
 const terms=[...new Set((query.match(/[A-Za-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g)||[]).flatMap(t=>t.length>3?[t,...Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2))]:[t]))].slice(0,30);
 const rows=all<RecordRow>("SELECT * FROM records WHERE role='user' ORDER BY created_at DESC LIMIT 1500");
 return rows.map(r=>({r,score:(topicId&&r.topic_id===topicId?10:0)+terms.reduce((s,t)=>s+(r.content.includes(t)?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.r.created_at.localeCompare(a.r.created_at)).slice(0,14).map(x=>x.r);
}
