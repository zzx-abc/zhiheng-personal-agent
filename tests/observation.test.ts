import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import * as XLSX from 'xlsx';
import {observationConfigSchema,type Frame,type DataPoint,type Group,type Candidate} from '../server/observation/types';
import {previousSessions,tradingDay,marketPhase,nextObservation} from '../server/observation/calendar';
import {computeMetric,detect} from '../server/observation/detectors';
process.env.AGENT_TEST_MODE='1';process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-observation-'));
const sql=await import('../server/db'),service=await import('../server/observation/service'),provider=await import('../server/observation/provider'),notifications=await import('../server/notifications'),conversation=await import('../server/observation/conversation');
const config=()=>observationConfigSchema.parse({frequencyMinutes:30,scope:{sampleSize:4,include:['000928']}});
function fixture(at='2026-11-13T02:00:00.000Z',multiplier=1.01):Frame{
 const date=at.slice(0,10),dates=previousSessions(date,26),symbols=['sz000001','sz000002','sh600001','sh600002'];
 const group:Group={id:'000928',name:'测试行业',kind:'industry',source:'https://oss-ch.csindex.com.cn/test.xls',sourceDate:'2026-11-01',knownAt:'2026-11-12T01:00:00.000Z',mappingVersion:'synthetic-v1',fullMembers:symbols,members:symbols.map((symbol,i)=>({symbol,name:'测试样本'+i}))};
 const points:Record<string,DataPoint>={};for(const symbol of [...symbols,'sh000300']){const stock=symbol!=='sh000300',bars=dates.map((date,i)=>({date,close:stock?100*Math.pow(1.01,i):100,volume:100})),previousClose=bars.at(-1)!.close;points[symbol]={symbol,name:'测试样例',kind:stock?'stock':'index',source:'明确标记的隔离测试数据',quoteUrl:'https://qt.gtimg.cn/test',historyUrl:'https://web.ifzq.gtimg.cn/test',receivedAt:at,historyReceivedAt:at,quotePriceBasis:'unadjusted',quoteAt:at,tradeDate:date,priceBasis:stock?'qfq':'none',priceUnit:stock?'CNY':'index_points',volumeUnit:'shares',volumeComparable:true,finalPrice:false,finalVolume:false,quote:{price:previousClose*(stock?multiplier:1),previousClose,volume:100,open:previousClose},bars,issues:[]};}
 return {id:'a'.repeat(64),provider:'SYNTHETIC FIXTURE',observedAt:at,calendarVersion:'SSE-SZSE-2026/2025-12-22',groups:[group],points,issues:[],classificationVersion:'synthetic-v1',coverage:{requestedGroups:1,loadedGroups:1,requestedSymbols:5,loadedSymbols:5,uncovered:['隔离虚构测试，不能外发']},synthetic:true};
}
beforeEach(()=>{sql.exec('DELETE FROM tasks');sql.exec('DELETE FROM runs');sql.exec('DELETE FROM records');sql.exec('DELETE FROM observation_frames');});
after(()=>{sql.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true});});
test('exchange calendar uses Shanghai, closes holidays/weekends and fails closed on unknown years',()=>{
 assert.equal(tradingDay('2026-10-01'),false);assert.equal(tradingDay('2026-10-10'),false);assert.equal(tradingDay('2026-11-13'),true);assert.equal(tradingDay('2027-01-04'),null);assert.equal(marketPhase('2026-11-13T04:05:00Z'),'closed');assert.equal(marketPhase('2026-11-13T06:00:00Z'),'intraday');assert.match(nextObservation('2026-11-13T07:00:00Z',60)!,/^2026-11-16/);
});
test('cumulative relative returns use ratios, matching dates and distinct instrument units',()=>{
 const f=fixture(),m=computeMetric(f.groups[0],f,config());assert.equal(m.valid,true);assert.ok(Math.abs(m.relative3!-((1.01**3-1)*100))<.0001);assert.ok(Math.abs(m.relative5!-((1.01**5-1)*100))<.0001);assert.notEqual(m.relative3,3);assert.equal(m.stage,'intraday');assert.equal(m.volumeRatio,null);
});
test('old, missing, suspended/unknown status, future or conflicting prices cannot confirm signals',()=>{
 for(const mutate of [(p:DataPoint)=>p.tradeDate='2026-11-12',(p:DataPoint)=>p.quoteAt='invalid',(p:DataPoint)=>p.quoteAt='2026-11-13T01:00:00Z',(p:DataPoint)=>p.quoteAt='2026-11-13T03:00:00Z',(p:DataPoint)=>p.quote!.volume=0,(p:DataPoint)=>p.priceBasis='none',(p:DataPoint)=>p.priceUnit='index_points',(p:DataPoint)=>p.bars=[]]){
  const f=fixture();for(const p of Object.values(f.points).filter(p=>p.kind==='stock'))mutate(p);assert.equal(computeMetric(f.groups[0],f,config()).valid,false);
 }
 const missing=fixture();delete missing.points.sh000300;assert.equal(computeMetric(missing.groups[0],missing,config()).valid,false);
});
test('a single jumping stock is not sector breadth, and missing members cannot improve ranking',()=>{
 const f=fixture(undefined,.99);f.points.sz000001.quote!.price=f.points.sz000001.quote!.previousClose!*1.2;const result=detect(f,config(),[],true);assert.equal(result.states[0].status,'watching');assert.equal(result.metrics[0].breadth,.25);
 const partial=fixture();partial.groups[0].members.push({symbol:'sz000003',name:'缺失样本'});partial.groups[0].fullMembers.push('sz000003');const r=detect(partial,config(),[],false);assert.equal(r.metrics[0].coverage,.8);assert.equal(r.states.length,0);assert.equal(r.signals.length,0);
});
test('intraday strength followed by reversal never becomes formal close confirmation',()=>{
 const f=fixture();const baseline=detect(f,config(),[],true);const close=fixture('2026-11-13T07:05:00.000Z',.94);Object.values(close.points).forEach(p=>p.quoteAt='2026-11-13T07:00:00.000Z');const result=detect(close,config(),baseline.states,false);assert.equal(result.metrics[0].valid,false);assert.equal(result.signals.length,0);assert.equal(result.states[0].last.stage,'intraday');
});
test('20-day volume requires final-volume evidence and consistent units, never intraday versus full days',()=>{
 const f=fixture('2026-11-13T07:05:00.000Z');for(const p of Object.values(f.points)){p.finalPrice=true;p.finalVolume=true;p.quoteAt='2026-11-13T07:00:00.000Z';p.bars.push({date:'2026-11-13',close:p.quote!.price,volume:200});}let m=computeMetric(f.groups[0],f,config());assert.equal(m.stage,'close_confirmed');assert.equal(m.volumeRatio,2);
 f.points.sz000001.volumeUnit='lots';m=computeMetric(f.groups[0],f,config());assert.equal(m.volumeRatio,null);const c=config();c.rules.requireVolume=true;assert.equal(detect(f,c,[],true).states[0].status,'watching');
});
test('baseline is quiet, repeated identical quotes do not count, a real threshold crossing emits once',()=>{
 const c=config();let r=detect(fixture('2026-11-13T01:40:00.000Z',.95),c,[],true);assert.equal(r.signals.length,0);
 r=detect(fixture('2026-11-13T02:10:00.000Z'),c,r.states,false);assert.equal(r.signals.length,0);assert.equal(r.states[0].strongChecks,1);
 r=detect(fixture('2026-11-13T02:10:00.000Z'),c,r.states,false);assert.equal(r.states[0].strongChecks,1);
 r=detect(fixture('2026-11-13T02:40:00.000Z'),c,r.states,false);assert.equal(r.signals.filter(s=>s.kind==='candidate'&&s.notify).length,1);assert.equal(r.signals[0].phase,'intraday');
 r=detect(fixture('2026-11-13T03:10:00.000Z'),c,r.states,false);assert.equal(r.signals.length,0);
});
test('multiple hourly checks never count as multiple final trading days',()=>{
 const c=config();let r=detect(fixture('2026-11-13T01:40:00.000Z'),c,[],true);r=detect(fixture('2026-11-13T02:10:00.000Z',1.04),c,r.states,false);assert.equal(r.states[0].strongDates.length,1);assert.equal(r.states[0].finalDates.length,0);assert.ok(r.signals.every(s=>s.phase==='intraday'));
});
test('highly overlapping themes preserve evidence but produce one related alert',()=>{
 const f=fixture('2026-11-13T01:40:00.000Z');f.groups.push({...structuredClone(f.groups[0]),id:'000929',name:'测试重叠方向',kind:'theme'});let r=detect(f,config(),[],true);
 const next=fixture('2026-11-13T02:10:00.000Z',1.04);next.groups=f.groups;r=detect(next,config(),r.states,false);assert.equal(r.signals.filter(s=>s.notify).length,1);assert.ok(r.signals.some(s=>!s.notify&&s.related.length));
});
test('risk transitions do not wait for a generic cooldown and recover into a new episode',()=>{
 let r=detect(fixture('2026-11-13T01:40:00.000Z'),config(),[],true);r=detect(fixture('2026-11-13T02:10:00.000Z',.94),config(),r.states,false);r=detect(fixture('2026-11-13T02:40:00.000Z',.94),config(),r.states,false);assert.equal(r.signals[0].kind,'risk');assert.equal(r.states[0].status,'weakening');r=detect(fixture('2026-11-13T03:10:00.000Z'),config(),r.states,false);r=detect(fixture('2026-11-13T05:10:00.000Z'),config(),r.states,false);assert.equal(r.states[0].episode,2);assert.ok(r.signals.some(s=>s.kind==='candidate'));
});
test('official constituent parser verifies headers, dates, identity and versions actual membership',()=>{
 const rows=[['日期Date','指数代码 Index Code','指数名称 Index Name','成份券代码Constituent Code','成份券名称Constituent Name','交易所Exchange'],['20261111','000928','测试能源','000001','样本一','深圳证券交易所'],['20261111','000928','测试能源','600001','样本二','上海证券交易所']];const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Sheet1');const bytes=XLSX.write(book,{type:'buffer',bookType:'xls'});const g=provider.parseConstituents(bytes,'000928','2026-11-13T02:00:00Z',6);assert.equal(g.members.length,2);assert.equal(g.sourceDate,'2026-11-11');assert.throws(()=>provider.parseConstituents(bytes,'000929','2026-11-13T02:00:00Z',6));assert.throws(()=>provider.parseConstituents(bytes,'000928','2026-11-01T02:00:00Z',6));
});
test('task instances share engine but never candidate states, config versions or lifetimes',async()=>{
 const store=await import('../server/store');const guarded=service.createObservation(config());assert.throws(()=>store.runTask(guarded),/持续观察/);assert.throws(()=>store.pauseTask(guarded,'active'),/持续观察/);
 const a=service.createObservation(config()),c=config();c.scope.include=['000929'];c.durationDays=28;const b=service.createObservation(c);const at=sql.now();service.setObservationStatus(a,'activate',at);service.setObservationStatus(b,'activate',at);const expiry=service.observationTask(b)!.ends_at;
 assert.equal(service.requestObservationCheck(a),service.requestObservationCheck(a));assert.notEqual(service.requestObservationCheck(b),service.requestObservationCheck(a));
 service.setObservationStatus(b,'pause');service.setObservationStatus(b,'resume');assert.equal(service.observationTask(b)!.ends_at,expiry);
 service.changeObservation(a,{...config(),frequencyMinutes:60});assert.equal(service.observationTask(a)!.config_version,2);assert.equal(service.observationTask(b)!.config_version,1);assert.equal(sql.all("SELECT * FROM runs WHERE task_id=? AND status='cancelled'",a).length,1);
});
test('expiry does not slide and unknown preferences stay draft; model availability is irrelevant',()=>{
 const c=config();c.durationDays=1;const key=service.createObservation(c);service.setObservationStatus(key,'activate','2026-11-10T02:00:00.000Z');service.tickObservations('2026-11-12T02:00:00.000Z');assert.equal(service.observationTask(key)!.status,'expired');assert.throws(()=>service.setObservationStatus(key,'resume'));
 const unknown=service.createObservation({...config(),unresolved:['用户能理解的行业未知']});assert.throws(()=>service.setObservationStatus(unknown,'activate'));assert.equal(service.observationTask(unknown)!.status,'draft');
});
test('worker processing persists genuine outcomes without model calls; synthetic frames never notify',async()=>{
 const key=service.createObservation(config());service.setObservationStatus(key,'activate');const rid=service.requestObservationCheck(key);sql.exec("UPDATE runs SET status='running' WHERE id=?",rid);
 await service.processObservation(sql.one<any>('SELECT * FROM runs WHERE id=?',rid)!,async()=>fixture(),()=>new Date('2026-11-13T02:00:00.000Z'));
 assert.equal(sql.one<any>('SELECT outcome FROM observation_checks WHERE run_id=?',rid)!.outcome,'baseline');assert.equal(service.observationDetail(key).candidates.length,1);assert.equal(JSON.parse(sql.one<any>('SELECT result FROM runs WHERE id=?',rid)!.result).observation.notify,false);
 assert.equal(sql.all('SELECT * FROM usage').length,0);const replay=service.replayObservation(key,'2026-01-01T00:00:00Z','2026-12-31T00:00:00Z');assert.equal(replay.history.length,0,'config created after synthetic historical frame must not be backfilled');
});
test('future membership is rejected, replay never fetches latest prices or rewrites prior evidence',()=>{
 const f=fixture();f.groups[0].knownAt='2026-11-14T00:00:00.000Z';assert.equal(computeMetric(f.groups[0],f,config()).valid,false);
 const key=service.createObservation(config()),rid=sql.id();sql.exec("UPDATE observation_configs SET created_at='2026-11-12T01:00:00.000Z' WHERE task_id=?",key);sql.exec("INSERT INTO runs(id,task_id,mode,status,revision,created_at) VALUES(?,?,'observation','succeeded',0,'2026-11-13T02:00:00.000Z')",rid,key);const frame=fixture();sql.exec('INSERT INTO observation_frames VALUES(?,?,?)',frame.id,frame.observedAt,JSON.stringify(frame));sql.exec("INSERT INTO observation_checks VALUES(?,?,1,1,?,'baseline','{}','2026-11-13T02:00:00.000Z')",rid,key,frame.id);const before=sql.one<any>('SELECT payload FROM observation_frames')!.payload;const replay=service.replayObservation(key,'2026-11-01T00:00:00Z','2026-11-14T00:00:00Z');assert.equal(replay.history.length,1);assert.ok(replay.history.flatMap(x=>x.signals).every(s=>!s.notify));assert.equal(sql.one<any>('SELECT payload FROM observation_frames')!.payload,before);
});
test('natural language creates only an explicit draft and separates analysis horizon from expiry',()=>{
 const record=(content:string)=>{const key=sql.id();sql.exec("INSERT INTO records VALUES(?,NULL,'user','message',?,?,NULL)",key,content,sql.now());return sql.one<any>('SELECT * FROM records WHERE id=?',key)!;};
 assert.equal(conversation.handleObservationConversation(record('A股市场今天什么主线比较强？')),null);
 const answer=conversation.handleObservationConversation(record('请创建A股主线机会雷达，持续帮我观察A股未来2—4周可能形成的主线机会，我不指定板块，有值得关注的新变化再提醒。'));assert.ok(answer?.taskId);const task=service.observationTask(answer!.taskId!)!;assert.equal(task.status,'draft');assert.deepEqual(task.config.analysisWeeks,[2,4]);assert.equal(task.ends_at,null);assert.equal(task.config.notification.channel,'app');
 const unknown=conversation.handleObservationConversation(record('请新建雷达，只关注我能理解的产业方向'));assert.ok(service.observationTask(unknown!.taskId!)!.config.unresolved.length);
});
test('diffusion needs at least two newly participating samples and unchanged membership',()=>{
 const c=config();c.rules.breadth=.5;const f=fixture('2026-11-13T01:40:00.000Z');f.points.sh600001.quote!.price=f.points.sh600001.quote!.previousClose!;f.points.sh600002.quote!.price=f.points.sh600002.quote!.previousClose!;let r=detect(f,c,[],true);
 r=detect(fixture('2026-11-13T02:10:00.000Z',1.02),c,r.states,false);assert.ok(r.signals.some(s=>s.kind==='diffusion'));assert.match(r.signals.find(s=>s.kind==='diffusion')!.explanation,/仅证明样本内扩散/);
});
test('formal persistent confirmation requires distinct consecutive final trading dates',()=>{
 const closing=(at:string)=>{const f=fixture(at);for(const p of Object.values(f.points)){p.finalPrice=true;p.quoteAt=at;}return f;};
 const c=config();let r=detect(closing('2026-11-12T07:05:00.000Z'),c,[],true);assert.deepEqual(r.states[0].finalDates,['2026-11-12']);r=detect(closing('2026-11-13T07:05:00.000Z'),c,r.states,false);assert.ok(r.signals.some(s=>s.phase==='persistent_confirmed'));
 const intraday=fixture();Object.values(intraday.points).forEach(p=>p.finalPrice=true);assert.equal(computeMetric(intraday.groups[0],intraday,c).stage,'intraday','a bad final flag during trading cannot override calendar stage');
});
test('configuration change or pause during a fetch prevents old signals committing',async()=>{
 const key=service.createObservation(config());service.setObservationStatus(key,'activate');let rid=service.requestObservationCheck(key);sql.exec("UPDATE runs SET status='running' WHERE id=?",rid);
 await service.processObservation(sql.one<any>('SELECT * FROM runs WHERE id=?',rid)!,async()=>{service.changeObservation(key,{...config(),frequencyMinutes:60});return fixture();},()=>new Date('2026-11-13T02:00:00.000Z'));
 assert.equal(service.observationDetail(key).signals.length,0);assert.equal(sql.one<any>('SELECT status FROM runs WHERE id=?',rid).status,'cancelled');
 rid=service.requestObservationCheck(key);sql.exec("UPDATE runs SET status='running' WHERE id=?",rid);await service.processObservation(sql.one<any>('SELECT * FROM runs WHERE id=?',rid)!,async()=>{service.setObservationStatus(key,'pause');return fixture();},()=>new Date('2026-11-13T02:00:00.000Z'));assert.equal(service.observationDetail(key).signals.length,0);assert.equal(service.observationTask(key)!.status,'paused');
});
test('a separate process sees task versions and crash recovery does not replay old checks',async()=>{
 const key=service.createObservation(config());service.setObservationStatus(key,'activate');const rid=service.requestObservationCheck(key);sql.exec("UPDATE runs SET status='failed',error='interrupted' WHERE id=?",rid);service.tickObservations('2026-11-13T04:00:00.000Z');assert.equal(sql.one<any>('SELECT outcome FROM observation_checks WHERE run_id=?',rid).outcome,'failed');
 await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`import {observationTask} from './server/observation/service.ts';if(observationTask('${key}')?.config_version!==1)process.exit(2);`],{env:process.env,stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('cross-process persistence failed')));});
});
test('rotation requires persistent relative improvement over an independently tracked leader',()=>{
 const c=config();c.rules.rotationDelta=.3;
 function two(at:string,a:number,b:number){const f=fixture(at,a),other=fixture(at,b),renamed:Record<string,DataPoint>={};const map=new Map<string,string>();other.groups[0].members.forEach((m,i)=>{const symbol='sz00100'+i;map.set(m.symbol,symbol);renamed[symbol]={...other.points[m.symbol],symbol};});f.points={...f.points,...renamed};f.groups.push({...other.groups[0],id:'000929',name:'测试独立方向',fullMembers:[...map.values()],members:other.groups[0].members.map(m=>({...m,symbol:map.get(m.symbol)!}))});return f;}
 let r=detect(two('2026-11-13T01:40:00.000Z',1.01,1.02),c,[],true);
 r=detect(two('2026-11-13T02:10:00.000Z',1.03,1.02),c,r.states,false);assert.ok(!r.signals.some(s=>s.kind==='rotation'));
 r=detect(two('2026-11-13T02:40:00.000Z',1.04,1.02),c,r.states,false);assert.ok(r.signals.some(s=>s.kind==='rotation'));assert.match(r.signals.find(s=>s.kind==='rotation')!.explanation,/不能证明资金/);
});
test('live provider failure is kept as missing data with HTTP diagnosis, not zero returns',async()=>{
 const rows=[['日期Date','指数代码 Index Code','指数名称 Index Name','成份券代码Constituent Code','成份券名称Constituent Name','交易所Exchange'],...['000001','000002','000003'].map(code=>['20261111','000928','测试能源',code,'样本','深圳证券交易所'])];const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Sheet1');const bytes=XLSX.write(book,{type:'buffer',bookType:'xls'});
 const fake=(async(url:any)=>String(url).includes('csindex')?new Response(bytes):new Response('source unavailable',{status:501})) as typeof fetch;
 const f=await provider.collectFrame(config(),new AbortController().signal,fake,()=>new Date('2026-11-13T02:00:00.000Z'));assert.equal(f.coverage.loadedGroups,1);assert.equal(f.coverage.loadedSymbols,0);assert.match(f.points.sh000300.issues.join(','),/HTTP 501/);const result=detect(f,config(),[],false);assert.equal(result.validGroups,0);assert.equal(result.metrics[0].relative3,null);assert.equal(result.signals.length,0);
});

