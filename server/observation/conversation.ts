import {wantsEvidence} from './evidence-brief';
import {summaryText,evidenceText} from './strategy';
import {all,one,exec,id,now,transaction,revision,type RecordRow} from '../db';
import {observationConfigSchema,industryUniverse} from './types';
import {createObservation,observationSummary,observationTask,changeObservation,setObservationStatus,requestObservationCheck,observationDetail,replayObservation} from './service';
import {themeCatalog} from './themes';
import {storedFrame} from './provider';

/** Narrow natural-language tool gateway: uncertain instructions stay drafts; never execute quoted external content. */
export function observationIntent(text:string){return /(雷达|观察任务|持续观察|持续.{0,12}(扫描|观察|监测).{0,20}(A股|市场|主线)|持续帮我观察A股)/i.test(text);}
function scopeNames(text:string){return industryUniverse.filter(g=>text.includes(g.name)||text.includes(g.id)||g.id==='000934'&&text.includes('金融')).map(g=>g.id);}
function applyText(text:string,old=observationConfigSchema.parse({})){
 const c=structuredClone(old);
 const matched=themeCatalog().filter(t=>text.includes(t.name));if(matched.length){c.observationMode='theme_watch';c.themes=matched.map(t=>({id:t.id,version:t.version}));c.unresolved=[];}

 const weeks=text.match(/未来\s*(\d+)\s*[—–~～至到-]\s*(\d+)\s*周/);if(weeks)c.analysisWeeks=[+weeks[1],+weeks[2]];
 const term=text.match(/(?:运行|启用后|持续运行)\s*(\d+|四|两|一|二|三)\s*(周|天)(?:后|结束|到期)?/);if(term){const n=Number(term[1])||({'四':4,'两':2,'一':1,'二':2,'三':3} as Record<string,number>)[term[1]];c.durationDays=n*(term[2]==='周'?7:1);}else if(/长期运行|持续运行直到我停止/.test(text))c.durationDays=null;
 const interval=text.match(/每\s*(30|60|120)\s*分钟/);if(interval)c.frequencyMinutes=+interval[1] as 30|60|120;else if(/每小时/.test(text))c.frequencyMinutes=60;
 const excluded=text.match(/排除([^。；\n]+)/)?.[1],included=text.match(/只(?:观察|关注)([^。；\n]+)/)?.[1];
 if(excluded){c.scope.exclude=scopeNames(excluded);if(!c.scope.exclude.length)c.unresolved.push('排除范围尚未匹配到已接入的行业，请在任务中选择');}
 if(included&&c.observationMode!=='theme_watch'){c.scope.include=scopeNames(included);if(!c.scope.include.length)c.unresolved.push('需要明确“只关注”的产业方向；不会猜测你能理解哪些行业');}
 if(/重点观察/.test(text)){const selected=scopeNames(text);if(selected.length)c.scope.focus=[...new Set([...c.scope.focus,...selected])];else c.unresolved.push('重点观察方向尚未明确');}
 if(/飞书/.test(text))c.notification.channel='feishu';if(/仅应用内|只在应用内/.test(text))c.notification.channel='app';
 if(c.observationMode!=='theme_watch'&&/半导体|国产替代|机器人|人工智能|ETF|概念/.test(text)&&/(只关注|只观察|排除|重点观察)/.test(text))c.unresolved.push('此主题/ETF未纳入当前行业分类，不能用模型联想替代成分依据；请先选择已覆盖行业或保留草稿');
 return observationConfigSchema.parse(c);
}
export function handleObservationConversation(record:RecordRow):{runId:string;taskId:string|null}|null{
 const text=record.content;
 const root=one<{root_id:string}>('SELECT root_id FROM record_context WHERE record_id=?',record.id)?.root_id;
 const bound=root?one<{task_id:string}>('SELECT c.task_id FROM observation_configs c LEFT JOIN record_context r ON r.record_id=c.source_id WHERE c.source_id=? OR r.root_id=? ORDER BY c.created_at DESC LIMIT 1',root,root):undefined;
 if((!observationIntent(text)&&!(bound&&/任务|方向|观察|排除|只关注|重点|为什么|暂停|恢复|启用|结束|检查|变化|数据|回放/.test(text)))||/转发|摘录|文章说|公告说|群里说|^[“「"]/.test(text))return null;
 const tasks=observationSummary().filter(t=>!['ended','expired'].includes(t.status));
 let task=tasks.find(t=>text.includes(t.id))||tasks.find(t=>t.id===bound?.task_id);if(!task&&tasks.length===1)task=tasks[0];
 let reply='',taskId=task?.id||null;
 const explicitCreate=/(?:请|帮我|创建|新建|建立).{0,20}(?:持续|雷达|观察任务)|持续帮我观察A股/.test(text)&&!/(能否|是否|如何|怎么|不要|不用|不想|吗[？?]?$)/.test(text);
 try{
  if(explicitCreate&&(/创建|新建|建立|持续帮我观察A股/.test(text)||!task)&&!/(暂停|结束|停止|恢复)/.test(text)){
   const c=applyText(text);c.goal=text.slice(0,500);taskId=createObservation(c,record.id);reply=`已保存“A股主线机会雷达”草稿。分析周期 ${c.analysisWeeks.join('—')} 周，历史指标窗口 3/5/20 个交易日，${c.durationDays===null?'运行期限暂定持续，直到你停止':'启用后运行 '+c.durationDays+' 天'}；默认每 ${c.frequencyMinutes} 分钟在交易时段检查。范围是${c.observationMode==='theme_watch'?'指定主题的版本化核心与辅助股票':'中证800的10个行业成分抽样'}，不是整个A股；提醒先保留在应用内。打开“持续观察”可调整范围并启用，当前尚未后台监测。`;
  }else if(!task){reply=tasks.length?'有多个观察任务，请在“持续观察”选择要管理的任务，或在消息中附任务编号。':'目前没有观察任务。可以说“请创建A股主线机会雷达，持续帮我观察未来2—4周的主线机会”。';}
  else if(/^(请)?(?:帮我)?(?:暂停|停止|结束|恢复|启用|开启)/.test(text)){
   const op=/暂停/.test(text)?'pause':/停止|结束/.test(text)?'end':/恢复/.test(text)?'resume':'activate';setObservationStatus(task.id,op);reply={pause:'已暂停这个观察任务，取消未完成检查；历史保留。',end:'已结束这个观察任务，历史证据仍可查看。',resume:'已恢复观察；运行到期时间不变。主题观察保留原基线，不补发过期盘中提醒。',activate:'已启用观察。后台按交易时段执行，首次建立基线，不把已有强势方向包装成新机会。'}[op];
  }else if((/^(请)?(?:帮我)?(?:调整|改为|改成|排除|只关注|只观察|把|将)/.test(text)||/加入重点观察|设为重点/.test(text))){
   const c=applyText(text,task.config);changeObservation(task.id,c,record.id);reply=c.unresolved.length?'已保存调整草稿并停止自动执行，还需明确：'+c.unresolved.join('；'):'已保存新配置版本；下一次重新建立基线，不把配置变化当作行情变化。';
  }else if(/^(请)?(?:帮我)?(?:现在|立即|执行一次|检查一次)/.test(text)){requestObservationCheck(task.id);reply='已提交一次观察检查。可在“持续观察”查看实际数据、健康状态和结果；排队不代表已查完。';
  }else{
   const detail=observationDetail(task.id),latest=detail.checks[0] as {detail:string;outcome:string;frame_id:string}|undefined;
   if(/四周|4周|回放|复盘/.test(text)){const end=now(),start=new Date(Date.parse(end)-28*86400000).toISOString(),replay=replayObservation(task.id,start,end);reply=`过去四周保存了 ${replay.history.length} 个可回放采集批次，包含 ${replay.history.reduce((n,x)=>n+x.signals.length,0)} 个检测事件。${replay.notice} 完整检查及提醒记录在“持续观察”的历史中查看。`;}
   else if(!latest)reply='任务已保存，但还没有执行记录；没有记录不等于市场没有机会。';
   else if(task.config.observationMode==='theme_watch'&&JSON.parse(latest.detail||'{}').themeReport){const data=JSON.parse(latest.detail),report=data.interpretation?.themeReport||data.themeReport;reply=wantsEvidence(text)?evidenceText(report,text,Math.max(1,Number(text.match(/第?(\d+)页/)?.[1]||1))):summaryText(report,'已保存的历史检查')+'\n查看依据可回复股票名称和“查看证据”。';}
   else if(/为什么|哪些数据|哪些地方|无法验证|退潮|相比|变化|方向/.test(text)){
    const data=JSON.parse(latest.detail||'{}'),metrics=Array.isArray(data.metrics)?data.metrics:[],wanted=scopeNames(text),m=metrics.find((x:{id:string})=>wanted.includes(x.id))||(metrics.length===1?metrics[0]:null);
    if(!m)reply='请说明你指哪个已覆盖行业，我会对照当次指标和证据回答；多个方向不能合并成一个结论。';
    else{const frame=storedFrame(latest.frame_id);reply=`${m.name}：${m.valid?'这次有可用的样本指标':'这次无法确认'}。3/5日相对强度为 ${m.relative3??'未知'}/${m.relative5??'未知'} 个百分点，上涨广度 ${m.breadth===null?'未知':Math.round(m.breadth*100)+'%'}，联动 ${m.linkedMembers.length} 只。${m.missing.join('；')}。${frame?'证据批次 '+frame.observedAt+'；成分来源中证官网，行情来源腾讯，全部原始字段保留在该次检查中。':''} 同一条件持续成立不会反复提醒；样本内扩散不能推断产业链扩散。`;}
   }else reply=`观察任务当前${{draft:'是草稿，尚未启用',active:'正在运行',paused:'已暂停',ended:'已结束',expired:'已到期'}[task.status]||task.status}。最近检查：${task.last_check_at||'尚无'}；最近成功更新：${task.last_success_at||'尚无'}。${task.health}。下一次：${task.next_at||'没有排期'}；电脑休眠时不会运行。`;
  }
 }catch(e){reply=e instanceof Error?e.message:'观察任务操作未完成';}
 const runId=id(),result={judgment:reply,reasons:[],uncertainties:[],next_step:'打开“持续观察”查看配置、状态与证据。',observation_task_id:taskId};
 transaction(()=>{exec("INSERT INTO runs(id,record_id,mode,status,revision,created_at,finished_at,result) VALUES(?,?,'chat','succeeded',?,?,?,?)",runId,record.id,revision(),now(),now(),JSON.stringify(result));exec('INSERT INTO records VALUES(?,NULL,?,?,?, ?,?)',id(),'assistant','analysis',JSON.stringify(result),now(),runId);});
 return {runId,taskId};
}
