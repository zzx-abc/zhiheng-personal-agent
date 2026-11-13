'use client';
import {useState} from 'react';
import type {Snapshot,Run} from './types';
import {continuityItems,executionReceipt,type ContinuityItem} from './continuity-model';

type Props={data:Snapshot;busy:boolean;action:(body:Record<string,unknown>,message?:string)=>Promise<unknown>;
 open:(id:string|null)=>void;draft:(text:string,id:string|null)=>void;source:(id:string)=>void};
const at=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});

export function ContinuityBoard(props:Props){
 const items=continuityItems(props.data),active=items.filter(i=>i.topic.status==='active'),paused=items.filter(i=>i.topic.status==='paused');
 if(!items.length)return null;
 return <section className="continuity-board" aria-label="正在想清楚的事">
  <div className="section-heading"><h2>正在想清楚的事</h2><span className="muted">{active.length} 件</span></div>
  <p className="fragment-hint">接上原来的依据，往前核实一步。只是随手记的片段仍独立保留。</p>
  <div className="continuity-list">{active.slice(0,3).map(item=><FocusCard key={item.topic.id} {...props} item={item}/>)}</div>
  {active.length>3&&<details className="more-focus"><summary>其余 {active.length-3} 件</summary>{active.slice(3).map(item=><FocusCard key={item.topic.id} {...props} item={item}/>)}</details>}
  {!!paused.length&&<details className="more-focus"><summary>已暂停 {paused.length} 件</summary>{paused.map(item=><FocusCard key={item.topic.id} {...props} item={item}/>)}</details>}
  <p className="continuity-boundary">{props.data.worker?.state==='online'?'后台在线。页面可关闭，本机服务和电脑需保持运行。':'暂未检测到后台运行，请用「启动知衡」开启服务；请求会保存，尚不保证执行。'} 点击核实才执行，不自动盯盘。</p>
 </section>;
}

function FocusCard({item,data,busy,action,open,draft,source}:Props&{item:ContinuityItem}){
 const [editing,setEditing]=useState(false),[correction,setCorrection]=useState('');
 const {topic,state,version,latest,live,stale,receipt}=item;
 const paused=topic.status==='paused',next=state?.next_action;
 const executable=next&&['official_search','market_data'].includes(next.kind);
 const blocked=latest&&['failed','blocked','cancelled'].includes(latest.status);
 const gap=stale?'你的纠正已保存，旧理解已停用。下一次讨论会先读取纠正。':receipt?.missing||state?.open_questions?.[0];
 return <article className={'focus-card'+(paused?' paused':'')} aria-label={topic.title}>
  <div className="card-meta"><span className={live?'focus-live':''}>{live&&<i className="spinner"/>}{item.status}</span><time>{at(latest?.created_at||topic.updated_at)}</time></div>
  <h3><button onClick={()=>open(item.resumeId)}>{topic.title}</button></h3>
  {state?<><p className="focus-assessment">{state.assessment}</p><p className="focus-asof">模型整理于 {at(version!.created_at)}，不是实时结论</p>
   {state.decision_frame?.original_basis&&<button className="focus-basis" onClick={()=>source(state.decision_frame!.original_basis!.source_id)}><span>你原来的依据</span>“{state.decision_frame.original_basis.quote}”</button>}
  </>:!stale&&<p className="focus-assessment">{topic.question}</p>}
  {gap&&<p className="focus-gap"><span>{stale?'已改正':'待弄清'}</span>{gap}</p>}
  {!stale&&next&&<p className="focus-next"><span>{executable?'下一步可核实':'下一步'}</span>{next.question}</p>}
  {!stale&&latest?.error&&<p className="focus-error">{latest.error}</p>}
  <div className="focus-actions">
   {paused?<button className="small-primary" disabled={busy} onClick={()=>action({action:'topic_status',id:topic.id,status:'active'},'已恢复关注；旧委托仍暂停，不会自动运行')}>恢复关注</button>
    :live?<button className="small-primary" disabled={busy} onClick={()=>action({action:'cancel',id:live.id},'已停止本次处理，原话仍保留')}>停止本次处理</button>
    :stale?<button className="small-primary" onClick={()=>draft('请按我最新的纠正，重新梳理这件事；保留仍有效的依据。',item.resumeId)}>接着纠正后的理解</button>
    :blocked?<button className="small-primary" disabled={busy} onClick={()=>action({action:'retry',id:latest.id},'已提交重试，请留意执行状态')}>重试这一步</button>
    :executable&&version?<button className="small-primary" disabled={busy} onClick={()=>action({action:'continue_state',id:version.id},'已提交本次核实，可在这里查看进展')}>核实这一步</button>
    :item.task?<button className="small-primary" disabled={busy} onClick={()=>action({action:'run_task',id:item.task!.id},'已提交委托检查，可在这里查看进展')}>检查这项委托</button>
    :<button className="small-primary" onClick={()=>open(item.resumeId)}>{next?.kind==='user_material'?'补充这个情况':'接着聊'}</button>}
   <button className="quiet" onClick={()=>open(item.resumeId)}>查看讨论</button>
   {!paused&&version&&<button className="quiet" disabled={busy} onClick={()=>setEditing(!editing)}>理解不对</button>}
   {!paused&&<button className="quiet" disabled={busy} onClick={()=>action({action:'topic_status',id:topic.id,status:'paused'},'已暂停关注和相关执行；原文与历史仍保留')}>先放一放</button>}
  </div>
  {editing&&version&&<form className="focus-correction" onSubmit={async e=>{e.preventDefault();if(await action({action:'correct_state',id:version.id,content:correction},'纠正已保存，旧理解已停用；相关旧委托已暂停')){setEditing(false);setCorrection('')}}}>
   <label>这件事哪里理解错了？<textarea autoFocus required maxLength={1000} value={correction} onChange={e=>setCorrection(e.target.value)} placeholder="例如：这是我的担心，不是我的交易规则。"/></label>
   <p className="muted">保存即停用旧理解并暂停相关执行，不需要调用模型。再次讨论时再整理。</p>
   <button className="small-primary" disabled={busy||!correction.trim()}>保存这次纠正</button><button className="quiet" type="button" onClick={()=>setEditing(false)}>取消</button>
  </form>}
 </article>;
}

export function EvidenceReceipt({data,run,openSource}:{data:Snapshot;run:Run;openSource:(id:string)=>void}){
 if(!['succeeded','partial','stale'].includes(run.status))return null;
 const receipt=executionReceipt(data,run);
 const evidence=data.evidence.filter(e=>e.run_id===run.id);
 return <details className="evidence-receipt"><summary>{run.status==='stale'?'历史分析，已有修正':receipt.checked?'本次核实已完成':receipt.attempted?'已尝试查证，仍有缺口':'基于已有材料梳理，未查最新资料'}</summary>
  <p>{receipt.reviewed?'分析与质疑已独立检查，Leader 已整合。':'本次未经过完整的两个视角审议。'}审议使用同一模型，不是独立事实来源。</p>
  <p>{receipt.externalCount?`取得 ${receipt.externalCount} 份正文、片段或行情材料；来源可查看，解读仍可能出错。`:'本次没有可计入核实的正文、片段或行情材料。'}</p>
  {evidence.map(e=><button key={e.id} className="source-chip" onClick={()=>openSource(e.id)}>{e.title}</button>)}
  {receipt.missing&&<p>尚缺：{receipt.missing}</p>}
 </details>;
}
