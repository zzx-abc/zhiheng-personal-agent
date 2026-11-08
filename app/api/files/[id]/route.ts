import { NextRequest,NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { guard } from '../../../../server/security';
import { one } from '../../../../server/db';
export const runtime='nodejs';
export async function GET(req:NextRequest,{params}:{params:Promise<{id:string}>}){try{guard(req);const {id}=await params;const a=one<{path:string;mime:string}>('SELECT path,mime FROM attachments WHERE id=?',id);if(!a)return new NextResponse(null,{status:404});return new NextResponse(readFileSync(a.path),{headers:{'Content-Type':a.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});}catch{return new NextResponse(null,{status:403});}}