test('a detected event commits with evidence and persists once across repeat checks',async()=>{
 const key=service.createObservation(config());service.setObservationStatus(key,'activate');
 async function check(at:string,multiplier:number,tag:string){const rid=service.requestObservationCheck(key);sql.exec("UPDATE runs SET status='running' WHERE id=?",rid);const f=fixture(at,multiplier);f.id=tag.repeat(64);await service.processObservation(sql.one<any>('SELECT * FROM runs WHERE id=?',rid)!,async()=>f,()=>new Date(at));return sql.one<any>('SELECT * FROM runs WHERE id=?',rid)!;}
 assert.equal((await check('2026-11-13T01:40:00.000Z',1.01,'a')).status,'succeeded');
 const eventRun=await check('2026-11-13T02:10:00.000Z',1.03,'b');assert.equal(eventRun.status,'succeeded');assert.equal(JSON.parse(eventRun.result).observation.notify,false,'synthetic event must stay local');
 const events=sql.all<any>('SELECT * FROM observation_signals WHERE task_id=?',key);assert.ok(events.length>0);assert.ok(events.every(e=>e.run_id===eventRun.id&&JSON.parse(e.payload).metric.relative3>0));
 await check('2026-11-13T02:10:00.000Z',1.03,'c');assert.equal(sql.all('SELECT * FROM observation_signals WHERE task_id=?',key).length,events.length);
 const slow=config();slow.frequencyMinutes=120;const first=detect(fixture('2026-11-13T01:40:00.000Z'),slow,[],true);const early=detect(fixture('2026-11-13T02:10:00.000Z',1.03),slow,first.states,false);assert.equal(early.signals.length,0);assert.equal(early.states[0].lastEvidence,first.states[0].lastEvidence);
});
