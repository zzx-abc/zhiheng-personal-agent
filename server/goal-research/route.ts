import {filingQuestion,asksHistory,namedSubjects} from './subject';
import {all,exec,one,type Run} from '../db';
import {requireScope,type Scope} from '../feishu/unified-store';
import type {ModelCall} from '../model';
import {items,dependencies,show,linkResearch} from './store';
import {runResearch} from './loop';

export async function routeResearch(run:Run,s:Scope,text:string,parent:string|null,call?:ModelCall){
 if(s.scene!=='p2p'||process.env.RESEARCH_ENABLED==='0')return null;
 const refs=[...new Set(text.toUpperCase().match(/\bG-\d+\b/g)||[])];
 const localMaterial=/研报|资料|笔记|报告|公告|教材|讲义|材料/.test(text);
 const compare=/对比|比较|验证|核实|哪些|还缺|新增|解决|研究|收入|兑现|缺少/.test(text);
 const market=/雷达|\b[ER]-\d+\b/i.test(text);
 const followsComparison=/^在.{2,15}(侧|方面)呢/.test(text)&&/港股|估值|溢价/.test(text);
 const memoryQuestion=followsComparison||asksHistory(text)&&/研究|想法|判断|看法|影响|记忆.*(?:联调|聊调)/.test(text);
 const issuerQuestion=filingQuestion(text)&&/影响|核实|验证|怎么看|属实|研究/.test(text);
 const follow=/上次|之前的疑问|继续.{0,5}(研究|那件事)/.test(text);
 const cross=localMaterial&&compare&&(market||follow||/对比|比较/.test(text));
 if(!refs.length&&!cross&&!memoryQuestion&&!issuerQuestion&&!(follow&&/缺少|继续.*研究|那件事/.test(text)))return null;
 if(/^https?:\/\//.test(text))return null;
 if(/^(?:确认删除|删除|暂停|停止|保存|收藏|收录|原文|重试整理|补充[：:]|纠正[：:])/.test(text))return null;
 requireScope(s,true);
 const existing=one<{number:number}>('SELECT number FROM research_items WHERE run_id=?',run.id);
 if(existing){
  const saved=items(s,existing.number)[0];
  if(saved?.brief)return {text:show(saved),...dependencies(s,saved.run_id)};
 }
 const choices=items(s,refs.length===1?Number(refs[0].slice(2)):undefined).filter(i=>i.run_id!==run.id);
 const simpleView=refs.length===1&&/^(?:(?:查看|打开)?(?:研究记录|研究事项)?\s*)G-\d+[。！\s]*$/i.test(text);
 if(refs.length>1||refs.length&&!choices.length)return {text:'请指定一份本私聊可访问的研究记录。',entryIds:[]};
 if(simpleView){
  const item=choices[0],deps=dependencies(s,item.run_id);
  linkResearch(run.id,item.run_id);
  for(const key of deps.entryIds)exec('INSERT OR IGNORE INTO library_run_sources SELECT ?,entry_id,version FROM library_run_sources WHERE run_id=? AND entry_id=?',run.id,item.run_id,key);
  return {text:show(item,true),...deps,researchOrigin:item.run_id};
 }
 const parentItem=parent?one<{run_id:string}>(`SELECT i.run_id FROM research_items i JOIN feishu_replies r ON r.run_id=i.run_id WHERE r.message_id=? AND r.chat=?`,parent,s.chat):undefined;
 let prior=refs.length===1?choices[0]:undefined;
 if(!prior&&follow){
  if(parentItem)prior=choices.find(i=>i.run_id===parentItem.run_id);
  if(!prior&&choices.length===1)prior=choices[0];
  if(!prior&&choices.length>1)return {text:'你想继续哪件事？\n'+choices.map(i=>'G-'+i.number+' · '+i.goal.slice(0,65)).join('\n'),entryIds:[]};
 }
 const submitted=parent?all<{entry_id:string}>(`SELECT sub.entry_id FROM library_ingestions i JOIN library_submissions sub ON sub.ingestion_id=i.id
 JOIN feishu_inbox box ON box.message_id=i.message_id JOIN feishu_scopes fs ON fs.run_id=box.run_id
 WHERE i.channel='feishu' AND i.event_key=json_array(fs.app,fs.tenant,i.message_id) AND i.message_id=? AND i.sender=fs.sender AND i.conversation=fs.chat
 AND fs.app=? AND fs.tenant=? AND fs.sender=? AND fs.chat=? AND fs.generation=?`,parent,s.app,s.tenant,s.sender,s.chat,s.generation).map(x=>x.entry_id):[];
 const bound=parent?all<{entry_id:string}>('SELECT entry_id FROM feishu_private_refs WHERE app=? AND tenant=? AND sender=? AND chat=? AND message_id=?',s.app,s.tenant,s.sender,s.chat,parent).map(x=>x.entry_id):[];
 let goal=text;
 if(memoryQuestion&&!namedSubjects(text).length&&(followsComparison||/它|这家|这件事|这几个回复/.test(text))){
  const previous=all<{content:string}>(`SELECT i.content FROM feishu_inbox i JOIN feishu_scopes h ON h.run_id=i.run_id
   WHERE h.app=? AND h.tenant=? AND h.scene='p2p' AND h.sender=? AND h.chat=? AND h.thread=? AND h.generation=?
   AND i.rowid<(SELECT rowid FROM feishu_inbox WHERE run_id=?) ORDER BY i.rowid DESC LIMIT 4`,s.app,s.tenant,s.sender,s.chat,s.thread,s.generation,run.id)
   .map(x=>String(JSON.parse(x.content).text||''));
  const names=[...new Set(previous.flatMap(namedSubjects))];
  if(names.length!==1)return {text:'你指的是哪家公司？我会对照你当时的研究原话。',entryIds:[]};
  const context=previous.find(t=>t.includes(names[0]))!;
  goal=text+'\n同一私聊前文（本人原话，事件尚待核实）：'+context.slice(0,450);
  if(followsComparison)goal+='\n接续此前同一私聊疑问：'+previous.slice(0,2).map(t=>t.slice(0,240)).join('；');
  if(/这几个回复/.test(text))goal+='\n请从历史原话具体说明哪些旧判断和最近的问题有关。此前的问题：'+previous.slice(0,2).map(t=>t.slice(0,240)).join('；');
 }
 return runResearch(run,s,goal,[...new Set([...bound,...submitted])],call,prior);
}
