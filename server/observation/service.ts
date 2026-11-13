import './db';
import {all,one,exec,id,now,transaction,revision,event,type Run} from '../db';
import {observationConfigSchema,TEMPLATE_VERSION,industryUniverse,type ObservationConfig,type Frame,type Candidate} from './types';
import {marketPhase,nextObservation,missedTradingMinutes,calendarVersion,calendarSources,localParts} from './calendar';
import {collectFrame,storedFrame} from './provider';
import {detect} from './detectors';
import {resolveThemes} from './themes';
import {analyzeThemes,themeNotification} from './theme-engine';
import type {ThemeState,ThemeReport} from './theme-types';
import {nextThemeObservation} from './calendar';
const nextCheck=(at:string,c:ObservationConfig)=>c.observationMode==='theme_watch'?nextThemeObservation(at,c.frequencyMinutes):nextObservation(at,c.frequencyMinutes);
function validateThemes(c:ObservationConfig){if(c.observationMode==='theme_watch')resolveThemes(c.themes);}
export type ObservationTask={id:string;title:string;status:string;config_version:number;epoch:number;started_at:string|null;ends_at:string|null;next_at:string|null;last_success_at:string|null;last_check_at:string|null;baseline_key:string|null;failure_streak:number;fault_notified_at:string|null;health:string;config:ObservationConfig};
const taskQuery=`SELECT t.id,t.title,t.status,o.*,c.config FROM observation_tasks o JOIN tasks t ON t.id=o.task_id JOIN observation_configs c ON c.task_id=o.task_id AND c.version=o.config_version`;
export function observationTask(key:string){const row=one<Omit<ObservationTask,'config'>&{config:string}>(taskQuery+' WHERE t.id=?',key);return row?{...row,config:observationConfigSchema.parse(JSON.parse(row.config))}:null;}
export function observationSummary(){return all<{id:string}>('SELECT task_id id FROM observation_tasks').map(r=>observationTask(r.id)!);}
function action(key:string,name:string,detail:unknown){exec('INSERT INTO observation_actions VALUES(?,?,?,?,?)',id(),key,name,JSON.stringify(detail),now());}
export function createObservation(raw:unknown,sourceId:string|null=null){const config=observationConfigSchema.parse(raw);validateThemes(config);return transaction(()=>{
 const key=id(),at=now();exec('INSERT OR IGNORE INTO observation_templates VALUES(?,?,?)',TEMPLATE_VERSION,JSON.stringify({id:'a_share_radar',version:TEMPLATE_VERSION,calendarVersion,calendarSources,industries:industryUniverse,provider:'Tencent/CSI',defaultConfig:observationConfigSchema.parse({})}),at);
 exec('INSERT INTO tasks VALUES(?,NULL,?,?,?, ?,?,?,NULL)',key,config.observationMode==='theme_watch'?'多主题机会雷达':config.scope.include.length===1?(industryUniverse.find(g=>g.id===config.scope.include[0])!.name+'持续观察'):'A股主线机会雷达',config.goal,'draft','observation',at,at);exec('INSERT INTO observation_tasks(task_id) VALUES(?)',key);exec('INSERT INTO observation_configs VALUES(?,?,?,?,?)',key,1,JSON.stringify(config),sourceId,at);action(key,'draft_created',{sourceId,configVersion:1});return key;
 });}
export function changeObservation(key:string,raw:unknown,sourceId:string|null=null){const config=observationConfigSchema.parse(raw);validateThemes(config);transaction(()=>{
 const task=observationTask(key);if(!task)throw Error('观察任务不存在');if(['ended','expired'].includes(task.status))throw Error('已结束的任务保留历史，请另建任务');
 const version=task.config_version+1;exec('INSERT INTO observation_configs VALUES(?,?,?,?,?)',key,version,JSON.stringify(config),sourceId,now());
 // Expiry is anchored to the first activation, never shifted by a scan or resume.
 const ends=task.started_at&&config.durationDays!==null?new Date(Date.parse(task.started_at)+config.durationDays*86400000).toISOString():null;
 exec("UPDATE runs SET status='cancelled',finished_at=?,error='观察配置已改变' WHERE task_id=? AND status IN ('queued','running','blocked')",now(),key);
 exec('UPDATE observation_tasks SET config_version=?,epoch=epoch+1,baseline_key=NULL,ends_at=?,next_at=? WHERE task_id=?',version,ends,nextCheck(now(),config),key);
 exec('DELETE FROM observation_candidates WHERE task_id=?',key);exec('DELETE FROM observation_theme_states WHERE task_id=?',key);exec("UPDATE tasks SET title=?,question=?,status=CASE WHEN ? THEN 'draft' ELSE status END,updated_at=? WHERE id=?",config.observationMode==='theme_watch'?'多主题机会雷达':'A股主线机会雷达',config.goal,config.unresolved.length?1:0,now(),key);action(key,'config_changed',{version,sourceId,rebaseline:true});
 });}
