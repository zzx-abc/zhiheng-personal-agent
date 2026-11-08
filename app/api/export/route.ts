import { NextRequest,NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { guard } from '../../../server/security';
import { all,now } from '../../../server/db';
import '../../../server/cards';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:NextRequest){try{guard(req);const data:Record<string,unknown>={format:'zhiheng-export-v2',exportedAt:now(),note:'包含原文、个人记忆、任务、报告和图片。无 API Key。请妥善保管。'};for(const t of ['memory_cards','working_states','topics','records','memories','tasks','runs','reports','evidence','events'])data[t]=all(`SELECT * FROM ${t}`);data.attachments=all<{id:string;record_id:string;name:string;mime:string;path:string}>('SELECT * FROM attachments').map(a=>({id:a.id,record_id:a.record_id,name:a.name,mime:a.mime,base64:readFileSync(a.path).toString('base64')}));return new NextResponse(JSON.stringify(data,null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="zhiheng-${new Date().toISOString().slice(0,10)}.json"`,'Cache-Control':'no-store'}});}catch{return new NextResponse(null,{status:403});}}
