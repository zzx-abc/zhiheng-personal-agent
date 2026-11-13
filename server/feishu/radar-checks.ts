import {interpretArchived} from '../observation/report-read';
import {observationConfigSchema} from '../observation/types';
import {summaryText,evidenceText,buildDecisions} from '../observation/strategy';
import {db,one,all,exec,now,id,transaction} from '../db';
import {requireScope,taskAllowed,type Scope,radarRoute} from './unified-store';
import {startAttempt,finishAttempt} from './radar-delivery';
import type {Transport} from './receiver';

// A completed check is a distinct business object, not a detected investment signal.
db.exec(`CREATE TABLE IF NOT EXISTS radar_check_refs(number INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT UNIQUE NOT NULL REFERENCES observation_checks(run_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS feishu_check_messages(app TEXT NOT NULL,tenant TEXT NOT NULL,chat TEXT NOT NULL,message_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES observation_checks(run_id) ON DELETE CASCADE,parent TEXT,receipt_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(app,tenant,chat,message_id,run_id));`);
export type Check={number:number;run_id:string;task_id:string;config_version:number;epoch:number;outcome:string;created_at:string;detail:string;payload:string};
const query='SELECT x.number,c.*,f.payload FROM radar_check_refs x JOIN observation_checks c ON c.run_id=x.run_id JOIN observation_frames f ON f.id=c.frame_id JOIN runs r ON r.id=c.run_id';
function usable(s:Scope,c:Check|undefined){if(!c||!taskAllowed(s,c.task_id))return null;try{const frame=JSON.parse(c.payload),detail=JSON.parse(c.detail);if(!detail.themeReport?.themes?.length||frame.synthetic!==false&&process.env.AGENT_TEST_MODE!=='1')return null;return c;}catch{return null;}}
export function checkByRun(s:Scope,runId:string){requireScope(s);return usable(s,one<Check>(query+" WHERE c.run_id=? AND r.status IN ('succeeded','partial')",runId));}
export function checkByNumber(s:Scope,number:number){requireScope(s);return usable(s,one<Check>(query+" WHERE x.number=? AND r.status IN ('succeeded','partial')",number));}
export function referenceCheck(s:Scope,runId:string){requireScope(s);const source=one<{task_id:string;detail:string;payload:string}>("SELECT c.task_id,c.detail,f.payload FROM observation_checks c JOIN observation_frames f ON f.id=c.frame_id JOIN runs r ON r.id=c.run_id WHERE c.run_id=? AND r.status IN ('succeeded','partial')",runId);if(!source||!taskAllowed(s,source.task_id)||!JSON.parse(source.detail||'{}').themeReport?.themes?.length||JSON.parse(source.payload).synthetic!==false&&process.env.AGENT_TEST_MODE!=='1')throw Error('没有可引用的授权检查快照');exec('INSERT OR IGNORE INTO radar_check_refs(run_id) VALUES(?)',runId);return checkByRun(s,runId)!;}
export function latestCheck(s:Scope){requireScope(s);const rows=all<{run_id:string;task_id:string;detail:string}>("SELECT c.run_id,c.task_id,c.detail FROM observation_checks c JOIN runs r ON r.id=c.run_id WHERE r.status IN ('succeeded','partial') AND c.frame_id IS NOT NULL AND c.detail IS NOT NULL ORDER BY c.created_at DESC");for(const row of rows)if(taskAllowed(s,row.task_id)&&JSON.parse(row.detail).themeReport?.themes?.length)return referenceCheck(s,row.run_id);throw Error('没有可用的主题检查快照');}
export function mappedChecks(s:Scope,message:string){requireScope(s);return all<{run_id:string}>('SELECT run_id FROM feishu_check_messages WHERE app=? AND tenant=? AND chat=? AND message_id=?',s.app,s.tenant,s.chat,message).map(x=>checkByRun(s,x.run_id)).filter((x):x is Check=>!!x);}
export function mapCheckMessage(s:Scope,message:string,keys:string[],receipt:string,parent:string|null=null){requireScope(s);for(const key of keys){if(!checkByRun(s,key))throw Error('检查引用已不可访问');exec('INSERT OR IGNORE INTO feishu_check_messages VALUES(?,?,?,?,?,?,?,?)',s.app,s.tenant,s.chat,message,key,parent,receipt,now());}}
const stamp=(at:string)=>Number.isFinite(Date.parse(at))?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 北京时间':'原始时间缺失';
const num=(x:unknown,suffix='')=>typeof x==='number'&&Number.isFinite(x)?x.toFixed(2)+suffix:'缺失';
export function checkText(check:Check,detailed=false,question=''){
 const data=JSON.parse(check.detail),frame=JSON.parse(check.payload);let report={events:[],states:[],window:{start3:null,start5:null,end:null,basis:'旧报告未记录计算区间'},phase:'历史阶段见原始证据',baseline:check.outcome==='baseline',...data.themeReport};
 // Read-only interpretation of archived evidence. Never fetch current data or create events here.
 if(!report.decision&&frame.themeConfigs?.length){const stored=one<{config:string}>('SELECT config FROM observation_configs WHERE task_id=? AND version=?',check.task_id,check.config_version);if(stored)report=interpretArchived(report,frame,observationConfigSchema.parse(JSON.parse(stored.config)))?.themeReport||report;}
 if(!report.decision)report={...report,decision:buildDecisions(report)};
 const intro=`R-${check.number} · 历史检查${frame.synthetic?'（合成测试数据，未经独立行情核验）':''}；采集 ${stamp(report.observedAt)}。不是当前行情。`;
 if(/诊断/.test(question))return intro+'\n'+JSON.stringify({configVersion:check.config_version,epoch:check.epoch,outcome:check.outcome,provider:frame.provider,mode:report.mode,issues:frame.issues,coverage:frame.coverage},null,2);
 if(/全部对象/.test(question))return intro+'\n'+[...report.decision.risks,...report.decision.opportunities,...report.decision.others].map((x:any)=>`${x.theme}·${x.name}：${x.reasons.join('；')||'证据待补齐'}；${x.actions[0].label}`).join('\n');
 const page=Math.max(1,Number(question.match(/第?(\d+)页/)?.[1]||1));
 return intro+'\n'+(detailed?evidenceText(report,question,page):summaryText(report,'历史检查只读解读'))+'\n查看证据 / 查看全部对象 / 运行诊断：回复本条并发送对应文字；私聊可带 R-'+check.number+' 查阅。';
}
export function routeCheck(s:Scope,text:string,row:{parent?:string|null}){
 requireScope(s);const refs=[...text.matchAll(/\bR-(\d+)\b/gi)].map(m=>+m[1]);if(/\bE-\d+\b/i.test(text)){if(refs.length)return {text:'这次同时提到了信号与检查快照，请明确要解释哪个编号。',entryIds:[]};return null;}
 let checks:Check[]=[];
 if(refs.length)checks=[...new Set(refs)].map(n=>checkByNumber(s,n)).filter((x):x is Check=>!!x);
 else for(const parent of [row.parent,s.thread])if(parent){checks=mappedChecks(s,parent);if(checks.length)break;}
 if(!refs.length&&!checks.length&&!row.parent&&!s.thread&&/刚才|这次检查|这条检查|那条检查/.test(text)){
  const cutoff=new Date(Date.now()-30*60000).toISOString();
  const signals=all<{signal_id:string}>('SELECT DISTINCT signal_id FROM feishu_event_messages WHERE app=? AND tenant=? AND chat=? AND created_at>?',s.app,s.tenant,s.chat,cutoff);
  const recent=all<{run_id:string}>('SELECT run_id FROM feishu_check_messages WHERE app=? AND tenant=? AND chat=? AND created_at>? GROUP BY run_id ORDER BY MAX(created_at) DESC LIMIT 3',s.app,s.tenant,s.chat,cutoff).map(x=>checkByRun(s,x.run_id)).filter((x):x is Check=>!!x);
  if(!signals.length&&recent.length===1)checks=recent;
  else if(recent.length&&!signals.length)return {text:'这个群近期有多份检查，请回复对应消息，或选择：'+recent.map(c=>'R-'+c.number+'（'+stamp(JSON.parse(c.detail).themeReport.observedAt)+'）').join('、'),entryIds:[]};
 }
 if(!refs.length&&!checks.length)return null;
 if(checks.length!==1)return {text:'无法唯一确定可访问的检查快照，请回复对应消息或提供一个 R-编号。',entryIds:[]};
 const check=checks[0];
 if(/结合|我的|个人|收藏|记下来|保存|暂停/.test(text))return {text:s.scene==='group'?`个人资料不会在群里读取。请在私聊发送 R-${check.number} 查看这份历史检查；快照暂只支持事实查询，个人资料联合分析需使用真实触发事件的E编号。`:'这份R编号目前支持检查事实与同配置比较，尚未接入快照收藏或个人资料联合分析；没有执行这些操作。',entryIds:[],checks:[check.run_id]};
 let response=checkText(check,/证据|详情|条件|第?\d+页/.test(text),text);
 if(/上次|变化|不同|比较|对比/.test(text)){const prior=one<{run_id:string}>("SELECT c.run_id FROM observation_checks c JOIN runs r ON r.id=c.run_id WHERE c.task_id=? AND c.config_version=? AND c.epoch=? AND c.created_at<? AND c.frame_id IS NOT NULL AND r.status IN ('succeeded','partial') ORDER BY c.created_at DESC LIMIT 1",check.task_id,check.config_version,check.epoch,check.created_at);if(prior){const before=referenceCheck(s,prior.run_id);response+='\n对照同任务、同配置版本、同运行轮次的上次检查：\n'+checkText(before,false);}else response+='\n没有同任务、同配置版本和同轮次的上一份检查，不能把旧行业模式的结果当作本次主题检查的上次结果。';}
 return {text:response,entryIds:[],checks:[check.run_id]};
}
export async function sendCheckTest(s:Scope,runId:string,transport:Transport){
 requireScope(s);if(s.scene!=='group')throw Error('联调目标必须是已绑定群');const check=referenceCheck(s,runId),businessKey=JSON.stringify(['authorized-check-test',s.app,s.tenant,s.chat,runId]);
 const existing=one<any>('SELECT n.status,m.platform_message_id FROM feishu_delivery_meta m JOIN notification_outbox n ON n.id=m.receipt_id WHERE m.business_key=?',businessKey);if(existing)return {status:existing.status,duplicate:true,messageIdSaved:!!existing.platform_message_id,reference:'R-'+check.number};
 if(!transport.send)throw Error('群发送适配器未提供');const receipt=id(),at=now();
 transaction(()=>{exec('INSERT INTO notification_outbox VALUES(?,NULL,?,?,?,?,?,NULL)',receipt,'feishu_check_test','sending',s.generation,at,at);exec('INSERT INTO feishu_delivery_meta VALUES(?,?,?,?,?,?,?,?,?,?,?)',receipt,businessKey,'authorized-check-test','confirmed-radar-group','app',radarRoute().version,1,null,s.app,s.tenant,s.chat);startAttempt(receipt);});
 let status='unknown',error:string|null='联调发送结果未知；未自动重发',messageId:string|undefined;
 try{requireScope(s);if(!checkByRun(s,runId))throw Error('源检查已不可访问');const reply=await transport.send(s.chat,'【雷达联调测试｜真实历史检查】\n'+checkText(check)+'\n\n请使用本条消息的「回复」功能并 @知衡，问：“这次检查说明了什么，哪些地方还不能确认？”\n我会按这条消息读取当时的详细条件和缺口，无需你手填编号。也可在私聊发送 '+`R-${check.number}`+'。\n这是本次授权的联调展示，不是新触发信号，正式雷达通道未切换。',receipt);messageId=reply.messageId;if(reply.code===0&&messageId){error=null;transaction(()=>{mapCheckMessage(s,messageId!,[runId],receipt);finishAttempt(receipt,'sent',null,messageId);exec('UPDATE notification_outbox SET status=?,updated_at=?,error=NULL WHERE id=?','sent',now(),receipt);});status='sent';}else if(reply.code!==0){status='failed';error='飞书拒绝联调消息，错误码 '+reply.code;}}catch{/* Never print provider payloads or silently retry. */}
 if(status!=='sent')transaction(()=>{finishAttempt(receipt,status,error,messageId);exec('UPDATE notification_outbox SET status=?,error=?,updated_at=? WHERE id=?',status,error,now(),receipt);});
 return {status,duplicate:false,messageIdSaved:!!messageId,reference:'R-'+check.number};
}
