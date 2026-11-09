'use client';
import {useState} from 'react';
import type {MemoryLink,Tag} from './types';
type Action=(body:Record<string,unknown>,message:string)=>Promise<unknown>;
const relationNames:Record<string,string>={basis:'找回原来的依据',compare:'对照两次想法',supports:'提供支持线索',challenges:'检查反向线索',recall:'回顾原话'};
export function MemoryLinks({links,action,openSource,busy}:{links:MemoryLink[];action:Action;openSource:(id:string)=>void;busy:boolean}){
 const [editing,setEditing]=useState<string|null>(null),[note,setNote]=useState('');
 if(!links.length)return null;
 return <details className="memory-links"><summary>这次联系了 {links.length} 条历史</summary><p className="muted">原文各自保留。关联是否准确，你可以随时纠正。</p>{links.map(link=><article className="memory-link" key={link.id}>
  <div className="card-meta"><span>{relationNames[link.relation]||'历史参考'}</span><span>{link.status==='confirmed'?'你已确认':link.status==='rejected'?'你已否认':'模型关联'}</span></div>
  <p>{link.reason}</p><button className="link-original" onClick={()=>openSource(link.target_id)}>“{link.target_quote}” <span>查看原文 ↗</span></button>
  {link.feedback_note&&<p className="link-feedback-note">你的纠正：{link.feedback_note}{link.feedback_source_id&&<button className="quiet" onClick={()=>openSource(link.feedback_source_id!)}>查看反馈原文 ↗</button>}</p>}
  <div className="form-actions">{link.status==='proposed'?<><button className="quiet" disabled={busy} onClick={()=>action({action:'link_feedback',id:link.id,decision:'confirmed'},'已记住：这个关联有帮助；原文仍独立保存')}>关联准确</button><button className="quiet" disabled={busy} onClick={()=>action({action:'link_feedback',id:link.id,decision:'rejected'},'已纠正：这段讨论不再自动引用它；相似问题会重新核对')}>不是这件事</button></>:<button className="quiet" disabled={busy} onClick={()=>action({action:'link_feedback',id:link.id,decision:'proposed'},'已撤销反馈，历史记录仍保留')}>撤销这个反馈</button>}
   <button className="quiet" onClick={()=>{setEditing(editing===link.id?null:link.id);setNote('')}}>说明哪里不对</button>
  </div>{editing===link.id&&<form className="link-correction" onSubmit={async e=>{e.preventDefault();if(await action({action:'link_feedback',id:link.id,decision:'rejected',note},'已保存关联纠正，下次会带上这条说明'))setEditing(null)}}><label>这两条应该怎样理解？<textarea value={note} onChange={e=>setNote(e.target.value)} required maxLength={500} placeholder="比如：这是短线试仓，与原来那笔持仓不是同一件事。"/></label><button className="small-primary" disabled={busy}>保存关联纠正</button></form>}
 </article>)}</details>;
}
export function TagEditor({tags,action,busy}:{tags:Tag[];action:Action;busy:boolean}){
 const [selected,setSelected]=useState<Tag|null>(null),[label,setLabel]=useState('');
 if(!tags.length)return null;
 return <section className="tag-editor"><p className="muted">用于找回相关内容，不代表持仓或交易规则。点击标签可以纠正。</p><div className="memory-tags">{tags.map(tag=><button key={tag.id} title={'原文：'+tag.quote} onClick={()=>{setSelected(tag);setLabel(tag.label)}}>{tag.label}<span>{tag.origin==='user'?' · 你已修改':''}</span></button>)}</div>
 {selected&&<form onSubmit={async e=>{e.preventDefault();if(await action({action:'tag_correct',id:selected.id,label},'标签已更新，下次检索使用新标签'))setSelected(null)}}><p className="muted">原文依据：“{selected.quote}”</p><label>修改标签<input value={label} onChange={e=>setLabel(e.target.value)} maxLength={40} required/></label><div className="form-actions"><button className="small-primary" disabled={busy}>保存标签</button><button type="button" className="quiet" disabled={busy} onClick={async()=>{if(await action({action:'tag_correct',id:selected.id,label:''},'已移除标签，自动整理不会再次添加同一个标签'))setSelected(null)}}>移除标签</button><button type="button" className="quiet" onClick={()=>setSelected(null)}>取消</button></div></form>}
 </section>;
}
