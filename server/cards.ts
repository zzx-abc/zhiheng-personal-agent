import {ensureRuleTags,tagsFor} from './memory-learning';
import {createHash} from 'node:crypto';
import {db,all,one,exec,transaction,now,type RecordRow,type Memory} from './db';
import {stateSourceIds,type WorkingState,type StateVersion} from './working-state';
export type MemoryCard={id:string;topic_id:string|null;kind:string;title:string;body:string;origin:string;status:string;source_ids:string;created_at:string;updated_at:string;parent_id:string|null;vector:string|null;vector_model:string|null;hash:string};
db.exec(`CREATE TABLE IF NOT EXISTS memory_cards(id TEXT PRIMARY KEY,topic_id TEXT,kind TEXT,title TEXT,body TEXT,origin TEXT,status TEXT,source_ids TEXT,created_at TEXT,updated_at TEXT,parent_id TEXT,vector TEXT,vector_model TEXT,hash TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_cards_fts USING fts5(card_id UNINDEXED,terms,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS retrieval_status(key TEXT PRIMARY KEY,value TEXT);`);
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
export function terms(text:string){
 const words=[...segmenter.segment(text)].filter(s=>s.isWordLike).map(s=>s.segment.toLowerCase());
 const pairs=(text.match(/[\u4e00-\u9fff]+/g)||[]).flatMap(word=>Array.from({length:Math.max(0,word.length-1)},(_,i)=>word.slice(i,i+2)));
 return [...new Set([...words,...pairs])].filter(x=>x.length>1).join(' ');
}
export function syncCards(){
 const live=new Set<string>();
 const withdrawnSources=new Set(all<{source_id:string}>("SELECT source_id FROM memories WHERE status='withdrawn'").map(x=>x.source_id));
 function put(card:Omit<MemoryCard,'vector'|'vector_model'|'hash'|'updated_at'>){
  live.add(card.id);const hash=createHash('sha256').update(['zh-bigrams-v2',card.title,card.body,card.status,card.source_ids].join('|')).digest('hex');const old=one<MemoryCard>('SELECT * FROM memory_cards WHERE id=?',card.id);
  if(old?.hash===hash&&old.status===card.status)return;
  exec('INSERT OR REPLACE INTO memory_cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',card.id,card.topic_id,card.kind,card.title,card.body,card.origin,card.status,card.source_ids,card.created_at,now(),card.parent_id,null,null,hash);
  exec('DELETE FROM memory_cards_fts WHERE card_id=?',card.id);
  if(['active','candidate','original'].includes(card.status))exec('INSERT INTO memory_cards_fts VALUES(?,?)',card.id,terms(card.title+' '+card.body));
 }
 transaction(()=>{
  for(const r of all<RecordRow>("SELECT * FROM records WHERE role='user'")){
   if(['relation_feedback','tag_feedback'].includes(r.kind))continue;
   ensureRuleTags(r);
   for(let i=0;i<r.content.length;i+=420){const body=r.content.slice(i,i+500);put({id:`raw:${r.id}:${i}`,topic_id:r.topic_id,kind:r.kind==='correction'?'correction':'record',title:r.content.replace(/\s+/g,' ').slice(0,32),body,origin:'original',status:withdrawnSources.has(r.id)?'historical':'original',source_ids:JSON.stringify([r.id]),created_at:r.created_at,parent_id:r.topic_id});}
  }
  for(const m of all<Memory>('SELECT * FROM memories'))put({id:'memory:'+m.id,topic_id:m.topic_id,kind:m.kind,title:m.kind==='principle'?(m.status==='active'?'你认可的原则':'待认可的原则'):m.kind==='correction'?'修正后的理解':'个人背景',body:m.content,origin:m.status==='active'?'confirmed':'model',status:m.status==='withdrawn'?'withdrawn':m.status,source_ids:JSON.stringify([m.source_id]),created_at:m.updated_at,parent_id:m.topic_id});
  for(const row of all<StateVersion>('SELECT * FROM working_states')){
   const state=JSON.parse(row.content) as WorkingState;const status=row.status==='current'?'active':'historical';const sources=stateSourceIds(state);const base={topic_id:row.topic_id,status,source_ids:JSON.stringify(sources),created_at:row.created_at,parent_id:row.topic_id};
   put({...base,id:'state:'+row.id,kind:'judgment',title:state.thesis.text.slice(0,40),body:state.assessment,origin:'model'});
   for(const [key,label] of [['original_basis','原来的依据'],['evaluation_horizon','验证的时间线'],['contemplated_change','考虑中的调整'],['change_trigger','触发变化的情况']] as const){const q=state.decision_frame?.[key];if(q)put({...base,id:`frame:${row.id}:${key}`,kind:key,title:label,body:q.quote,origin:'original',source_ids:JSON.stringify([q.source_id])});}
   for(const [i,question] of state.open_questions.entries())put({...base,id:`question:${row.id}:${i}`,kind:'question',title:'还没有解决',body:question,origin:'model'});
   if(row.previous_id)put({...base,id:'change:'+row.id,kind:'change',title:'判断有了变化',body:state.change_summary,origin:'model'});
  }
  for(const card of all<{id:string}>('SELECT id FROM memory_cards'))if(!live.has(card.id)){exec('DELETE FROM memory_cards WHERE id=?',card.id);exec('DELETE FROM memory_cards_fts WHERE card_id=?',card.id);}
 });
}
export function cardSnapshot(){syncCards();return all<MemoryCard>('SELECT * FROM memory_cards ORDER BY created_at DESC').map(({vector,vector_model,hash,...c})=>({...c,sourceIds:JSON.parse(c.source_ids),indexed:!!vector,tags:tagsFor(JSON.parse(c.source_ids))}));}
export function retrievalStatus(){return {cards:one<{n:number}>('SELECT count(*) n FROM memory_cards')?.n||0,indexed:one<{n:number}>("SELECT count(*) n FROM memory_cards WHERE vector IS NOT NULL AND status IN ('active','candidate','original')")?.n||0,state:one<{value:string}>("SELECT value FROM retrieval_status WHERE key='state'")?.value||'pending',error:one<{value:string}>("SELECT value FROM retrieval_status WHERE key='error'")?.value||null};}
export function lexicalCards(query:string){const q=terms(query).split(' ').filter(Boolean).slice(0,24).map(x=>'"'+x.replaceAll('"','""')+'"').join(' OR ');return q?all<MemoryCard>("SELECT c.* FROM memory_cards_fts f JOIN memory_cards c ON c.id=f.card_id WHERE memory_cards_fts MATCH ? AND c.status IN ('active','candidate','original') ORDER BY bm25(memory_cards_fts) LIMIT 24",q):[];}
