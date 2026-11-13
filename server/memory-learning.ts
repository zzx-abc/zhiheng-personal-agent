import {z} from 'zod';
import {db,all,one,exec,id,now,bump,transaction,event,type RecordRow,type Run} from './db';
import {captureContext} from './conversation-context';

// Tags describe text, never positions, personality or accepted trading rules.
db.exec(`CREATE TABLE IF NOT EXISTS record_tags(
 id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,label TEXT NOT NULL,quote TEXT NOT NULL,origin TEXT NOT NULL,status TEXT NOT NULL,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(record_id,kind,label));
CREATE INDEX IF NOT EXISTS tag_lookup ON record_tags(kind,label,status);
CREATE TABLE IF NOT EXISTS tag_feedback(
 id TEXT PRIMARY KEY,tag_id TEXT REFERENCES record_tags(id) ON DELETE CASCADE,previous_label TEXT NOT NULL,
 replacement TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_links(
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,target_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
 relation TEXT NOT NULL,reason TEXT NOT NULL,current_quote TEXT NOT NULL,target_quote TEXT NOT NULL,
 score REAL NOT NULL,signature TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(run_id,target_id,relation));
CREATE TABLE IF NOT EXISTS link_feedback(
 id TEXT PRIMARY KEY,link_id TEXT NOT NULL REFERENCES memory_links(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,decision TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tag_index(record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,version TEXT NOT NULL);`);
export const tagSchema=z.object({kind:z.enum(['entity','theme','intent','horizon']),label:z.string().trim().min(2).max(40),quote:z.string().min(2).max(200)});
export type TagInput=z.infer<typeof tagSchema>;
export type Tag=TagInput&{id:string;record_id:string;origin:string;status:string};
export const linkSchema=z.object({source_id:z.string(),relation:z.enum(['basis','compare','supports','challenges','recall']),reason:z.string().min(2).max(300),current_quote:z.string().min(2).max(200),target_quote:z.string().min(2).max(200),task:z.number().min(0).max(1),entity:z.number().min(0).max(1),question:z.number().min(0).max(1),validity:z.number().min(0).max(1)});
export type LinkInput=z.infer<typeof linkSchema>;
export type Link={id:string;run_id:string;source_id:string;target_id:string;relation:string;reason:string;current_quote:string;target_quote:string;score:number;signature:string;status:string;created_at:string;updated_at:string};
const rules:[TagInput['kind'],string,RegExp][]=[
 ['theme','订单兑现',/订单(?:质量|改善|兑现|增长|数量)?/],['theme','行业景气',/行业景气|景气度/],['theme','国产替代',/国产替代/],
 ['theme','相对强弱',/相对强弱|强于大盘|弱于大盘/],['theme','市场观察',/盘面|大盘|市场整体/],
 ['intent','考虑调整',/想换(?:仓|过去)?|考虑(?:换仓|调整|卖出)|想卖|有点想追/],
 ['intent','原始依据',/关注.{0,18}(?:因为|是为了)|持有.{0,18}因为|买入.{0,18}因为|原来的依据/],
 ['intent','验证条件',/验证条件|等待.{0,12}(?:披露|兑现)|验证.{0,12}(?:订单|改善)/],
 ['horizon','短线',/短线/],['horizon','中线',/中线/],['horizon','长期',/长期|长线/]
];
export function ruleTags(text:string):TagInput[]{
 const tags:TagInput[]=[];for(const [kind,label,re] of rules){const m=text.match(re);if(m)tags.push({kind,label,quote:m[0]});}
 // Only literal ticker codes are recognized locally; company aliases need the model or user.
 for(const m of text.matchAll(/\b(?:sh|sz)?(?:60|68|00|30)\d{4}\b/gi))tags.push({kind:'entity',label:m[0].toLowerCase(),quote:m[0]});
 return tags.slice(0,10);
}
const canonical=(label:string)=>({订单改善:'订单兑现',订单质量:'订单兑现',换仓:'考虑调整',持有理由:'原始依据',关注理由:'原始依据'}[label]||label.trim());
export function saveTags(record:RecordRow,inputs:TagInput[],origin:'model'|'rule'='model'){
 if(record.role!=='user'||['relation_feedback','tag_feedback','weekly_feedback','action_request'].includes(record.kind))return;
 for(const item of inputs.slice(0,10)){
  const parsed=tagSchema.safeParse(item);if(!parsed.success)continue;
  const t=parsed.data,label=t.kind==='entity'?t.label:canonical(t.label);
  if(!record.content.includes(t.quote)||/(冲动|贪婪|不守纪律|必涨|必跌)/.test(label))continue;
  if(t.kind==='entity'&&!record.content.toLowerCase().includes(label.toLowerCase()))continue;
  if(t.kind==='horizon'&&(/(?:不是|并非|不做|不按|未确定).{0,3}(?:短线|中线|长期|长线)/.test(t.quote)||/(?:不是|并非|不做|不按|未确定).{0,3}$/.test(record.content.slice(Math.max(0,record.content.indexOf(t.quote)-8),record.content.indexOf(t.quote)))))continue;
  // A denied or corrected label cannot be resurrected by indexing or a repeated model call.
  exec('INSERT OR IGNORE INTO record_tags VALUES(?,?,?,?,?,?,?,?,?)',id(),record.id,t.kind,label,t.quote,origin,'active',now(),now());
 }
}
export function ensureRuleTags(record:RecordRow){
 if(one('SELECT record_id FROM tag_index WHERE record_id=? AND version=?',record.id,'v1'))return;
 saveTags(record,ruleTags(record.content),'rule');exec('INSERT OR REPLACE INTO tag_index VALUES(?,?)',record.id,'v1');
}
export function tagsFor(sourceIds:string[]):Tag[]{
 if(!sourceIds.length)return [];
 return all<Tag>(`SELECT * FROM record_tags WHERE status='active' AND record_id IN (${sourceIds.map(()=>'?').join(',')})`,...sourceIds);
}
export function correctTag(tagId:string,label:string){
 transaction(()=>{
  const old=one<Tag>('SELECT * FROM record_tags WHERE id=?',tagId);if(!old)throw Error('标签已不存在');
  const replacement=label.trim();if(replacement===old.label)return;
  exec("UPDATE record_tags SET status='withdrawn',updated_at=? WHERE id=?",now(),tagId);
  if(replacement)exec(`INSERT INTO record_tags VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id,kind,label) DO UPDATE SET status='active',origin='user',updated_at=excluded.updated_at`,id(),old.record_id,old.kind,replacement,old.quote,'user','active',now(),now());
  exec('INSERT INTO tag_feedback VALUES(?,?,?,?,?)',id(),tagId,old.label,replacement,now());
  // A changed label invalidates cross-fragment generalization, not the user's
  // original feedback about this particular pair of records.
  exec("UPDATE memory_links SET signature='' WHERE source_id=? OR target_id=?",old.record_id,old.record_id);bump();
 });
}
function root(recordId:string){return captureContext(recordId)?.root_id||recordId;}
export function signature(recordId:string){
 const tags=tagsFor([recordId]);const entities=tags.filter(t=>t.kind==='entity').map(t=>t.label.toLowerCase()).sort();
 const intents=tags.filter(t=>t.kind==='intent'&&['考虑调整','原始依据','验证条件'].includes(t.label)).map(t=>t.label).sort();
 if(!entities.length||!intents.length)return '';
 return JSON.stringify({entities,intents,horizons:tags.filter(t=>t.kind==='horizon').map(t=>t.label).sort()});
}
/** Confirmations never fabricate new candidates. Rejection is strong within a
 * discussion, and only a bounded warning/penalty in another similar situation. */
