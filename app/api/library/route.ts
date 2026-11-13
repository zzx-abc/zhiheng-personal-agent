import {NextRequest,NextResponse} from 'next/server';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {guard} from '../../../server/security';
import {one} from '../../../server/db';
import '../../../server/notifications';
import {ingest,listEntries,detail,chunks,search,annotate,deleteEntry,removeAnnotation,setRetention,retry,linkDecision,taskDraft,entry} from '../../../server/library/service';
import {answerRecords} from '../../../server/library/answers';
import {connectionStatus,saveConnection} from '../../../server/feishu/config';
import {stanceSchema,MAX_BYTES,type Asset} from '../../../server/library/types';
export const runtime='nodejs';export const dynamic='force-dynamic';
const key=z.string().uuid();
const action=z.discriminatedUnion('action',[
 z.object({action:z.literal('annotate'),id:key,text:z.string().max(10000),kind:z.enum(['note','correction']),stance:stanceSchema.default('unexpressed'),target:z.string().nullable().default(null)}),
 z.object({action:z.literal('delete'),id:key,version:z.number().int(),confirmed:z.literal(true)}),
 z.object({action:z.literal('remove_annotation'),id:key,annotationId:key,confirmed:z.literal(true)}),
 z.object({action:z.literal('collect'),id:key}),z.object({action:z.literal('retry'),id:key}),
 z.object({action:z.literal('link'),id:key,linkId:z.string(),status:z.enum(['confirmed','rejected'])}),
 z.object({action:z.literal('task_draft'),id:key,question:z.string().max(1000)}),
 z.object({action:z.literal('answer'),question:z.string().max(2000),ids:z.array(key).max(3)}),
 z.object({action:z.literal('feishu_config'),config:z.unknown()})
]);
export async function GET(req:NextRequest){try{guard(req);const params=req.nextUrl.searchParams,id=params.get('id'),q=params.get('q');if(id){key.parse(id);if(params.get('original')==='1'){const e=entry(id);if(!e.asset_id)throw Error('仅保存了链接，尚无原始文件');const asset=one<Asset>('SELECT * FROM library_assets WHERE id=?',e.asset_id)!;return new NextResponse(readFileSync(asset.path),{headers:{'Content-Type':asset.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(e.title.replace(/[\r\n]/g,''))}`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});}return NextResponse.json({...detail(id),chunks:chunks(id)},{headers:{'Cache-Control':'no-store'}});}if(q)return NextResponse.json(await search(q.slice(0,1000),{kind:params.get('kind')||undefined,from:params.get('from')||undefined,to:params.get('to')||undefined}));return NextResponse.json({entries:listEntries(z.enum(['library','pending','session']).parse(params.get('retention')||'library')),feishu:connectionStatus()},{headers:{'Cache-Control':'no-store'}});}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'读取失败'},{status:400});}}
export async function POST(req:NextRequest){try{guard(req);if(Number(req.headers.get('content-length')||0)>MAX_BYTES*5+100000)throw Error('上传超过限制');
 if(req.headers.get('content-type')?.startsWith('multipart/form-data')){const f=await req.formData(),text=z.string().max(200000).parse(f.get('text')||''),instruction=z.string().max(20000).parse(f.get('instruction')||''),url=z.string().max(4000).parse(f.get('url')||''),eventKey=key.parse(f.get('eventKey'));const mode=z.enum(['collect','note','analyze','pending']).parse(f.get('intent')||'collect');const files=f.getAll('files').filter((x):x is File=>typeof x!=='string');if(files.length>5||files.some(x=>x.size>MAX_BYTES))throw Error('最多5个附件，每个15MB');const prepared=[];for(const x of files)prepared.push({name:x.name,mime:x.type||'application/octet-stream',bytes:Buffer.from(await x.arrayBuffer())});return NextResponse.json(ingest({text,url:url||undefined,instruction,intent:mode,files:prepared,eventKey}));}
 if(Number(req.headers.get('content-length')||0)>100000)throw Error('请求过长');const a=action.parse(await req.json());let result:unknown={ok:true};switch(a.action){case 'annotate':result=annotate(a.id,a.text,a.kind,a.stance,a.target);break;case 'delete':result=deleteEntry(a.id,a.version);break;case 'remove_annotation':result=removeAnnotation(a.id,a.annotationId);break;case 'collect':setRetention(a.id);break;case 'retry':result={runId:retry(a.id)};break;case 'link':linkDecision(a.id,a.linkId,a.status);break;case 'task_draft':result=taskDraft(a.id,a.question);break;case 'answer':result=await answerRecords(a.question,a.ids);break;case 'feishu_config':result=saveConnection(a.config);break;}return NextResponse.json(result);}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'未完成，原文不会被替代'},{status:400});}}
