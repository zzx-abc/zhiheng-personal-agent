import {tagsFor,tagMatches,blockedSources,feedbackWeight} from './memory-learning';
import {all,one,exec,event,type RecordRow} from './db';
import {syncCards,lexicalCards,type MemoryCard} from './cards';
import {embed,cosine,EMBEDDING_MODEL} from './embeddings';
export async function indexCards(batch=8){syncCards();const pending=all<MemoryCard>("SELECT * FROM memory_cards WHERE vector IS NULL AND status IN ('active','candidate','original') LIMIT ?",batch);if(!pending.length){exec("INSERT OR REPLACE INTO retrieval_status VALUES('state','ready')");return 0;}
 try{exec("INSERT OR REPLACE INTO retrieval_status VALUES('state','indexing')");const vectors=await embed(pending.map(c=>c.title+'\n'+c.body),'passage');for(let i=0;i<pending.length;i++)exec('UPDATE memory_cards SET vector=?,vector_model=? WHERE id=? AND hash=?',JSON.stringify(vectors[i]),EMBEDDING_MODEL,pending[i].id,pending[i].hash);exec("DELETE FROM retrieval_status WHERE key='error'");return pending.length;}
 catch{exec("INSERT OR REPLACE INTO retrieval_status VALUES('state','lexical_only')");exec("INSERT OR REPLACE INTO retrieval_status VALUES('error','本地语义模型未就绪，当前使用全文检索；不会假装已完成语义搜索。')");return 0;}
}
export async function retrieve(query:string,topicId:string|null,runId?:string){
 syncCards();const current=runId?one<{record_id:string}>('SELECT record_id FROM runs WHERE id=?',runId)?.record_id:null;const denied=current?blockedSources(current):new Set<string>();const isOther=(c:MemoryCard)=>{const ids=JSON.parse(c.source_ids) as string[];return (!current||!ids.includes(current))&&!ids.some(id=>denied.has(id))};const lexical=lexicalCards(query).filter(isOther);let semantic:MemoryCard[]=[];let mode='全文检索';
 const indexed=all<MemoryCard>("SELECT * FROM memory_cards WHERE vector IS NOT NULL AND vector_model=? AND status IN ('active','candidate','original')",EMBEDDING_MODEL);
 if(indexed.length){try{const [q]=await embed([query],'query');semantic=indexed.filter(isOther).map(c=>({c,score:cosine(q,JSON.parse(c.vector!))})).filter(x=>x.score>=0.72).sort((a,b)=>b.score-a.score).slice(0,24).map(x=>x.c);mode='全文 + 本地语义混合检索';}catch{/* Truthful lexical fallback, no remote provider. */}}
 const scores=new Map<string,{card:MemoryCard;score:number}>();
 const tagScores=tagMatches(query,current||undefined);
 const tagged=all<MemoryCard>("SELECT * FROM memory_cards WHERE status IN ('active','candidate','original')").filter(isOther).map(c=>({c,score:Math.max(0,...(JSON.parse(c.source_ids) as string[]).map(id=>tagScores.get(id)||0))})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,24).map(x=>x.c);
 if(tagged.length)mode+=' + 来源标签';
 for(const list of [lexical,semantic,tagged])list.forEach((c,i)=>{const x=scores.get(c.id)||{card:c,score:0};x.score+=(list===tagged ? 0.6 : 1)/(60+i+1);scores.set(c.id,x)});
 const selected=[...scores.values()].map(x=>({...x,score:(x.score+(x.card.kind==='correction'?0.003:0))*(current?Math.min(...(JSON.parse(x.card.source_ids) as string[]).map(id=>feedbackWeight(current,id)),1.15):1)})).sort((a,b)=>b.score-a.score);
 const cards:MemoryCard[]=[];const sourceCounts=new Map<string,number>();for(const x of selected){const ids=JSON.parse(x.card.source_ids) as string[];if(ids.some(id=>sourceCounts.has(id)))continue;ids.forEach(id=>sourceCounts.set(id,1));cards.push(x.card);if(cards.length===6)break;}
 const sourceIds=[...new Set(cards.flatMap(c=>JSON.parse(c.source_ids) as string[]))];const records=sourceIds.flatMap(id=>{const r=one<RecordRow>("SELECT * FROM records WHERE id=? AND role='user'",id);return r?[r]:[]});
 if(runId)event(runId,'memory_retrieved',{method:mode,cards:cards.map(c=>({id:c.id,kind:c.kind,sourceIds:JSON.parse(c.source_ids)})),selected:cards.length,contextCharacters:cards.reduce((n,c)=>n+c.body.length,0)});
 return {mode,cards:cards.map(({vector,vector_model,hash,...c})=>({...c,tags:tagsFor(JSON.parse(c.source_ids))})),records};
}
