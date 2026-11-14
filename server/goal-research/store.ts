import {db,one,all,exec,now} from '../db';
import {entry} from '../library/service';
import {checkByRun} from '../feishu/radar-checks';
import {requireScope,eventBySignal,type Scope} from '../feishu/unified-store';
import type {Step} from './tools';

db.exec(`
CREATE TABLE IF NOT EXISTS research_items(
 number INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
 owner_scope TEXT NOT NULL,goal TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'running',brief TEXT,
 decisions INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_limits(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,max_tokens INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS research_steps(
 run_id TEXT NOT NULL REFERENCES research_items(run_id) ON DELETE CASCADE,seq INTEGER NOT NULL,
 action TEXT NOT NULL,arg TEXT NOT NULL,reason TEXT NOT NULL,result TEXT,PRIMARY KEY(run_id,seq));
CREATE TABLE IF NOT EXISTS research_record_sources(
 run_id TEXT NOT NULL REFERENCES research_items(run_id) ON DELETE CASCADE,record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,PRIMARY KEY(run_id,record_id));
CREATE TABLE IF NOT EXISTS research_parents(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,origin TEXT NOT NULL REFERENCES research_items(run_id) ON DELETE CASCADE,PRIMARY KEY(run_id,origin));
CREATE TRIGGER IF NOT EXISTS research_parent_deleted BEFORE DELETE ON research_items BEGIN
 UPDATE runs SET status='stale',result=NULL WHERE id IN (SELECT run_id FROM research_parents WHERE origin=OLD.run_id);
END;
CREATE TRIGGER IF NOT EXISTS research_library_invalid AFTER UPDATE OF status ON runs
 WHEN NEW.status='stale' BEGIN DELETE FROM research_items WHERE run_id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS research_record_deleted BEFORE DELETE ON records BEGIN
 UPDATE runs SET status='stale',result=NULL WHERE id IN (SELECT run_id FROM research_record_sources WHERE record_id=OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS research_memory_withdrawn AFTER UPDATE OF status ON memories WHEN NEW.status='withdrawn' BEGIN
 UPDATE runs SET status='stale',result=NULL WHERE id IN (SELECT run_id FROM research_record_sources WHERE record_id=NEW.source_id);
END;
CREATE TRIGGER IF NOT EXISTS research_topic_correction AFTER INSERT ON memories WHEN NEW.kind='correction' AND NEW.topic_id IS NOT NULL BEGIN
 UPDATE runs SET status='stale',result=NULL WHERE id IN (SELECT s.run_id FROM research_record_sources s JOIN records r ON r.id=s.record_id WHERE r.topic_id=NEW.topic_id);
END;`);
export type Brief={answer:string;citations:{kind:string;location:string;quote:string;asOf:string|null}[];unknown:string;next:string};
export type Item={number:number;run_id:string;goal:string;status:string;brief:string|null;decisions:number;created_at:string};
const owner=(s:Scope)=>JSON.stringify([s.app,s.tenant,s.sender,s.chat,s.generation]);
export function items(s:Scope,n?:number){
 requireScope(s,true);
 return all<Item>('SELECT * FROM research_items WHERE owner_scope=?'+(n===undefined?'':' AND number=?')+' ORDER BY number DESC LIMIT 4',owner(s),...(n===undefined?[]:[n]));
}
export function openItem(s:Scope,key:string,goal:string){
 requireScope(s,true);exec("INSERT OR IGNORE INTO research_items(run_id,owner_scope,goal,created_at) VALUES(?,?,?,?)",key,owner(s),goal,now());
 return one<Item>('SELECT * FROM research_items WHERE run_id=? AND owner_scope=?',key,owner(s))!;
}
export function stepsFor(key:string):Step[]{
 return all<{action:Step['tool'];arg:string;reason:string;result:string}>('SELECT * FROM research_steps WHERE run_id=? AND result IS NOT NULL ORDER BY seq',key)
 .map(r=>({tool:r.action,arg:r.arg,reason:r.reason,result:JSON.parse(r.result)}));
}
export function linkResearch(runId:string,origin:string){
 exec('INSERT OR IGNORE INTO research_parents VALUES(?,?)',runId,origin);
}
export function dependencies(s:Scope,key:string){
 requireScope(s,true);
 const sources=all<{entry_id:string;version:number}>('SELECT * FROM library_run_sources WHERE run_id=?',key);
 if(sources.some(x=>entry(x.entry_id).version!==x.version))throw Error('研究来源已更新');
 const steps=stepsFor(key);
 const ancestors=all<{origin:string}>(`WITH RECURSIVE parents(origin) AS (
  SELECT origin FROM research_parents WHERE run_id=? UNION SELECT rp.origin FROM research_parents rp JOIN parents p ON rp.run_id=p.origin
 ) SELECT origin FROM parents`,key);
 for(const parent of ancestors)steps.push(...stepsFor(parent.origin));
 const checks=[...new Set(steps.flatMap(x=>x.result.checks||[]))],events=[...new Set(steps.flatMap(x=>x.result.events||[]))];
 if(checks.some(k=>!checkByRun(s,k))||events.some(k=>!eventBySignal(s,k)))throw Error('雷达范围已更新');
 return {entryIds:sources.map(x=>x.entry_id),checks,events};
}
export const statusName:Record<string,string>={completed:'已完成',partial:'部分完成',blocked:'等待证据',running:'处理中'};
export function show(item:Item,full=false){
 const ref='G-'+item.number;
 if(!item.brief)return ref+' · '+statusName[item.status];
 const b:Brief=JSON.parse(item.brief);
 const lines=[ref+' · '+statusName[item.status],b.answer];
 if(full)lines.push('研究问题：'+item.goal);
 for(const c of b.citations.slice(0,full?6:2))lines.push(c.kind+' · '+c.location+'：“'+c.quote+'”'+(c.asOf?'（'+c.asOf.slice(0,10)+'）':''));
 if(b.unknown)lines.push('仍缺：'+b.unknown);
 if(b.next)lines.push('下一步：'+b.next);
 if(full){
  const labels={find_material:'查找资料',read_material:'阅读原文',past_question:'回看原先疑问',radar:'核对雷达',official:'补查公开披露'};
  for(const step of stepsFor(item.run_id))lines.push(labels[step.tool]+' · '+step.result.coverage);
 }
 else lines.push('私聊回复「研究记录 '+ref+'」查看依据与步骤。');
 return lines.join('\n');
}
