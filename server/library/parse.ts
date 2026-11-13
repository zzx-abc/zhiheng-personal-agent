import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {all,one,exec,id,transaction} from '../db';
import {recognizeAsset,OCR_ENGINE} from './ocr';
import {htmlText} from './web';
import type {Asset,Chunk} from './types';
export function splitText(text:string,size=3500){const out:string[]=[];for(let i=0;i<text.length;i+=size)out.push(text.slice(i,i+size));return out;}
export async function pdfText(bytes:Buffer,signal?:AbortSignal):Promise<{pages:{page:number;text:string}[];totalPages:number;unreadPages:number[];notice:string}>{
 return await new Promise((resolve,reject)=>{
  signal?.throwIfAborted();
  const child=spawn(process.execPath,['--max-old-space-size=256',path.join(process.cwd(),'scripts/library/parse-pdf.mjs')],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH,NODE_ENV:'production'}});
  const abort=()=>child.kill('SIGKILL');signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,30000),cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)};
  let result='';child.stdout.setEncoding('utf8');child.stdout.on('data',x=>{result+=x;if(result.length>2000000)abort()});
  child.on('error',()=>{cleanup();reject(Error('PDF解析进程无法启动'))});
  child.on('close',()=>{cleanup();try{signal?.throwIfAborted();const parsed=JSON.parse(result.split('\nZH_RESULT\n').at(-1)!);if(parsed.error)throw Error(parsed.error);resolve(parsed)}catch{reject(Error('PDF解析失败、已取消或超过30秒限制，原文已保留'))}});
  child.stdin.on('error',()=>{});child.stdin.end(bytes);
 });
}
export async function parseAsset(asset:Asset,url='',signal?:AbortSignal){
 signal?.throwIfAborted();
 // Re-read after earlier jobs; shared assets must retain their existing citation IDs.
 asset=one<Asset>('SELECT * FROM library_assets WHERE id=?',asset.id)!;
 if(!asset)throw Error('原件已删除');
 const existing=all<Chunk>('SELECT * FROM library_chunks WHERE asset_id=? ORDER BY ordinal',asset.id);
 let info:Record<string,any>=JSON.parse(asset.parse_info),pieces:{body:string;locator:string}[]=[],state='ready';
 const pdf=asset.mime==='application/pdf',image=asset.mime.startsWith('image/');
 const cached=['ready','partial','unsupported'].includes(asset.parse_state);
 const canOcr=pdf||image;
 const needsOcr=canOcr&&(!info.ocrEngine||(info.ocrRemainingPages?.length||0)>0||!!info.ocrError);
 if(cached&&!needsOcr)return {chunks:existing,state:asset.parse_state,info};
 if(!cached){
  const bytes=readFileSync(asset.path);
  if(pdf){const parsed=await pdfText(bytes,signal);for(const p of parsed.pages)for(const [part,body] of splitText(p.text).entries())pieces.push({body,locator:`PDF物理页${p.page} · 片段${part+1}`});const {pages,...metadata}=parsed;info=metadata;}
  else if(asset.mime==='text/html'){const html=htmlText(bytes.toString('utf8'),url);html.paragraphs.forEach((p,i)=>splitText(p).forEach((body,j)=>pieces.push({body,locator:`网页正文段落${i+1} · 片段${j+1}`})));info={title:html.title,author:html.author,notice:html.notice};}
  else if(asset.mime==='text/plain'){pieces=splitText(bytes.toString('utf8')).map((body,i)=>({body,locator:`原始文字片段${i+1}`}));}
  else if(!image){state='unsupported';info={notice:'原始附件已保存，此格式尚未解析；不声称理解其内容'};}
 }
 if(canOcr){
  const attempted=new Set<number>(info.ocrAttemptedPages||[]),unread:number[]=pdf?(info.unreadPages||[]):existing.length?[]:[1];
  const remaining:number[]=info.ocrRemainingPages||unread.filter(n=>!attempted.has(n));
  if(remaining.length){
   const result=await recognizeAsset(asset.path,pdf?remaining.slice(0,10):null,signal);
   info.ocrError=result.error||null;info.ocrPages=info.ocrPages||[];
   for(const page of result.pages){
    attempted.add(page.page);const fullText=page.lines.map(l=>l.text).join('\n'),text=fullText.slice(0,50000).trim();if(page.truncated||fullText.length>50000)info.ocrTruncatedPages=[...(info.ocrTruncatedPages||[]),page.page];
    info.ocrPages.push({page:page.page,characters:text.length,lowConfidenceLines:page.lines.filter(l=>l.confidence<0.7).length,meanConfidence:page.lines.length?page.lines.reduce((n,l)=>n+l.confidence,0)/page.lines.length:null});
    if(text){for(const [i,body] of splitText(text).entries())pieces.push({body,locator:`${pdf?'PDF物理页'+page.page:'图片'} · OCR转写 · 片段${i+1}`});const at=unread.indexOf(page.page);if(at>=0)unread.splice(at,1);}
   }
  }
  info.ocrEngine=OCR_ENGINE;info.ocrAttemptedPages=[...attempted];info.ocrRemainingPages=remaining.filter(n=>!attempted.has(n));
  if(pdf)info.unreadPages=unread;
  info.notice=(pdf&&!info.ocrAttemptedPages.length&&!info.ocrRemainingPages.length?'已读取PDF文字层，未调用OCR；物理页码从1开始，表格与图表含义仍需对照原件。':'图片与扫描页使用本机OCR转写，文字不等于核实事实；数字、表格和图表含义需对照原件。PDF每轮最多识别10个缺文字页，已识别内容不会反复处理。')+(info.ocrError?' '+info.ocrError:'')+(info.ocrTruncatedPages?.length?' 部分页文字超过上限，转写不完整，请拆分或对照原件。':'');
  state=(info.unreadPages?.length||info.ocrRemainingPages.length||info.ocrError||info.ocrTruncatedPages?.length)?'partial':'ready';
  if(!existing.length&&!pieces.length)state='unsupported';
 }
 signal?.throwIfAborted();
 transaction(()=>{
  if(!one('SELECT id FROM library_assets WHERE id=?',asset.id))throw Error('原件已删除');
  // Append only: earlier citations, shared entries and extraction caches stay valid.
  const ordinal=one<{n:number}>('SELECT COALESCE(MAX(ordinal),-1)+1 n FROM library_chunks WHERE asset_id=?',asset.id)!.n;
  let next=ordinal;for(const piece of pieces){if(!one('SELECT id FROM library_chunks WHERE asset_id=? AND locator=?',asset.id,piece.locator))exec('INSERT INTO library_chunks VALUES(?,?,?,?,?)',id(),asset.id,next++,piece.locator,piece.body);}
  exec('UPDATE library_assets SET parse_state=?,parse_info=? WHERE id=?',state,JSON.stringify(info),asset.id);
 });
 return {chunks:all<Chunk>('SELECT * FROM library_chunks WHERE asset_id=? ORDER BY ordinal',asset.id),state,info};
}