export function feedbackFor(recordId:string){
 const scope=root(recordId),sig=signature(recordId);
 return all<Link>("SELECT * FROM memory_links WHERE status IN ('confirmed','rejected') ORDER BY updated_at DESC")
  .filter(l=>root(l.source_id)===scope||(!!sig&&l.signature===sig)).slice(0,12)
  .map(l=>({...l,sameFragment:root(l.source_id)===scope,note:one<{note:string}>('SELECT note FROM link_feedback WHERE link_id=? ORDER BY rowid DESC LIMIT 1',l.id)?.note||''}));
}
function explicitRevisit(recordId:string){const content=one<RecordRow>('SELECT * FROM records WHERE id=?',recordId)?.content||'';return /回顾|找回|查看.{0,8}原话|重新.{0,6}比较/.test(content);}
export function blockedSources(recordId:string){return new Set(feedbackFor(recordId).filter(l=>l.status==='rejected'&&l.sameFragment&&!explicitRevisit(recordId)).map(l=>l.target_id));}
export function feedbackWeight(recordId:string,targetId:string){
 const matches=feedbackFor(recordId).filter(l=>l.target_id===targetId);
 if(matches.some(l=>l.status==='rejected'&&l.sameFragment)&&!explicitRevisit(recordId))return 0;
 if(matches.some(l=>l.status==='rejected'))return .45;
 return matches.some(l=>l.status==='confirmed')?1.15:1;
}
export function proactiveRecall(record:RecordRow):{query:string;reason:string}|null{
 const tags=tagsFor([record.id]);
 if(record.kind==='note'||captureContext(record.id)?.parent_id||!tags.some(t=>t.kind==='intent'&&t.label==='考虑调整'))return null;
 const hasPast=one("SELECT id FROM records WHERE role='user' AND id!=? AND kind NOT IN ('relation_feedback','tag_feedback','weekly_feedback') LIMIT 1",record.id);
 if(!hasPast)return null;
 const entities=tags.filter(t=>t.kind==='entity').map(t=>t.label).join(' ');
 return {query:`${entities} 关注理由 原始依据 验证条件`,reason:'本次考虑调整，主动寻找原先依据与验证条件；对象不明时仅作候选，不能认定是同一笔持仓'};
}
export function tagMatches(query:string,currentId?:string){
 const desired=ruleTags(query).map(t=>t.label);
 if(currentId){const tags=tagsFor([currentId]);desired.push(...tags.filter(t=>['entity','theme'].includes(t.kind)).map(t=>t.label));if(tags.some(t=>t.label==='考虑调整'))desired.push('原始依据','验证条件');}
 for(const t of all<{label:string}>('SELECT DISTINCT label FROM record_tags WHERE status=\'active\''))if(query.includes(t.label))desired.push(t.label);
 const labels=[...new Set(desired)];const scores=new Map<string,number>();
 const count=Number(one<{n:number}>("SELECT count(*) n FROM records WHERE role='user'")?.n||1);
 for(const label of labels){const rows=all<Tag>("SELECT * FROM record_tags WHERE label=? AND status='active'",label);const frequency=new Set(rows.map(t=>t.record_id)).size;const weight=Math.log(1+count/(1+frequency));for(const t of rows)if(t.record_id!==currentId)scores.set(t.record_id,(scores.get(t.record_id)||0)+weight);}
 return scores;
}
export function validateLinks(record:RecordRow,inputs:LinkInput[],candidateIds:Set<string>){
 const denied=blockedSources(record.id);const currentEntities=tagsFor([record.id]).filter(t=>t.kind==='entity').map(t=>t.label.toLowerCase());
 const accepted:(LinkInput&{score:number})[]=[];
 for(const item of inputs){
  const value=linkSchema.safeParse(item);if(!value.success)continue;const l=value.data;
  if(l.source_id===record.id||!candidateIds.has(l.source_id)||denied.has(l.source_id)||accepted.some(x=>x.source_id===l.source_id))continue;
  const target=one<RecordRow>("SELECT * FROM records WHERE id=? AND role='user'",l.source_id);
  if(!target||target.created_at>record.created_at||!record.content.includes(l.current_quote)||!target.content.includes(l.target_quote))continue;
  if(one("SELECT id FROM memories WHERE source_id=? AND status='withdrawn'",target.id))continue;
  const targetEntities=tagsFor([target.id]).filter(t=>t.kind==='entity').map(t=>t.label.toLowerCase());
  if(l.relation==='basis'&&l.entity<.75)continue;
  if(l.relation==='basis'&&currentEntities.length&&targetEntities.length&&!currentEntities.some(e=>targetEntities.includes(e)))continue;
  const score=.4*l.task+.2*l.entity+.25*l.question+.15*l.validity;
  if(l.task<.5||score<.75)continue;
  accepted.push({...l,score});if(accepted.length===3)break;
 }
 return accepted;
}
export function selectedLinks(runId:string){
 const row=one<{detail:string}>("SELECT detail FROM events WHERE run_id=? AND type='memory_selected' ORDER BY rowid DESC LIMIT 1",runId);
 return row?JSON.parse(row.detail).links as (LinkInput&{score:number})[]:null;
}
// Called inside the existing completion transaction: failed runs cannot teach links.
export function saveLinks(run:Run,record:RecordRow){
 for(const l of selectedLinks(run.id)||[])exec('INSERT OR IGNORE INTO memory_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id(),run.id,record.id,l.source_id,l.relation,l.reason,l.current_quote,l.target_quote,l.score,signature(record.id),'proposed',now(),now());
}
export function applyLinkFeedback(linkId:string,decision:'confirmed'|'rejected'|'proposed',note='',sourceId?:string){
 return transaction(()=>{
  const link=one<Link>('SELECT * FROM memory_links WHERE id=?',linkId);if(!link)throw Error('这条关联已不存在');
  const original=one<RecordRow>('SELECT * FROM records WHERE id=?',link.source_id)!;
  const feedbackSource=sourceId||id();
  if(!sourceId){const content=`对历史关联的反馈：${decision==='rejected'?'不是这件事':decision==='confirmed'?'这个关联准确':'撤销之前的反馈'}${note?'。'+note:''}`;
   exec('INSERT INTO records VALUES(?,?,?,?,?,?,?)',feedbackSource,original.topic_id,'user','relation_feedback',content,now(),null);
   exec('INSERT INTO record_context VALUES(?,?,?)',feedbackSource,original.id,root(original.id));
  }
  exec('INSERT INTO link_feedback VALUES(?,?,?,?,?,?)',id(),linkId,feedbackSource,decision,note,now());
  exec('UPDATE memory_links SET status=?,updated_at=? WHERE id=?',decision,now(),linkId);
  if(decision==='rejected'){
   exec("UPDATE working_states SET status='stale' WHERE run_id=? AND status='current'",link.run_id);
   exec("UPDATE runs SET status='stale',error='这次历史关联已被纠正，旧回答仅供回看' WHERE id=? AND status IN ('succeeded','partial')",link.run_id);
  }
  bump();return feedbackSource;
 });
}
export function relationContext(recordId:string){
 return feedbackFor(recordId).map(l=>({id:l.id,sourceId:l.source_id,targetId:l.target_id,relation:l.relation,status:l.status,scope:l.sameFragment?'当前讨论':'相似对象与任务，仅供核对，不能泛化成用户规则',note:l.note}));
}
export function recentLinks(recordId:string){
 return all<Link>("SELECT * FROM memory_links ORDER BY created_at DESC").filter(l=>root(l.source_id)===root(recordId)).slice(0,6);
}
