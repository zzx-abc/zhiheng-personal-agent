import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {guard} from '../../../server/security';
import {observationConfigSchema,industryUniverse} from '../../../server/observation/types';
import {createObservation,changeObservation,setObservationStatus,requestObservationCheck,observationSummary,observationDetail,replayObservation} from '../../../server/observation/service';
import {storedFrame} from '../../../server/observation/provider';
export const runtime='nodejs';export const dynamic='force-dynamic';
const time=z.string().datetime({offset:true});
const actions=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),config:observationConfigSchema}),
 z.object({action:z.literal('configure'),id:z.string().uuid(),config:observationConfigSchema}),
 z.object({action:z.literal('status'),id:z.string().uuid(),operation:z.enum(['activate','pause','resume','end'])}),
 z.object({action:z.literal('check'),id:z.string().uuid()}),
 z.object({action:z.literal('replay'),id:z.string().uuid(),start:time,end:time})
]);
export async function GET(req:NextRequest){try{guard(req);const task=req.nextUrl.searchParams.get('task'),frame=req.nextUrl.searchParams.get('frame');return NextResponse.json(frame?storedFrame(z.string().regex(/^[a-f0-9]{64}$/).parse(frame)):task?observationDetail(z.string().uuid().parse(task)):{tasks:observationSummary(),industries:industryUniverse,defaults:observationConfigSchema.parse({})},{headers:{'Cache-Control':'no-store'}});}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'读取失败'},{status:400});}}
export async function POST(req:NextRequest){try{guard(req);if(Number(req.headers.get('content-length')||0)>20000)throw Error('配置过大');const a=actions.parse(await req.json());let result:unknown={ok:true};switch(a.action){case 'create':result={id:createObservation(a.config)};break;case 'configure':changeObservation(a.id,a.config);break;case 'status':setObservationStatus(a.id,a.operation);break;case 'check':result={runId:requestObservationCheck(a.id)};break;case 'replay':if(a.start>a.end)throw Error('回放起点不能晚于终点');result=replayObservation(a.id,a.start,a.end);break;}return NextResponse.json(result);}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'操作失败'},{status:400});}}