export function setObservationStatus(key:string,operation:'activate'|'pause'|'resume'|'end',at=now()){
 return transaction(()=>{const task=observationTask(key);if(!task)throw Error('观察任务不存在');if(['ended','expired'].includes(task.status))throw Error('任务已结束；如需继续请新建');
 if(operation==='activate'||operation==='resume'){
  if(task.config.unresolved.length)throw Error('先明确草稿中的关键范围或偏好');
  if(task.ends_at&&task.ends_at<=at)throw Error('运行期限已到，恢复不会延长期限');
  if(task.config.notification.channel==='feishu'&&!one<{enabled:number}>('SELECT enabled FROM notification_settings WHERE id=1')?.enabled)throw Error('请先在连接设置中开启飞书，或改用应用内提醒');
  if(task.status==='active')return;
  const started=task.started_at||at,ends=task.ends_at||(task.config.durationDays===null?null:new Date(Date.parse(started)+task.config.durationDays*86400000).toISOString());
  exec('UPDATE observation_tasks SET started_at=?,ends_at=?,next_at=?,epoch=epoch+1,baseline_key=NULL WHERE task_id=?',started,ends,marketPhase(at)==='intraday'?at:task.config.observationMode==='theme_watch'?nextCheck(at,task.config):nextObservation(at,1),key);exec('DELETE FROM observation_candidates WHERE task_id=?',key);exec('DELETE FROM observation_theme_states WHERE task_id=?',key);exec("UPDATE tasks SET status='active',updated_at=? WHERE id=?",at,key);
 }else{exec('UPDATE tasks SET status=?,updated_at=? WHERE id=?',operation==='pause'?'paused':'ended',at,key);exec("UPDATE runs SET status='cancelled',error='用户暂停或结束观察',finished_at=? WHERE task_id=? AND status IN ('queued','running','blocked')",at,key);exec('UPDATE observation_tasks SET next_at=NULL WHERE task_id=?',key);}
 action(key,operation,{at});});
}
export function requestObservationCheck(key:string,at=now(),manual=true){return transaction(()=>{
 const task=observationTask(key);if(!task||task.status!=='active')throw Error('请先启用观察任务');if(task.ends_at&&task.ends_at<=at)throw Error('任务已到期');
 const existing=one<{id:string}>("SELECT id FROM runs WHERE task_id=? AND status IN ('queued','running')",key);if(existing)return existing.id;
 const runId=id();exec("INSERT INTO runs(id,task_id,mode,status,revision,created_at) VALUES(?,?,'observation','queued',?,?)",runId,key,revision(),at);exec('INSERT INTO observation_checks(run_id,task_id,config_version,epoch,created_at) VALUES(?,?,?,?,?)',runId,key,task.config_version,task.epoch,at);exec('UPDATE tasks SET last_run_id=?,updated_at=? WHERE id=?',runId,at,key);event(runId,'observation_queued',{manual,configVersion:task.config_version});return runId;
 });}
