import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {all,exec,id,transaction} from '../db';
import {htmlText} from './web';
import type {Asset,Chunk} from './types';
export function splitText(text:string,size=3500){const out:string[]=[];for(let i=0;i<text.length;i+=size)out.push(text.slice(i,i+size));return out;}
export async function pdfText(bytes:Buffer):Promise<{pages:{page:number;text:string}[];totalPages:number;unreadPages:number[];notice:string}>{return await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--max-old-space-size=256',path.join(process.cwd(),'scripts/library/parse-pdf.mjs')],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH,NODE_ENV:'production'}});const timer=setTimeout(()=>child.kill('SIGKILL'),30000);let result='';child.stdout.on('data',x=>{result+=x;if(result.length>2000000)child.kill('SIGKILL')});child.on('error',()=>{clearTimeout(timer);reject(Error('PDF解析进程无法启动'))});child.on('close',()=>{clearTimeout(timer);try{const parsed=JSON.parse(result.split('\nZH_RESULT\n').at(-1)!);if(parsed.error)throw Error(parsed.error);resolve(parsed)}catch{reject(Error('PDF解析失败或超过30秒限制，原文已保留'))}});child.stdin.on('error',()=>{});child.stdin.end(bytes);});}
export async function parseAsset(asset:Asset,url=''){
 if(['ready','partial','unsupported'].includes(asset.parse_state))return {chunks:all<Chunk>('SELECT * FROM library_chunks WHERE asset_id=? ORDER BY ordinal',asset.id),state:asset.parse_state,info:JSON.parse(asset.parse_info)};
 const bytes=readFileSync(asset.path);let pieces:{body:string;locator:string}[]=[],info:Record<string,unknown>={},state='ready';
 if(asset.mime==='application/pdf'){const pdf=await pdfText(bytes);for(const p of pdf.pages)for(const [part,body] of splitText(p.text).entries())pieces.push({body,locator:`PDF物理页${p.page} · 片段${part+1}`});info=pdf;delete info.pages;if(pdf.unreadPages.length)state='partial';if(!pieces.length)state='unsupported';}
 else if(asset.mime==='text/html'){const html=htmlText(bytes.toString('utf8'),url);html.paragraphs.forEach((p,i)=>splitText(p).forEach((body,j)=>pieces.push({body,locator:`网页正文段落${i+1} · 片段${j+1}`})));info={title:html.title,author:html.author,notice:html.notice};}
 else if(asset.mime==='text/plain'){pieces=splitText(bytes.toString('utf8')).map((body,i)=>({body,locator:`原始文字片段${i+1}`}));}
 else{state='unsupported';info={notice:'原始附件已保存，此格式尚未解析；不声称理解其内容'};}
 transaction(()=>{exec('DELETE FROM library_chunks WHERE asset_id=?',asset.id);pieces.forEach((p,i)=>exec('INSERT INTO library_chunks VALUES(?,?,?,?,?)',id(),asset.id,i,p.locator,p.body));exec('UPDATE library_assets SET parse_state=?,parse_info=? WHERE id=?',state,JSON.stringify(info),asset.id)});
 return {chunks:all<Chunk>('SELECT * FROM library_chunks WHERE asset_id=? ORDER BY ordinal',asset.id),state,info};
}
