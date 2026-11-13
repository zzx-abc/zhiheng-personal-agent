import { NextRequest,NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { guard } from '../../../server/security';
import { all,now } from '../../../server/db';
import '../../../server/cards';
import '../../../server/notifications';
import '../../../server/observation/db';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:NextRequest){try{guard(req);const data:Record<string,unknown>={format:'zhiheng-export-v5',exportedAt:now(),note:'包含原文、个人记忆、任务、报告和图片。无 API Key、Webhook 或签名密钥。请妥善保管。'};for(const t of ['observation_templates','observation_tasks','observation_configs','observation_frames','observation_checks','observation_candidates','observation_signals','observation_actions','notification_settings','notification_outbox','weekly_schedule','weekly_reviews','weekly_versions','weekly_sources','weekly_feedback','record_tags','tag_feedback','memory_links','link_feedback','record_context','memory_cards','working_states','topics','records','memories','tasks','runs','reports','evidence','events'])data[t]=all(`SELECT * FROM ${t}`);data.attachments=all<{id:string;record_id:string;name:string;mime:string;path:string}>('SELECT * FROM attachments').map(a=>({id:a.id,record_id:a.record_id,name:a.name,mime:a.mime,base64:readFileSync(a.path).toString('base64')}));return new NextResponse(JSON.stringify(data,null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="zhiheng-${new Date().toISOString().slice(0,10)}.json"`,'Cache-Control':'no-store'}});}catch{return new NextResponse(null,{status:403});}}
