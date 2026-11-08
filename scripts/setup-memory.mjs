// Download public embedding weights only. Never send personal records here.
import path from 'node:path';
import {pipeline,env} from '@huggingface/transformers';
env.cacheDir=path.join(process.cwd(),'data/models');
console.log('从 Hugging Face 官方下载本地语义检索模型；仅首次需要联网。');
const extractor=await pipeline('feature-extraction','Xenova/multilingual-e5-small',{dtype:'q8',device:'cpu'});
const sample=await extractor('query: 检查本地语义检索',{pooling:'mean',normalize:true});
if(sample.dims.at(-1)!==384)throw Error('语义模型输出维度不符');
console.log('本地语义模型已就绪（384 维）；日常索引和检索不发送到远程模型。');