export function tickObservations(at=now()){
 // Reconcile a worker crash without replaying an old intraday check.
 for(const row of all<{run_id:string;task_id:string}>("SELECT c.run_id,c.task_id FROM observation_checks c JOIN runs r ON r.id=c.run_id WHERE c.outcome='queued' AND r.status IN ('failed','cancelled','stale')")){
  exec("UPDATE observation_checks SET outcome='failed',detail=? WHERE run_id=?",JSON.stringify({reason:'上次检查中断或已取消，未补发旧信号；下一有效时段重新检查'}),row.run_id);
 }
 for(const task of observationSummary().filter(t=>t.status==='active')){
  if(task.ends_at&&task.ends_at<=at){transaction(()=>{exec("UPDATE tasks SET status='expired',updated_at=? WHERE id=?",at,task.id);exec("UPDATE runs SET status='cancelled',error='观察已到期',finished_at=? WHERE task_id=? AND status IN ('queued','running')",at,task.id);exec('UPDATE observation_tasks SET next_at=NULL WHERE task_id=?',task.id);action(task.id,'expired',{endsAt:task.ends_at});});continue;}
  if(marketPhase(at)==='unknown'){exec("UPDATE observation_tasks SET health='交易日历未覆盖当前年份；未执行策略检查' WHERE task_id=?",task.id);continue;}
  if(task.next_at&&task.next_at>at)continue;
  if(marketPhase(at)==='intraday')requestObservationCheck(task.id,at,false);
  exec('UPDATE observation_tasks SET next_at=? WHERE task_id=?',nextCheck(at,task.config),task.id);
 }
}
function alive(run:Run,task:ObservationTask){const current=observationTask(task.id),r=one<Run>('SELECT * FROM runs WHERE id=?',run.id);if(r?.status!=='running'||current?.status!=='active'||current.config_version!==task.config_version||current.epoch!==task.epoch||current.ends_at&&current.ends_at<=now())throw Error('观察已暂停、到期或配置已改变');}
function complete(run:Run,outcome:string,detail:unknown,result:unknown,status='succeeded'){exec('UPDATE observation_checks SET outcome=?,detail=? WHERE run_id=?',outcome,JSON.stringify(detail),run.id);exec("UPDATE runs SET status=?,phase='done',finished_at=?,result=? WHERE id=?",status,now(),JSON.stringify(result),run.id);}
function message(task:ObservationTask,result:ReturnType<typeof detect>,frame:Frame){
 const signals=result.signals.filter(s=>s.notify).sort((a,b)=>Number(b.kind==='risk')-Number(a.kind==='risk')||Number(task.config.scope.focus.includes(b.groupId))-Number(task.config.scope.focus.includes(a.groupId))||(b.metric.relative3||0)-(a.metric.relative3||0)),lines=[`知衡 · ${task.title}`,`数据观察时间：${new Date(frame.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）`,`范围：${frame.groups.length} 个行业的成分抽样，本轮 ${result.validGroups} 组样本满足质量门槛；不是全A股扫描。`];
 for(const s of signals.slice(0,5)){lines.push(`${s.metric.name} · ${{candidate:'新候选',strengthening:'增强',diffusion:'样本内扩散',rotation:'轮动候选',risk:'弱化风险'}[s.kind]} · ${s.phase==='intraday'?'盘中初步观察（非收盘确认）':s.phase}`,s.change,s.explanation,`3/5日相对强度 ${s.metric.relative3}/${s.metric.relative5} 个百分点；上涨样本 ${s.metric.upMembers.length}/${s.metric.validMembers.length}。`);if(s.metric.missing.length)lines.push('未验证：'+s.metric.missing.join('；'));lines.push('接下来：观察相对强度与样本广度能否延续；不据此认定买卖点。');}
 if(signals.length>5)lines.push(`另外 ${signals.length-5} 项保留在应用内，避免刷屏。`);
 lines.push('完整数值、公式、当时成分及来源保留在本机“持续观察”。');return lines.join('\n');
}
export async function processObservation(run:Run,provider=collectFrame,clock=()=>new Date()){
 const task=run.task_id?observationTask(run.task_id):null;if(!task){exec("UPDATE runs SET status='failed',error='观察任务不存在',finished_at=? WHERE id=?",now(),run.id);return;}
 const check=one<{config_version:number;epoch:number}>('SELECT * FROM observation_checks WHERE run_id=?',run.id);
 if(check?.config_version!==task.config_version||check?.epoch!==task.epoch){exec("UPDATE runs SET status='cancelled',error='排队配置已过时',finished_at=? WHERE id=?",now(),run.id);return;}
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),180000),pulse=setInterval(()=>{try{alive(run,task);exec('UPDATE runs SET heartbeat=? WHERE id=?',now(),run.id);}catch{controller.abort();}},2000);
 try{
  alive(run,task);const at=clock().toISOString();exec('UPDATE observation_tasks SET last_check_at=? WHERE task_id=?',at,task.id);
  const phase=marketPhase(at);if(task.config.observationMode!=='theme_watch'&&phase!=='intraday'&&phase!=='after_close'){transaction(()=>{alive(run,task);const reason=phase==='unknown'?'交易日历未覆盖':'当前非交易时段，未采集策略信号';complete(run,'skipped',{reason}, {observation:{notify:false}});exec('UPDATE observation_tasks SET health=? WHERE task_id=?',reason,task.id);});return;}
  exec("UPDATE runs SET phase='observation_collecting' WHERE id=?",run.id);
  const frame=await provider(task.config,controller.signal,fetch,clock);alive(run,task);
  if(frame.synthetic&&process.env.AGENT_TEST_MODE!=='1')throw Error('测试数据不得进入真实观察任务');
  const currentTime=clock().toISOString();if(frame.observedAt>currentTime||Date.parse(currentTime)-Date.parse(frame.observedAt)>10*60000)throw Error('采集批次已过期或来自未来');
  if(task.config.observationMode==='theme_watch'){
   const offline=task.last_success_at&&missedTradingMinutes(task.last_success_at,frame.observedAt)>Math.max(180,task.config.frequencyMinutes*3);
   const baseline=!task.baseline_key||task.baseline_key!==frame.classificationVersion||!!offline;
   const states=all<{state:string}>('SELECT state FROM observation_theme_states WHERE task_id=?',task.id).map(r=>JSON.parse(r.state) as ThemeState);
   const old=one<{detail:string}>("SELECT detail FROM observation_checks WHERE task_id=? AND outcome IN ('baseline','new_signals','no_new_signal','partial_coverage') AND detail IS NOT NULL ORDER BY rowid DESC LIMIT 1",task.id);
   const result=analyzeThemes(frame,task.config,states,baseline,old&&!baseline?JSON.parse(old.detail).themeReport:null);
   transaction(()=>{alive(run,task);exec('INSERT OR IGNORE INTO observation_frames VALUES(?,?,?)',frame.id,frame.observedAt,JSON.stringify(frame));exec('UPDATE observation_checks SET frame_id=? WHERE run_id=?',frame.id,run.id);
    if(baseline)exec('DELETE FROM observation_theme_states WHERE task_id=?',task.id);
    for(const state of result.states)exec('INSERT OR REPLACE INTO observation_theme_states VALUES(?,?,?)',task.id,state.id,JSON.stringify(state));
    for(const signal of result.events){const dedupe=[task.id,task.config_version,task.epoch,frame.classificationVersion,signal.id].join(':');exec('INSERT OR IGNORE INTO observation_signals VALUES(?,?,?,?,?,?)',id(),task.id,run.id,dedupe,JSON.stringify(signal),at);}
    const partial=result.themes.some(t=>t.valid<t.configured),notices=result.events.filter(e=>e.notify);
    complete(run,baseline?'baseline':notices.length?'new_signals':partial?'partial_coverage':'no_new_signal',{themeReport:result,coverage:frame.coverage,issues:frame.issues,frameId:frame.id},{observation:{notify:!frame.synthetic&&task.config.notification.channel==='feishu'&&notices.length>0,taskVersion:task.config_version,epoch:task.epoch,expiresAt:new Date(Date.parse(at)+task.config.frequencyMinutes*60000).toISOString(),text:themeNotification(result)}},partial?'partial':'succeeded');
    exec('UPDATE observation_tasks SET baseline_key=?,last_success_at=?,failure_streak=?,health=? WHERE task_id=?',frame.classificationVersion,result.unique.valid?at:task.last_success_at,result.unique.valid?0:task.failure_streak+1,`${result.themes.length}个主题；${result.unique.valid}/${result.unique.configured}只有完整可比历史。`+(baseline?'当前体检已保存，建立基线不推送。':notices.length?`新增${notices.length}组变化。`:'没有新的提醒事件；缺失按对象显示。'),task.id);
   });return;
  }
  const previous=all<{state:string}>('SELECT state FROM observation_candidates WHERE task_id=?',task.id).map(r=>JSON.parse(r.state) as Candidate);
  const offline=task.last_success_at&&missedTradingMinutes(task.last_success_at,frame.observedAt)>Math.max(180,task.config.frequencyMinutes*3);
  const baseline=!task.baseline_key||task.baseline_key!==frame.classificationVersion||!!offline;
  const result=detect(frame,task.config,previous,baseline);
  const valid=result.validGroups>0&&frame.coverage.loadedGroups===frame.coverage.requestedGroups;
  transaction(()=>{
   alive(run,task);exec('INSERT OR IGNORE INTO observation_frames VALUES(?,?,?)',frame.id,frame.observedAt,JSON.stringify(frame));exec('UPDATE observation_checks SET frame_id=? WHERE run_id=?',frame.id,run.id);
   if(marketPhase(frame.observedAt)==='after_close'&&!Object.values(frame.points).some(p=>p.finalPrice)){
    complete(run,'preliminary',{reason:'市场已收盘，但数据源没有正式最终收盘标志；仅保留采集证据，不作收盘确认',coverage:frame.coverage,metrics:result.metrics,issues:frame.issues},{observation:{notify:false}},'partial');exec("UPDATE observation_tasks SET health='仅初步观察：缺少正式收盘数据标志' WHERE task_id=?",task.id);return;
   }
   if(!valid){const failures=task.failure_streak+1,notify=task.config.notification.faults&&task.config.notification.channel==='feishu'&&failures>=3&&(!task.fault_notified_at||Date.parse(at)-Date.parse(task.fault_notified_at)>24*3600000);
    complete(run,'data_unavailable',{coverage:frame.coverage,metrics:result.metrics,issues:frame.issues}, {observation:{notify:notify&&!frame.synthetic,kind:'system_fault',taskVersion:task.config_version,epoch:task.epoch,expiresAt:new Date(Date.parse(at)+60*60000).toISOString(),text:'知衡 · 观察数据故障\n连续检查未取得足够可用数据，不能解释为没有机会。请打开持续观察查看缺失字段；任务没有因未读而暂停。'}},'partial');
    exec('UPDATE observation_tasks SET failure_streak=?,health=?,fault_notified_at=CASE WHEN ? THEN ? ELSE fault_notified_at END WHERE task_id=?',failures,'本轮核验失败：没有足够有效样本或分类缺失',notify?1:0,at,task.id);return;
   }
   if(baseline){exec('DELETE FROM observation_candidates WHERE task_id=?',task.id);action(task.id,'baseline',{classificationVersion:frame.classificationVersion,reason:offline?'离线恢复':task.baseline_key?'分类变化':'首次启用或配置变更'});}
   for(const s of result.states)exec('INSERT OR REPLACE INTO observation_candidates VALUES(?,?,?)',task.id,s.id,JSON.stringify(s));
   for(const s of result.signals){const key=[task.id,task.config_version,task.epoch,frame.classificationVersion,s.groupId,s.kind,s.episode,s.phase].join(':');exec('INSERT OR IGNORE INTO observation_signals VALUES(?,?,?,?,?,?)',id(),task.id,run.id,key,JSON.stringify(s),at);}
   if(task.failure_streak)action(task.id,'data_recovered',{previousFailures:task.failure_streak,at});
   const notices=result.signals.filter(s=>s.notify),recovery=task.failure_streak>=3&&!!task.fault_notified_at&&task.config.notification.faults;
   complete(run,baseline?'baseline':notices.length?'new_signals':'no_new_signal',{...result,coverage:frame.coverage,issues:frame.issues,frameId:frame.id},{observation:{notify:!frame.synthetic&&task.config.notification.channel==='feishu'&&(notices.length>0||recovery),taskVersion:task.config_version,epoch:task.epoch,expiresAt:new Date(Date.parse(at)+task.config.frequencyMinutes*60000).toISOString(),text:notices.length?message(task,result,frame):'知衡 · 观察数据恢复\n本轮已重新取得可用样本。恢复不代表市场出现了新机会；完整范围与质量见本机持续观察。'}});
   const coverageNote=result.validGroups<frame.groups.length?`部分覆盖：${result.validGroups}/${frame.groups.length} 组通过质量门槛。`:'';
   exec('UPDATE observation_tasks SET baseline_key=?,last_success_at=?,failure_streak=0,health=? WHERE task_id=?',frame.classificationVersion,at,coverageNote+(baseline?'基线已建立，初始候选不外发':notices.length?'发现新的观察事件':'检查完成，没有新的提醒事件'),task.id);
  });
 }catch{const current=one<Run>('SELECT * FROM runs WHERE id=?',run.id);if(current?.status==='running')transaction(()=>{
  const failures=task.failure_streak+1,at=clock().toISOString(),notify=task.config.notification.faults&&task.config.notification.channel==='feishu'&&process.env.AGENT_TEST_MODE!=='1'&&failures>=3&&(!task.fault_notified_at||Date.parse(at)-Date.parse(task.fault_notified_at)>24*3600000);
  complete(run,'failed',{reason:'采集超时、配置变化或数据格式未通过校验；没有产生策略结论'},{observation:{notify,taskVersion:task.config_version,epoch:task.epoch,expiresAt:new Date(Date.parse(at)+3600000).toISOString(),text:'知衡 · 观察执行故障\n连续检查未完成，没有形成新的市场结论。任务未因未读而暂停；请在本机查看数据健康。'}},'failed');exec("UPDATE observation_tasks SET failure_streak=?,health='本轮执行失败；请查看检查记录',fault_notified_at=CASE WHEN ? THEN ? ELSE fault_notified_at END WHERE task_id=?",failures,notify?1:0,at,task.id);
 });}
 finally{clearInterval(pulse);clearTimeout(timeout);}
}
export function observationDetail(key:string,start?:string,end?:string){const task=observationTask(key);if(!task)throw Error('观察任务不存在');return {task,themeStates:all<{state:string}>('SELECT state FROM observation_theme_states WHERE task_id=?',key).map(x=>JSON.parse(x.state)),candidates:all<{state:string}>('SELECT state FROM observation_candidates WHERE task_id=?',key).map(x=>JSON.parse(x.state)),checks:all(`SELECT c.*,r.status,r.finished_at FROM observation_checks c JOIN runs r ON r.id=c.run_id WHERE c.task_id=? AND c.created_at>=? AND c.created_at<=? ORDER BY c.rowid DESC LIMIT 100`,key,start||'',end||'9999'),signals:all('SELECT * FROM observation_signals WHERE task_id=? AND created_at>=? AND created_at<=? ORDER BY rowid DESC LIMIT 100',key,start||'',end||'9999'),actions:all('SELECT * FROM observation_actions WHERE task_id=? ORDER BY rowid DESC LIMIT 30',key),notifications:all('SELECT n.* FROM notification_outbox n JOIN runs r ON r.id=n.run_id WHERE r.task_id=? ORDER BY n.rowid DESC LIMIT 30',key)};}
export function replayObservation(key:string,start:string,end:string){
 const rows=all<{run_id:string;frame_id:string;config_version:number;epoch:number}>(`SELECT run_id,frame_id,config_version,epoch FROM observation_checks WHERE task_id=? AND frame_id IS NOT NULL AND created_at>=? AND created_at<=? ORDER BY created_at,rowid LIMIT 200`,key,start,end);
 let states:Candidate[]=[],themeStates:ThemeState[]=[],lastTheme:ThemeReport|null=null,version='',mapping='';const history=[];
 for(const row of rows){const f=storedFrame(row.frame_id);if(!f)continue;const config=one<{config:string;created_at:string}>('SELECT * FROM observation_configs WHERE task_id=? AND version=?',key,row.config_version);if(!config||config.created_at>f.observedAt)continue;const v=row.config_version+':'+row.epoch,baseline=v!==version||mapping!==f.classificationVersion;const parsed=observationConfigSchema.parse(JSON.parse(config.config));if(parsed.observationMode==='theme_watch'){const result=analyzeThemes(f,parsed,themeStates,baseline,lastTheme);themeStates=result.states;lastTheme=result;history.push({observedAt:f.observedAt,frameId:f.id,configVersion:row.config_version,baseline,signals:all<{payload:string}>('SELECT payload FROM observation_signals WHERE run_id=?',row.run_id).map(x=>({...JSON.parse(x.payload),notify:false})),recomputedSignals:result.events.map(e=>({...e,notify:false})),validGroups:result.themes.filter(t=>t.comparable).length,themeReport:result});version=v;mapping=f.classificationVersion;continue;}const result=detect(f,parsed,states,baseline);states=result.states;const original=all<{payload:string}>('SELECT payload FROM observation_signals WHERE run_id=?',row.run_id).map(x=>({...JSON.parse(x.payload),notify:false}));history.push({observedAt:f.observedAt,frameId:f.id,configVersion:row.config_version,baseline,signals:original,recomputedSignals:result.signals.map(s=>({...s,notify:false})),validGroups:result.validGroups});version=v;mapping=f.classificationVersion;}
 return {history,notice:'仅回放系统当时保存的帧与配置；原始信号单独保留，重算从区间首帧重新建立基线，可能与包含更早状态的原信号不同。不拉取最新价格或成分、不发送通知、不计算策略收益率。没有历史采集记录的时段不可回测；一次最多展示200个采集批次。'};
}
