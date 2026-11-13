import type {Answer,Run,Snapshot} from './types';
import type {WorkingState} from '../server/working-state';

export function readJson<T>(value:string|null|undefined):T|null {
 try { return value ? JSON.parse(value) as T : null; } catch { return null; }
}

/** Execution facts only. A valid URL or several agreeing agents is not proof. */
export function executionReceipt(data:Snapshot,run:Run){
 const evidence=data.evidence.filter(e=>e.run_id===run.id);
 const outcome=readJson<{status:string;missing?:string[];reason?:string}>(data.events.find(e=>e.run_id===run.id&&e.type==='research_finished')?.detail);
 const agents=new Set(data.reports.filter(r=>r.run_id===run.id).map(r=>r.agent));
 const external=evidence.filter(e=>['body','excerpt','market'].includes(e.level));
 const answer=readJson<Answer>(run.result);
 return {
  externalCount:external.length,
  reviewed:agents.has('analysis')&&agents.has('challenge')&&agents.has('leader'),
  checked:run.status==='succeeded'&&external.length>0&&outcome?.status==='answered'&&answer?.evidence_sufficient===true,
  missing:outcome?.missing?.[0]||answer?.uncertainties?.[0]||'',
  attempted:!!outcome||data.events.some(e=>e.run_id===run.id&&e.type==='search_unavailable'),
 };
}

export function continuityItems(data:Snapshot){
 return data.topics.map(topic=>{
  const runs=data.runs.filter(r=>r.topic_id===topic.id);
  const live=runs.find(r=>['queued','running'].includes(r.status));
  const latest=live||runs[0];
  const version=data.workingStates.find(s=>s.topic_id===topic.id&&s.status==='current');
  const owner=version?data.runs.find(r=>r.id===version.run_id):undefined;
  const state=version&&owner&&['succeeded','partial'].includes(owner.status)?readJson<WorkingState>(version.content):null;
  const stale=!state&&data.workingStates.some(s=>s.topic_id===topic.id);
  const task=data.tasks.find(t=>t.topic_id===topic.id&&t.status==='active');
  const records=data.records.filter(r=>r.topic_id===topic.id&&r.role==='user');
  const lastRecord=records.at(-1);
  const receipt=latest?executionReceipt(data,latest):null;
  let status='待继续梳理';
  if(topic.status==='paused')status='已暂停';
  else if(live)status=live.status==='queued'?(data.worker?.state==='online'?'等待处理':'已排队，等待后台'):(data.worker?.state==='offline'?'后台失联，等待恢复':'正在处理');
  else if(stale)status='理解已更新，待重新梳理';
  else if(latest?.status==='blocked')status='等待连接模型';
  else if(latest?.status==='failed')status='执行未完成';
  else if(latest?.status==='cancelled')status='已停止';
  else if(latest?.status==='partial')status='还缺证据';
  else if(receipt?.checked)status='已完成本次核实';
  else if(state?.next_action?.kind==='user_material')status='需要你的补充';
  else if(receipt?.attempted)status='还缺证据';
  else if(task&&!task.last_run_id)status='已记住委托，尚未检查';
  else if(state)status='已梳理，尚未查证';
  return {topic,version:state?version:null,state,latest,live,task,stale,receipt,status,
   recordId:latest?.record_id||lastRecord?.id||null,
   resumeId:lastRecord?.id||latest?.record_id||null};
 }).filter(item=>item.recordId||item.task).sort((a,b)=>
  Number(b.topic.status==='active')-Number(a.topic.status==='active')||Number(!!b.live)-Number(!!a.live)||b.topic.updated_at.localeCompare(a.topic.updated_at));
}
export type ContinuityItem=ReturnType<typeof continuityItems>[number];
