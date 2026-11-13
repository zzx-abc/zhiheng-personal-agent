import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import path from 'node:path';
import {one,exec,id,now,dataDir} from '../db';
import './db';
import {MAX_BYTES,type Asset} from './types';
export function storeAsset(bytes:Buffer,mime:string){
 if(!bytes.length||bytes.length>MAX_BYTES)throw Error('文件为空或超过15MB上限');
 // Detect actual resource type: Feishu image attachments may be JPEG despite the sender label.
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
 else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
 else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')mime='image/webp';
 else if(bytes.toString('ascii',0,5)==='%PDF-')mime='application/pdf';
 if(mime==='application/pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('文件内容不是有效的PDF头');
 const allowed=['application/pdf','text/plain','text/html','image/png','image/jpeg','image/webp','application/octet-stream'];if(!allowed.includes(mime))mime='application/octet-stream';
 const hash=createHash('sha256').update(bytes).digest('hex'),prior=one<Asset>('SELECT * FROM library_assets WHERE hash=?',hash);if(prior&&existsSync(prior.path))return prior;
 const folder=path.join(dataDir,'library-assets');mkdirSync(folder,{recursive:true,mode:0o700});const target=path.join(folder,hash),temporary=target+'.'+id();
 try{writeFileSync(temporary,bytes,{mode:0o600,flag:'wx'});renameSync(temporary,target);if(prior)return prior;const key=id();exec('INSERT OR IGNORE INTO library_assets(id,hash,mime,bytes,path,created_at) VALUES(?,?,?,?,?,?)',key,hash,mime,bytes.length,target,now());return one<Asset>('SELECT * FROM library_assets WHERE hash=?',hash)!;}catch{try{unlinkSync(temporary)}catch{}throw Error('原始文件保存失败，没有创建已保存记录');}
}
