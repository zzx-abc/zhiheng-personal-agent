import {setWeeklyEnabled,requestWeeklyReview,retryWeeklyReview,correctWeeklyReview,deleteWeeklyReview} from '../../../server/weekly-review';
import {saveNotifications,disconnectNotifications,requestNotificationTest,retryNotification} from '../../../server/notifications';
import {correctTag,applyLinkFeedback} from '../../../server/memory-learning';
import { NextRequest,NextResponse } from 'next/server';
import { z } from 'zod';
import { mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { guard } from '../../../server/security';
import { snapshot,continueState,correctState,setTopicStatus,createTopic,addRecord,capture,enqueue,createTask,runTask,cancel,pauseTask,addMemory,correctMemory,deleteRecord,searchHistory,invalidateGenerated } from '../../../server/store';
import { dataDir,all,one,exec,id,now,bump,transaction,type Run } from '../../../server/db';
import { saveConfig } from '../../../server/config';
import {syncCards,type MemoryCard} from '../../../server/cards';
export const runtime='nodejs';
export const dynamic='force-dynamic';
function failure(e:unknown){return NextResponse.json({error:e instanceof Error?e.message:'请求失败'},{status:400});}
export async function GET(req:NextRequest){try{guard(req);const query=req.nextUrl.searchParams.get('q');return NextResponse.json(query?{results:searchHistory(query,req.nextUrl.searchParams.get('topic'))}:snapshot(),{headers:{'Cache-Control':'no-store'}});}catch(e){return failure(e);}}
const actions=z.discriminatedUnion('action',[
 z.object({action:z.literal('notification_settings'),webhook:z.string().trim().max(250).optional(),secret:z.string().trim().max(200).optional(),enabled:z.boolean()}),
 z.object({action:z.literal('notification_test')}),
 z.object({action:z.literal('notification_disconnect')}),
 z.object({action:z.literal('notification_retry'),id:z.string().uuid()}),
 z.object({action:z.literal('continue_state'),id:z.string().uuid()}),
 z.object({action:z.literal('correct_state'),id:z.string().uuid(),content:z.string().trim().min(1).max(1000)}),
 z.object({action:z.literal('weekly_settings'),enabled:z.boolean()}),
 z.object({action:z.literal('weekly_generate')}),
 z.object({action:z.literal('weekly_retry'),id:z.string().uuid()}),
 z.object({action:z.literal('weekly_correct'),id:z.string().uuid(),content:z.string().trim().min(1).max(800)}),
 z.object({action:z.literal('weekly_delete'),id:z.string().uuid()}),
 z.object({action:z.literal('tag_correct'),id:z.string().uuid(),label:z.string().trim().max(40)}),
 z.object({action:z.literal('link_feedback'),id:z.string().uuid(),decision:z.enum(['confirmed','rejected','proposed']),note:z.string().trim().max(500).default('')}),
 z.object({action:z.literal('correct_card'),id:z.string().max(180),content:z.string().trim().min(1).max(1000)}),
 z.object({action:z.literal('topic'),title:z.string().trim().min(1).max(100),question:z.string().max(2000).default('')}),
 z.object({action:z.literal('topic_edit'),id:z.string().uuid(),title:z.string().trim().min(1).max(100),question:z.string().max(2000)}),
 z.object({action:z.literal('topic_status'),id:z.string().uuid(),status:z.enum(['active','paused'])}),
 z.object({action:z.literal('task'),topicId:z.string().uuid(),title:z.string().min(1).max(100),question:z.string().min(1).max(2000)}),
 z.object({action:z.literal('run_task'),id:z.string().uuid()}),
 z.object({action:z.literal('task_status'),id:z.string().uuid(),status:z.enum(['active','paused','ended'])}),
 z.object({action:z.literal('cancel'),id:z.string().uuid()}),
 z.object({action:z.literal('retry'),id:z.string().uuid(),mode:z.literal('auto').optional()}),
 z.object({action:z.literal('memory'),content:z.string().trim().min(1).max(1000),kind:z.enum(['goal','preference','principle','view','question']),topicId:z.string().uuid().nullable()}),
 z.object({action:z.literal('correct'),id:z.string().uuid(),content:z.string().trim().min(1).max(1000)}),
 z.object({action:z.literal('memory_status'),id:z.string().uuid(),status:z.enum(['active','withdrawn'])}),
 z.object({action:z.literal('delete_record'),id:z.string().uuid()}),
 z.object({action:z.literal('delete_memory'),id:z.string().uuid()}),
 z.object({action:z.literal('settings'),engine:z.enum(['dsh','direct']).default('dsh'),apiKey:z.string().max(500).optional(),model:z.string().regex(/^[a-zA-Z0-9._-]+$/).max(100),monthlyTokens:z.number().int().min(10000).max(100000000)})
]);
export async function POST(req:NextRequest){try{guard(req);
 if(Number(req.headers.get('content-length')||0)>17*1024*1024)throw Error('上传过大，每次最多三张图片，总计 15MB');
 if(req.headers.get('content-type')?.startsWith('multipart/form-data')){
 const f=await req.formData();const text=z.string().max(20000).parse(f.get('text')||'');const replyTo=z.string().uuid().nullable().parse(f.get('replyTo')||null);const mode=z.enum(['note','auto','chat','review','check']).parse(f.get('mode'));
 const files=f.getAll('files').filter((x):x is File=>typeof x!=='string');if(files.length>3||files.some(x=>x.size>5*1024*1024)||files.reduce((n,f)=>n+f.size,0)>15*1024*1024)throw Error('每次最多三张图片，每张不超过 5MB');
 if(!text.trim()&&!files.length)throw Error('先写一句话或选择图片');
 const prepared=[];for(const file of files){const buffer=Buffer.from(await file.arrayBuffer());const png=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const jpeg=buffer[0]===255&&buffer[1]===216&&buffer[2]===255;const webp=buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';if(!png&&!jpeg&&!webp)throw Error('仅支持 PNG、JPEG、WebP 图片，不支持 SVG 或其他文件');prepared.push({file,buffer,mime:png?'image/png':jpeg?'image/jpeg':'image/webp'});}
 const recordId=capture(text.trim()||'请解释这张图片，并指出关键依据与未知信息。',replyTo,mode==='note'?'note':'message');
 mkdirSync(path.join(dataDir,'attachments'),{recursive:true,mode:0o700});
 for(const p of prepared){const key=id();const filePath=path.join(dataDir,'attachments',key);writeFileSync(filePath,p.buffer,{mode:0o600});exec('INSERT INTO attachments VALUES(?,?,?,?,?,?)',key,recordId,p.file.name.slice(0,200),p.mime,p.buffer.length,filePath);}
 const runId=mode==='note'?null:enqueue(recordId,mode);return NextResponse.json({recordId,runId});
 }
 const a=actions.parse(await req.json());let result:unknown={ok:true};
 switch(a.action){
 case 'notification_settings':saveNotifications(a);break;
 case 'notification_test':result={id:requestNotificationTest()};break;
 case 'notification_disconnect':disconnectNotifications();break;
 case 'notification_retry':retryNotification(a.id);break;
 case 'weekly_settings':setWeeklyEnabled(a.enabled);break;
 case 'weekly_generate':result=requestWeeklyReview();break;
 case 'weekly_retry':result=retryWeeklyReview(a.id);break;
 case 'weekly_correct':result=correctWeeklyReview(a.id,a.content);break;
 case 'weekly_delete':deleteWeeklyReview(a.id);break;
 case 'tag_correct':correctTag(a.id,a.label);break;
 case 'link_feedback':result={sourceId:applyLinkFeedback(a.id,a.decision,a.note)};syncCards();break;
 case 'correct_card':transaction(()=>{const card=one<MemoryCard>('SELECT * FROM memory_cards WHERE id=?',a.id);if(!card)throw Error('记忆卡片已不存在');const source=addRecord(a.content,card.topic_id,'correction');const at=now();exec('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)',id(),card.topic_id,'correction',a.content,'active',source,a.content,at,at,null);if(card.id.startsWith('memory:'))exec("UPDATE memories SET status='withdrawn',updated_at=? WHERE id=?",at,card.id.slice(7));bump();invalidateGenerated(card.topic_id);});syncCards();break;
 case 'topic':result={id:createTopic(a.title,a.question)};break;
 case 'topic_edit':transaction(()=>{if(!one('SELECT id FROM topics WHERE id=?',a.id))throw Error('关注不存在');exec('UPDATE topics SET title=?,question=?,updated_at=? WHERE id=?',a.title,a.question,now(),a.id);addRecord('纠正关注：'+a.title+'。'+a.question,a.id,'correction');bump();invalidateGenerated(a.id);});break;
 case 'topic_status':setTopicStatus(a.id,a.status);break;
 case 'continue_state':result=continueState(a.id);break;
 case 'correct_state':result=correctState(a.id,a.content);break;
 case 'task':result={id:createTask(a.topicId,a.title,a.question)};break;
 case 'run_task':result={runId:runTask(a.id)};break;
 case 'task_status':pauseTask(a.id,a.status);break;
 case 'cancel':cancel(a.id);break;
 case 'retry':{const r=one<Run>('SELECT * FROM runs WHERE id=?',a.id);if(!r||r.mode==='weekly'||['queued','running'].includes(r.status))throw Error('当前执行不可重试');result={runId:r.task_id?runTask(r.task_id):enqueue(r.record_id,a.mode||r.mode)};break;}
 case 'memory':result={id:addMemory(a.content,a.kind,a.topicId)};break;
 case 'correct':correctMemory(a.id,a.content);break;
 case 'memory_status':transaction(()=>{const m=one<{topic_id:string|null}>('SELECT topic_id FROM memories WHERE id=?',a.id);if(!m)throw Error('记忆不存在');exec('UPDATE memories SET status=?,updated_at=? WHERE id=?',a.status,now(),a.id);bump();invalidateGenerated(m.topic_id);});break;
 case 'delete_memory':{const m=one<{source_id:string}>('SELECT source_id FROM memories WHERE id=?',a.id);if(m)deleteRecord(m.source_id);break;}
 case 'delete_record':deleteRecord(a.id);break;
 case 'settings':saveConfig(a.apiKey?.trim()||undefined,a.model,a.monthlyTokens,a.engine);break;
 }
 return NextResponse.json(result);
 }catch(e){return failure(e);}}
