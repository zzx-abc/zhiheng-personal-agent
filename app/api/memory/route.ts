import {NextRequest,NextResponse} from 'next/server';
import {guard} from '../../../server/security';
import {retrieve} from '../../../server/retrieval';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:NextRequest){try{guard(req);const query=req.nextUrl.searchParams.get('q')?.slice(0,500)||'';if(!query.trim())return NextResponse.json({cards:[],mode:'未搜索'});const result=await retrieve(query,req.nextUrl.searchParams.get('topic'));return NextResponse.json({cards:result.cards,mode:result.mode},{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'暂时未能检索，请稍后再试。'},{status:500})}}
