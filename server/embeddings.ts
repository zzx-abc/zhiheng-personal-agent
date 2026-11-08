import path from 'node:path';
export const EMBEDDING_MODEL='Xenova/multilingual-e5-small';
let extractor:Promise<any>|undefined;
async function load(){if(!extractor)extractor=(async()=>{const {pipeline,env}=await import('@huggingface/transformers');env.cacheDir=path.join(process.cwd(),'data/models');env.allowRemoteModels=false;return pipeline('feature-extraction',EMBEDDING_MODEL,{dtype:'q8',device:'cpu'});})().catch(e=>{extractor=undefined;throw e});return extractor;}
export async function embed(texts:string[],kind:'query'|'passage'){const pipe=await load();const output=await pipe(texts.map(t=>kind+': '+t),{pooling:'mean',normalize:true,truncation:true,max_length:512});return output.tolist() as number[][];}
export function cosine(a:number[],b:number[]){if(a.length!==b.length)return -1;return a.reduce((n,x,i)=>n+x*b[i],0);}
