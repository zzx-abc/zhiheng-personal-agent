import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,rmSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {dataDir} from '../db';

export const OCR_ENGINE='apple-vision/1';
const line=z.object({text:z.string().max(2000),confidence:z.number().min(0).max(1),box:z.array(z.number().finite()).length(4)});
const pageSchema=z.object({page:z.number().int().positive(),lines:z.array(line).max(2000),truncated:z.boolean().default(false)});
export type OcrPage=z.infer<typeof pageSchema>;
export type OcrResult={pages:OcrPage[];error?:string};
let building:Promise<string>|undefined;
function subprocess(command:string,args:string[],timeout:number,onLine:(line:string)=>void,signal?:AbortSignal){
 return new Promise<void>((resolve,reject)=>{
  signal?.throwIfAborted();
  const child=spawn(command,args,{detached:process.platform!=='win32',stdio:['ignore','pipe','ignore'],env:{NODE_ENV:'production',PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:process.env.HOME}});
  child.stdout.setEncoding('utf8');
  let buffer='',size=0,reason='';
  const stop=(message:string)=>{reason=message;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL')}catch{}};
  const abort=()=>stop('识别已取消');signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>stop('本轮识别超时，已完成页保留；可继续处理'),timeout);
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)};
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024){stop('识别输出超过限制');return;}buffer+=chunk.toString();let n;while((n=buffer.indexOf('\n'))>=0){const value=buffer.slice(0,n);buffer=buffer.slice(n+1);onLine(value)}});
  child.on('error',()=>{cleanup();reject(Error('本地OCR无法启动，请检查macOS命令行开发工具'))});
  child.on('close',code=>{cleanup();if(reason||code!==0)reject(Error(reason||'本地OCR处理失败'));else resolve()});
 });
}
export async function ensureOcr(){
 if(process.platform!=='darwin')throw Error('当前本地OCR需要macOS；原件已保存，可上传文字版资料');
 if(building)return building;
 building=(async()=>{const source=path.join(process.cwd(),'scripts/library/ocr.m'),hash=createHash('sha256').update(readFileSync(source)).digest('hex').slice(0,16);
  const folder=path.join(dataDir,'runtime');mkdirSync(folder,{recursive:true,mode:0o700});const binary=path.join(folder,'ocr-'+process.arch+'-'+hash);
  if(!existsSync(binary)){const temporary=binary+'.'+process.pid;try{await subprocess('/usr/bin/xcrun',['clang','-O2','-fobjc-arc',source,'-framework','Foundation','-framework','Vision','-framework','ImageIO','-framework','PDFKit','-framework','AppKit','-o',temporary],120000,()=>{});renameSync(temporary,binary)}finally{rmSync(temporary,{force:true})}}
  return binary;
 })();try{return await building}finally{building=undefined}
}
export async function recognizeAsset(file:string,pages:number[]|null,signal?:AbortSignal):Promise<OcrResult>{
 const result:OcrResult={pages:[]};
 try{signal?.throwIfAborted();const binary=await ensureOcr();signal?.throwIfAborted();const wanted=new Set(pages??[1]);
  await subprocess(binary,[file,pages?'pdf':'image',(pages??[1]).slice(0,10).join(',')],90000,value=>{try{const raw=JSON.parse(value);const parsed=pageSchema.safeParse(raw);if(parsed.success&&wanted.has(parsed.data.page)&&!result.pages.some(p=>p.page===parsed.data.page))result.pages.push(parsed.data);else if(raw.error)result.error='部分页面或图片无法识别，请对照原件'}catch{result.error='识别输出不完整，请重试'}},signal);
 }catch(e){if(signal?.aborted)throw e;result.error=e instanceof Error?e.message:'本地OCR未完成'}
 return result;
}
