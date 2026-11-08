import {all,one,exec,event,type RecordRow} from './db';
import {syncCards,lexicalCards,type MemoryCard} from './cards';
import {embed,cosine,EMBEDDING_MODEL} from './embeddings';
export async function indexCards(batch=8){syncCards();const pending=all<MemoryCard>("SELECT * FROM memory_cards WHERE vector IS NULL AND status IN ('active','candidate','original') LIMIT ?",batch);if(!pending.length){exec("INSERT OR REPLACE INTO retrieval_status VALUES('state','ready')");return 0;}
 try{exec("INSERT OR REPLACE INTO retrieval_status VALUES('state','indexing')");const vectors=await embed(pending.map(c=>c.title+'\n'+c.body),'passage');for(let i=0;i<pending.length;i++)exec('UPDATE memory_cards SET vector=?,vector_model=? WHERE id=? AND hash=?',JSON.stringify(vectors[i]),EMBEDDING_MODEL,pending[i].id,pending[i].hash);exec("DELETE FROM retrieval_status WHERE key='error'");return pending.length;}
 catch{exec("INSERT OR REPLACE INTO retrieval_status VALUES('state','lexical_only')");exec("INSERT OR REPLACE INTO retrieval_status VALUES('error','本地语义模型未就绪，当前使用全文检索；不会假装已完成语义搜索。')");return 0;}
}
export async function retrieve(query:string,topicId:string|null,runId?:string){
 syncCards();const current=runId?one<{record_id:string}>('SELECT record_id FROM runs WHERE id=?',runId)?.record_id:null;const isOther=(c:MemoryCard)=>!current||!(JSON.parse(c.source_ids) as string[]).includes(current);const lexical=lexicalCards(query).filter(isOther);let semantic:MemoryCard[]=[];let mode='全文检索';
 const indexed=all<MemoryCard>("SELECT * FROM memory_cards WHERE vector IS NOT NULL AND vector_model=? AND status IN ('active','candidate','original')",EMBEDDING_MODEL);
 if(indexed.length){try{const [q]=await embed([query],'query');semantic=indexed.filter(isOther).map(c=>({c,score:cosine(q,JSON.parse(c.vector!))})).filter(x=>x.score>=0.72).sort((a,b)=>b.score-a.score).slice(0,24).map(x=>x.c);mode='全文 + 本地语义混合检索';}catch{/* Truthful lexical fallback, no remote provider. */}}
 const scores=new Map<string,{card:MemoryCard;score:number}>();
 for(const list of [lexical,semantic])list.forEach((c,i)=>{const x=scores.get(c.id)||{card:c,score:0};x.score+=1/(60+i+1);scores.set(c.id,x)});
 const selected=[...scores.values()].map(x=>({...x,score:x.score+(x.card.topic_id===topicId&&topicId?0.003:0)+(x.card.kind==='correction'?0.006:0)})).sort((a,b)=>b.score-a.score);
 const cards:MemoryCard[]=[];const sourceCounts=new Map<string,number>();for(const x of selected){const key=x.card.source_ids;const n=sourceCounts.get(key)||0;if(n>=2)continue;sourceCounts.set(key,n+1);cards.push(x.card);if(cards.length===6)break;}
 const sourceIds=[...new Set(cards.flatMap(c=>JSON.parse(c.source_ids) as string[]))];const records=sourceIds.flatMap(id=>{const r=one<RecordRow>("SELECT * FROM records WHERE id=? AND role='user'",id);return r?[r]:[]});
 if(runId)event(runId,'memory_retrieved',{method:mode,cards:cards.map(c=>({id:c.id,kind:c.kind,sourceIds:JSON.parse(c.source_ids)})),selected:cards.length,contextCharacters:cards.reduce((n,c)=>n+c.body.length,0)});
 return {mode,cards:cards.map(({vector,vector_model,hash,...c})=>c),records};
}
