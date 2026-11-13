import {all,one,exec,id,now,revision,transaction} from '../db';
import {ingest,search,entry,annotate,taskDraft,deleteEntry,detail,setRetention,chunks} from './service';
import {recordCard,answerRecords} from './answers';
export async function libraryConversation(text:string,parent:string|null){
 const parentRun=parent?one<{run_id:string}>('SELECT id run_id FROM runs WHERE record_id=? AND mode=\'library_chat\' ORDER BY created_at DESC LIMIT 1',parent):null;
 const bound=parentRun?all<{entry_id:string;version:number}>('SELECT entry_id,version FROM library_run_sources WHERE run_id=?',parentRun.run_id):[];
 const isRequest=/^(找回资料|搜索资料|检索资料|我上次存|帮我找.*(?:报告|资料)|收藏资料|收录资料|记录想法|记一下|这篇存一下)/.test(text);
 if(!isRequest&&!bound.length)return null;
 let keys=bound.filter(s=>{try{return entry(s.entry_id).version===s.version}catch{return false}}).map(s=>s.entry_id);let reply='';const explicit=text.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g);if(explicit)keys=explicit.filter(k=>{try{entry(k);return true}catch{return false}});
 try{if(/^(找回|搜索|检索|我上次存|帮我找)/.test(text)){const result=await search(text);keys=result.results.map(r=>r.id);reply=keys.length?result.results.map(r=>`${r.title}\n${r.reason}\n${r.excerpt}\n记录编号：${r.id}`).join('\n\n'):'没有找到相关有效收藏；尚未解析的资料仍可按文件名查找。';}
 else if(/^(收藏资料|收录资料|记录想法|记一下|这篇存一下)/.test(text)){const url=text.match(/https:\/\/[^\s<>]+/)?.[0];const own=/^(记录想法|记一下)/.test(text);const saved=ingest({text:url?undefined:text.replace(/^(收藏资料|收录资料|记录想法|记一下|这篇存一下)[：:，,\s]*/,''),url,instruction:text,intent:own?'note':'collect',eventKey:id()});keys=saved.entryIds;reply=keys.map(recordCard).join('\n\n');}
 else if(/^(纠正|你理解错|不是这个意思|补充)/.test(text)){if(keys.length!==1)reply='请在资料面板选择目标，或提供记录编号；当前有多个可能对象。';else{annotate(keys[0],text,/^补充/.test(text)?'note':'correction');reply='已保存本次原话，旧理解和相关回答已失效。\n'+recordCard(keys[0]);}}
 else if(/^确认删除 /.test(text)){const match=text.match(/^确认删除 ([\w-]+) v(\d+)$/);if(keys.length!==1||!match||match[1]!==keys[0])reply='请按记录编号和版本确认删除。';else{const result=deleteEntry(keys[0],+match[2]);reply='本机记录、批注、派生与索引已删除。'+result.remoteNotice;keys=[];}}
 else if(/^删除/.test(text)){reply=keys.length===1?`删除此记录及全部批注/历史/派生索引；共享文件仍有其他引用则保留。请回复：确认删除 ${keys[0]} v${entry(keys[0]).version}`:'请提供要删除的记录编号，不能猜测目标。';}
 else if(/持续跟进|以后.*提醒/.test(text)){reply=keys.length===1?'已保存后续待办草稿，未启用后台监控。编号：'+taskDraft(keys[0],text).taskId:'请说明要跟进哪条记录。';}
 else if(keys.length){const answer=await answerRecords(text,keys.slice(0,3));reply=answer.answer+'\n'+answer.citations.map(c=>'原文依据：'+c.quote).join('\n')+'\n'+answer.unknowns.join('；');}
 else reply='关联资料已修改或删除，请从资料入口重新选择有效记录。';
 }catch(e){reply=e instanceof Error?e.message:'记录操作未完成';}
 const recordId=id(),runId=id(),at=now();transaction(()=>{exec("INSERT INTO records VALUES(?,NULL,'user','action_request',?,?,NULL)",recordId,text,at);exec('INSERT INTO record_context VALUES(?,?,?)',recordId,parent,parent||recordId);const result=JSON.stringify({judgment:reply,reasons:[],uncertainties:[],next_step:'在“资料”查看原文、当前批注和处理状态。'});exec("INSERT INTO runs(id,record_id,mode,status,revision,created_at,finished_at,result) VALUES(?,?,'library_chat','succeeded',?,?,?,?)",runId,recordId,revision(),at,at,result);exec("INSERT INTO records VALUES(?,NULL,'assistant','analysis',?,?,?)",id(),result,at,runId);for(const key of keys)try{exec('INSERT INTO library_run_sources VALUES(?,?,?)',runId,key,entry(key).version)}catch{};});return {recordId,runId,entryIds:keys};
}
