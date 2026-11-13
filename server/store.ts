import {workerStatus} from './worker-status';
import {weeklySnapshot} from './weekly-review';
import {notificationSnapshot} from './notifications';
import {ensureRuleTags} from './memory-learning';
import { all,one,exec,id,now,transaction,revision,bump,event, type RecordRow, type Memory, type Topic, type Run } from './db';
import { config,publicConfig } from './config';
import { unlinkSync,existsSync } from 'node:fs';
import {stateVersions,currentState,workingStateSchema,type StateVersion} from './working-state';
import {cardSnapshot,retrievalStatus,syncCards} from './cards';
export function snapshot() { return {notifications:notificationSnapshot(),worker:workerStatus(),weekly:weeklySnapshot(),cards:cardSnapshot(),memoryLinks:all(`SELECT l.*,(SELECT f.note FROM link_feedback f WHERE f.link_id=l.id ORDER BY f.rowid DESC LIMIT 1) feedback_note,(SELECT f.source_id FROM link_feedback f WHERE f.link_id=l.id ORDER BY f.rowid DESC LIMIT 1) feedback_source_id FROM memory_links l ORDER BY l.created_at DESC`),retrieval:retrievalStatus(),workingStates:stateVersions(),topics:all('SELECT * FROM topics ORDER BY updated_at DESC'),records:all(`SELECT r.*,c.parent_id,COALESCE(c.root_id,owner.id,r.id) fragment_id FROM records r LEFT JOIN runs x ON r.run_id=x.id LEFT JOIN records owner ON owner.id=x.record_id LEFT JOIN record_context c ON c.record_id=COALESCE(owner.id,r.id) ORDER BY r.created_at`),attachments:all('SELECT id,record_id,name,mime,bytes FROM attachments'),memories:all('SELECT * FROM memories ORDER BY updated_at DESC'),tasks:all('SELECT * FROM tasks ORDER BY updated_at DESC'),runs:all('SELECT * FROM runs WHERE id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT 100) OR id IN (SELECT last_run_id FROM tasks) OR id IN (SELECT run_id FROM working_states) ORDER BY created_at DESC,rowid DESC'),reports:all('SELECT * FROM reports'),evidence:all('SELECT * FROM evidence'),events:all("SELECT * FROM events WHERE id IN (SELECT id FROM events ORDER BY rowid DESC LIMIT 300) OR type='research_finished' ORDER BY rowid DESC"),config:publicConfig()}; }
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
 return transaction(()=>enqueueWithin(recordId,mode,taskId));
}
function enqueueWithin(recordId:string,mode:string,taskId:string|null=null) {
 const record=one<RecordRow>('SELECT * FROM records WHERE id=?',recordId); if(!record)throw Error('记录不存在');
 const binding=one<{detail:string}>("SELECT e.detail FROM events e JOIN runs r ON r.id=e.run_id WHERE r.record_id=? AND e.type='continuation_requested' ORDER BY e.rowid DESC LIMIT 1",recordId);
 if(binding){const value=JSON.parse(binding.detail);if(!one("SELECT id FROM working_states WHERE id=? AND status='current'",value.stateId)||!one("SELECT id FROM topics WHERE id=? AND status='active'",record.topic_id))throw Error('原核实请求所依据的理解已更新或暂停，请从当前问题重新开始');}
 if(taskId){const task=one<{status:string}>('SELECT status FROM tasks WHERE id=?',taskId);if(!task||task.status!=='active')throw Error('任务已暂停或结束');const active=one<Run>("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running')",taskId);if(active)return active.id;}
 const existing=one<Run>("SELECT * FROM runs WHERE record_id=? AND status IN ('queued','running')",recordId);if(existing)return existing.id;
 const checkpoint=one<Run>("SELECT * FROM runs WHERE record_id=? AND status='failed' AND error LIKE '%月度预算%' AND revision=? ORDER BY created_at DESC LIMIT 1",recordId,revision());
 if(checkpoint?.task_id&&(!one("SELECT id FROM tasks WHERE id=? AND status='active'",checkpoint.task_id)||!one("SELECT id FROM topics WHERE id=? AND status='active'",checkpoint.topic_id)))throw Error('关联委托或关注已暂停，不能继续旧任务');
 if(checkpoint&&all<{agent:string}>('SELECT agent FROM reports WHERE run_id=?',checkpoint.id).map(x=>x.agent).sort().join(',')==='analysis,challenge'){exec("UPDATE runs SET status='queued',phase='waiting',error=NULL,finished_at=NULL WHERE id=?",checkpoint.id);event(checkpoint.id,'resume_requested',{checkpoint:'independent_reviews',revision:revision()});return checkpoint.id;}
 const key=id();exec('INSERT INTO runs(id,task_id,record_id,topic_id,mode,status,revision,created_at,error) VALUES(?,?,?,?,?,?,?,?,?)',key,taskId,recordId,record.topic_id,mode,config().apiKey?'queued':'blocked',revision(),now(),config().apiKey?null:'请先在设置中配置 Kimi API Key。原始输入已保存。');
 if(taskId)exec('UPDATE tasks SET last_run_id=?,updated_at=? WHERE id=?',key,now(),taskId);
 event(key,'queued',{mode,reason:config().apiKey?'ready':'missing_api_key'});if(binding)event(key,'continuation_requested',JSON.parse(binding.detail));return key;
}
export function createTask(topicId:string,title:string,question:string) { const topic=one<Topic>('SELECT * FROM topics WHERE id=?',topicId);if(!topic||topic.status!=='active')throw Error('请先选择有效的关注事项');const key=id(),at=now();exec('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)',key,topicId,title,question,'active','manual',at,at,null);return key; }
export function runTask(taskId:string) {return transaction(()=>{
 const task=one<{topic_id:string;question:string;status:string}>('SELECT * FROM tasks WHERE id=?',taskId);
 if(!task||task.status!=='active')throw Error('任务不可执行');
 if(one<Topic>('SELECT * FROM topics WHERE id=?',task.topic_id)?.status!=='active')throw Error('关联关注已暂停，请先恢复关注再执行');
 const active=one<Run>("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running')",taskId);if(active)return active.id;
 const anchor=currentState(task.topic_id);
 const parent=anchor?one<Run>('SELECT * FROM runs WHERE id=?',anchor.run_id)?.record_id:undefined;
 const recordId=linkedRequest(task.question,task.topic_id,parent);
 return enqueueWithin(recordId,'check',taskId);
});}
/** A button delegates a model-proposed check; it does not assert the user's thesis. */
function linkedRequest(content:string,topicId:string,parentId?:string){
 const key=addRecord(content,topicId,'action_request');
 const root=parentId?one<{root_id:string|null}>('SELECT root_id FROM record_context WHERE record_id=?',parentId)?.root_id||parentId:key;
 exec('INSERT INTO record_context VALUES(?,?,?)',key,parentId||null,root);return key;
}
function usableState(stateId:string){
 const state=one<StateVersion>("SELECT * FROM working_states WHERE id=? AND status='current'",stateId);
 if(!state||currentState(state.topic_id)?.id!==stateId)throw Error('这份理解已有更新，请刷新后从最新问题继续');
 if(one<Topic>('SELECT * FROM topics WHERE id=?',state.topic_id)?.status!=='active')throw Error('这件事已暂停，请先恢复关注');
 const owner=one<Run>('SELECT * FROM runs WHERE id=?',state.run_id);
 if(!owner||!['succeeded','partial'].includes(owner.status))throw Error('这份理解已失效，请先重新梳理');
 return {state,owner,value:workingStateSchema.parse(JSON.parse(state.content))};
}
export function continueState(stateId:string){return transaction(()=>{
 const {state,owner,value}=usableState(stateId),next=value.next_action;
 if(!next||!['official_search','market_data'].includes(next.kind))throw Error('这一步需要交流或补充个人信息，不能当作公开资料查证执行');
 const active=one<Run>("SELECT * FROM runs WHERE topic_id=? AND status IN ('queued','running') ORDER BY rowid DESC LIMIT 1",state.topic_id);
 if(active)return {runId:active.id,recordId:active.record_id,reused:true};
 const blocked=one<Run>("SELECT r.* FROM runs r JOIN events e ON e.run_id=r.id WHERE r.status='blocked' AND e.type='continuation_requested' AND json_extract(e.detail,'$.stateId')=? ORDER BY r.rowid DESC LIMIT 1",stateId);
 if(blocked)return {runId:blocked.id,recordId:blocked.record_id,reused:true};
 const recordId=linkedRequest('请继续核实：'+next.question,state.topic_id,owner.record_id);
 const runId=enqueueWithin(recordId,'check');
 event(runId,'continuation_requested',{stateId,sourceRunId:owner.id,kind:next.kind,question:next.question,reason:next.reason,authority:'用户点击同意核实模型建议，不代表认可其假设或交易原则'});
 return {runId,recordId,reused:false};
});}
export function correctState(stateId:string,content:string){
 const result=transaction(()=>{
  const {state,owner}=usableState(stateId);
  const recordId=linkedRequest(content,state.topic_id,owner.record_id);exec("UPDATE records SET kind='correction' WHERE id=?",recordId);
  const at=now();exec('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)',id(),state.topic_id,'correction',content,'active',recordId,content,at,at,null);
  for(const r of all<Run>("SELECT * FROM runs WHERE topic_id=? AND status IN ('queued','running','blocked')",state.topic_id))cancel(r.id);
  bump();invalidateGenerated(state.topic_id);
  // Old delegated questions may encode the now-rejected premise. Keep them, but
  // require an explicit resume instead of silently executing their old wording.
  exec("UPDATE tasks SET status='paused',updated_at=? WHERE topic_id=? AND status='active'",at,state.topic_id);
  event(owner.id,'working_state_corrected',{stateId,sourceId:recordId,requiresReassessment:true});
  return {recordId};
 });syncCards();return result;
}
export function setTopicStatus(topicId:string,status:'active'|'paused'){return transaction(()=>{
 if(!one('SELECT id FROM topics WHERE id=?',topicId))throw Error('关注不存在');
 exec('UPDATE topics SET status=?,updated_at=? WHERE id=?',status,now(),topicId);
 if(status==='paused'){
  for(const t of all<{id:string}>("SELECT id FROM tasks WHERE topic_id=? AND status='active'",topicId))pauseTask(t.id,'paused');
  for(const r of all<Run>("SELECT * FROM runs WHERE topic_id=? AND status IN ('queued','running','blocked')",topicId))cancel(r.id);
 }
 // Resume restores the focus only, never old tasks or paid work automatically.
});}
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
