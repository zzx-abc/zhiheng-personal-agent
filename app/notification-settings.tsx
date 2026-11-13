'use client';
import {useState} from 'react';
import type {NotificationState} from './types';
const labels:Record<string,string>={queued:'等待后台发送',sending:'正在发送',sent:'飞书已接收',failed:'发送失败',unknown:'送达状态未知',cancelled:'已取消'};
export function NotificationSettings({data,busy,action,worker}:{data:NotificationState;busy:boolean;action:(body:Record<string,unknown>,message?:string)=>Promise<unknown>;worker?:string}){
 const [webhook,setWebhook]=useState(''),[secret,setSecret]=useState(''),[clearSecret,setClearSecret]=useState(false),[retry,setRetry]=useState<string|null>(null),[disconnect,setDisconnect]=useState(false);
 const dirty=!!webhook||!!secret||clearSecret;
 return <section className="settings-section notification-settings"><h3>飞书通知</h3>
  <p>{data.configured?(data.enabled?'已开启 · 完成后主动告诉你':'已连接 · 自动通知尚未开启'):'接收回顾和委托核实的结果，不必一直打开网页。'}</p>
  <p className="muted">仅通知开启后完成的每周回顾、核实结果或失败。持续观察需单独启用任务并选择飞书；普通聊天不推送，不补发旧结果。内容将发送到机器人所在群，群成员均可看到。</p>
  <form onSubmit={async e=>{e.preventDefault();if(await action({action:'notification_settings',webhook:webhook.trim()||undefined,secret:clearSecret?'':secret.trim()||undefined,enabled:data.enabled},'已保存飞书连接，尚未发送测试')){setWebhook('');setSecret('');setClearSecret(false)}}}>
   <details open={!data.configured}><summary>{data.configured?'更换连接或配置签名':'配置飞书连接'}</summary>
    <label>飞书 Webhook<input type="password" autoComplete="new-password" value={webhook} onChange={e=>setWebhook(e.target.value)} placeholder={data.configured?'已保存，留空不更换':'粘贴群机器人的 Webhook 地址'}/></label>
    <label>签名密钥（机器人开启签名校验时填写）<input type="password" autoComplete="new-password" disabled={clearSecret} value={secret} onChange={e=>setSecret(e.target.value)} placeholder={data.signed?'已保存，留空不更换':'未启用签名校验可留空'}/></label>
    {data.signed&&<label className="notification-option"><input type="checkbox" checked={clearSecret} onChange={e=>setClearSecret(e.target.checked)}/>清除本机签名密钥（请同时关闭机器人签名校验）</label>}
    <p className="muted">只保存在这台 Mac，不进入数据导出或 Git。若使用关键词校验，请允许“知衡”。</p>
    <button className="small-primary" disabled={busy||(!data.configured&&!webhook.trim())}>保存飞书连接</button>
   </details>
  </form>
  {data.configured&&<div className="form-actions"><button className="outline" disabled={busy||dirty} onClick={()=>action({action:'notification_test'},'测试通知已排队，请查看下方发送状态')}>发送测试通知</button><button className="small-primary" disabled={busy||dirty} onClick={()=>action({action:'notification_settings',enabled:!data.enabled},data.enabled?'已关闭后续通知，排队消息已取消':'已开启后续结果通知，不补发历史消息')}>{data.enabled?'关闭自动通知':'开启自动通知'}</button></div>}
  {dirty&&data.configured&&<p className="muted">请先保存修改，再发送测试或切换通知。</p>}
  <p className="muted">{worker==='online'?'本机后台正在运行。':'后台暂未在线，消息会等待后台恢复。'}电脑休眠或服务关闭时不能发送。通知不额外调用模型；“飞书已接收”不等于手机已经提醒或你已读。</p>
  {!!data.receipts.length&&<details open><summary>最近发送状态</summary><ul className="notification-receipts">{data.receipts.map(r=><li key={r.id}><div><strong>{r.kind==='test'?'连接测试':r.kind==='weekly'?'每周回顾':r.kind==='observation'?'持续观察':r.kind==='library_feishu'?'资料收件回复':'委托核实'}</strong><span>{labels[r.status]||r.status}</span></div><time>{new Date(r.updated_at).toLocaleString('zh-CN',{hour12:false})}</time>{r.error&&<p>{r.error}</p>}{r.kind!=='library_feishu'&&['failed','unknown'].includes(r.status)&&(retry===r.id?<><p>请先查看飞书群，避免重复发送。重新发送会使用当前保存的群机器人。</p><button className="quiet" disabled={busy||dirty} onClick={async()=>{if(await action({action:'notification_retry',id:r.id},'已重新排队'))setRetry(null)}}>确认重新发送</button><button className="quiet" onClick={()=>setRetry(null)}>取消</button></>:<button className="quiet" disabled={busy||dirty} onClick={()=>setRetry(r.id)}>重试通知</button>)}</li>)}</ul></details>}
  {data.configured&&(disconnect?<div><p>移除本机连接并取消排队消息，已经发到飞书的消息仍会保留。</p><button className="danger" disabled={busy} onClick={async()=>{if(await action({action:'notification_disconnect'},'已移除飞书连接'))setDisconnect(false)}}>确认移除连接</button><button className="quiet" onClick={()=>setDisconnect(false)}>取消</button></div>:<button className="quiet" onClick={()=>setDisconnect(true)}>移除飞书连接</button>)}
 </section>;
}
