import test from 'node:test';
import type {WorkingState} from '../server/working-state';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-state-test-'));
const sql=await import('../server/db');
const store=await import('../server/store');
const {saveConfig}=await import('../server/config');
const {processRun,claim}=await import('../server/engine');
const {currentState,validateState}=await import('../server/working-state');
const {research}=await import('../server/research');
const reset=()=>{for(const t of ['working_states','events','reports','evidence','attachments','memories','runs','records','tasks','topics','usage'])sql.exec(`DELETE FROM ${t}`);saveConfig('TEST-FIXTURE-NOT-A-REAL-KEY','kimi-k3',1000000)};
const state=(source:string,assessment='测试：假设尚未证实'):WorkingState=>({thesis:{text:'测试：订单改善是否能支持短期主线',owner:'user_hypothesis' as const,sources:[source]},assessment,assumptions:[{text:'测试：需求改善能够转化为订单',sources:[]}],evidence:[],change_conditions:['测试：订单兑现后才更新判断'],open_questions:['测试：订单是否兑现'],next_action:{kind:'official_search' as const,question:'测试：甲公司订单兑现了吗',reason:'测试：先查因果链前提'},change_summary:'测试：保存待验证前提'});
const answer=(s:ReturnType<typeof state>|null)=>({judgment:'测试样例：只说明逻辑，尚未查证事实',reasons:[],uncertainties:[],next_step:'',agreement:'',disagreement:'',memory_candidates:[],withdraw_memory_ids:[],working_state:s});
async function submit(topic:string,text:string,value:ReturnType<typeof answer>){const rec=store.addRecord(text,topic);const run=store.enqueue(rec,'review');await processRun(claim()!,async()=>value);return {rec,run}}

test('Working state survives reopen, creates versions and feeds a later conversation',async()=>{
 reset();const topic=store.createTopic('测试关注'),original=store.addRecord('测试：我正在验证订单改善',topic);
 await submit(topic,'测试：整理思路',answer(state(original)));const first=currentState(topic)!;assert.ok(first);
 const {DatabaseSync}=await import('node:sqlite');const other=new DatabaseSync(path.join(process.env.AGENT_DATA_DIR!,'agent.sqlite'));assert.ok(other.prepare("SELECT id FROM working_states WHERE status='current'").get());other.close();
 const rec=store.addRecord('测试：接着上次，只更新新的前提',topic);store.enqueue(rec,'chat');let used=false;
 await processRun(claim()!,async(_system,prompt)=>{assert.ok(prompt.includes('订单是否兑现'));assert.ok(prompt.includes(original));used=true;return answer({...state(original,'测试：新增了反向线索'),change_summary:'测试：新信息改变一个前提'})});
 assert.ok(used);assert.equal(sql.all('SELECT * FROM working_states').length,2);assert.equal(currentState(topic)?.previous_id,first.id);assert.equal(sql.one<any>('SELECT status FROM working_states WHERE id=?',first.id)?.status,'superseded');
});
test('Correction invalidates working assumptions before next response, and deletion erases derived versions',async()=>{
 reset();const topic=store.createTopic('测试关注'),original=store.addRecord('测试：订单假设',topic);await submit(topic,'测试整理',answer(state(original)));
 const memory=store.addMemory('测试旧规则','principle',topic);store.correctMemory(memory,'测试：这不是规则');assert.equal(currentState(topic),undefined);assert.equal(sql.one<any>('SELECT status FROM working_states')?.status,'stale');
 store.deleteRecord(original);assert.equal(sql.all('SELECT * FROM working_states').length,0);assert.equal(store.snapshot().workingStates.length,0);
});
test('Invented source or unsourced user attribution cannot enter persistent state',()=>{
 reset();const original=store.addRecord('测试原话',null);assert.throws(()=>validateState(state('invented'),new Set([original])),/不存在/);
 const value=state(original);value.thesis.sources=[];assert.throws(()=>validateState(value,new Set()),/原始表达/);
});
test('Cancelled run cannot update the current working state',async()=>{
 reset();const topic=store.createTopic('测试关注'),source=store.addRecord('测试初始假设',topic);await submit(topic,'测试整理',answer(state(source)));const old=currentState(topic)!.id;
 const rec=store.addRecord('测试新分析',topic),run=store.enqueue(rec,'chat');await processRun(claim()!,async()=>{store.cancel(run);return answer(state(source,'测试不应提交'))});assert.equal(currentState(topic)!.id,old);
});
test('A brief correction updates existing work instead of discarding the whole ongoing question',async()=>{
 reset();const topic=store.createTopic('测试关注'),source=store.addRecord('测试假设，尚未认可规则',topic);await submit(topic,'测试整理',answer(state(source)));const old=currentState(topic)!.id;
 const rec=store.addRecord('你理解错了，我只是在验证，不是我的规则',topic);store.enqueue(rec,'chat');let refreshed=false;
 await processRun(claim()!,async(system)=>{if(system.includes('本次只输出状态对象本身')){refreshed=true;return {...state(source),change_summary:'测试：澄清只是待验证假设，不是规则'}}return answer(null)});
 assert.ok(refreshed);assert.ok(currentState(topic));assert.notEqual(currentState(topic)!.id,old);assert.equal(sql.one<any>('SELECT status FROM working_states WHERE id=?',old)?.status,'stale');assert.match(currentState(topic)!.content,/不是规则/);
});
async function researchFixture(decisions:any[],results:any[]){
 reset();const topicId=store.createTopic('测试官方查证'),recId=store.addRecord('测试：核实甲公司订单',topicId);store.enqueue(recId,'check');const run=claim()!;
 const queries:string[]=[];let calls=0;const call=async(system:string)=>{if(system.includes('你规划'))return {query:'测试 甲公司 订单',scope:'测试一个公司样本',window_days:30,blocked_reason:''};return decisions[calls++]};
 const tool=async(_path:string,body:any)=>{queries.push(body.text_query);return {search_results:results[queries.length-1]||[]}};
 await research(run,sql.one<any>('SELECT * FROM records WHERE id=?',recId),sql.one<any>('SELECT * FROM topics WHERE id=?',topicId),call,new AbortController().signal,()=>{},()=>{},tool);
 return {queries,outcome:JSON.parse(sql.one<any>("SELECT detail FROM events WHERE type='research_finished'")!.detail)};
}
const decision=(kind:string,query:string|null=null)=>({decision:kind,reason:'测试：还没找到直接材料',achieved:[],missing:['测试：订单数据缺失'],next_query:query,next_requirement:'测试：提供公司披露原文'});
test('Research evaluates results, replans one different query, and stops at a concrete blocker',async()=>{
 const {queries,outcome}=await researchFixture([decision('continue','测试 甲公司 在手订单'),decision('blocked')],[[],[]]);assert.deepEqual(queries,['测试 甲公司 订单','测试 甲公司 在手订单']);assert.equal(outcome.status,'blocked');assert.equal(outcome.searches,2);assert.match(outcome.next_requirement,/原文/);
});
test('Repeated query is stopped without extra tool spending; empty search never becomes answered',async()=>{
 const repeated=await researchFixture([decision('continue','测试 甲公司 订单')],[[]]);assert.equal(repeated.queries.length,1);assert.equal(repeated.outcome.status,'limited');
 const invented=await researchFixture([decision('answered')],[[]]);assert.equal(invented.outcome.status,'limited');assert.deepEqual(invented.outcome.achieved,[]);
});
test('Relevant official excerpt can end execution before the search budget is consumed',async()=>{
 const date=new Date().toISOString().slice(0,10);const result=await researchFixture([{...decision('answered'),reason:'测试：披露片段回答了公司问题',achieved:['测试：该样本披露了在手订单'],missing:[],next_requirement:''}],[[{title:'明确标注的测试披露',url:`https://static.cninfo.com.cn/finalpage/${date}/test.pdf`,date,chunks:[{text:'TEST FIXTURE：甲公司在手订单披露，仅用于验证程序。'}]}]]);assert.equal(result.queries.length,1);assert.equal(result.outcome.status,'answered');
});
test('Brief replies may omit inapplicable metadata but cannot omit their actual answer',async()=>{
 const {leaderSchema}=await import('../server/model');const brief=leaderSchema.parse({judgment:'测试：简短有效回答',reasons:[],uncertainties:[],next_step:''});assert.deepEqual(brief.memory_candidates,[]);assert.deepEqual(brief.withdraw_memory_ids,[]);assert.equal(brief.working_state,null);assert.equal(brief.evidence_sufficient,false);assert.throws(()=>leaderSchema.parse({}),/judgment/);
});
test('JSON wrapper cleanup preserves a complete answer and refuses truncation or ambiguous objects',async()=>{
 const {cleanJson}=await import('../server/model');assert.deepEqual(cleanJson('说明\n```json\n{"answer":"测试"}\n```'),{answer:'测试'});assert.deepEqual(cleanJson('\ufeff{"answer":"测试"}'),{answer:'测试'});assert.throws(()=>cleanJson('{"answer":"未完成'));assert.throws(()=>cleanJson('说明 {"a":1} {"b":2}'));
});
test('Decision background accepts exact user quotes but rejects invented or external attribution',()=>{
 reset();const source=store.addRecord('测试：我关注它是因为订单改善；我没有确定持有周期。',null);
 const value={...state(source),decision_frame:{original_basis:{quote:'我关注它是因为订单改善',source_id:source},evaluation_horizon:null,contemplated_change:null,change_trigger:null}};
 validateState(value,new Set([source]));
 assert.throws(()=>validateState({...value,decision_frame:{...value.decision_frame,evaluation_horizon:{quote:'我准备持有三个月',source_id:source}}},new Set([source])),/逐字/);
 const assistant=store.addRecord('我关注它是因为订单改善',null,'message','assistant');
 assert.throws(()=>validateState({...value,decision_frame:{...value.decision_frame,original_basis:{quote:'我关注它是因为订单改善',source_id:assistant}}},new Set([source,assistant])),/用户原文/);
});
test('Decision baseline remains retrievable even when its source falls outside recent search results',async()=>{
 reset();const topic=store.createTopic('测试决策背景');const baseline=store.addRecord('测试：我参与是为了等待设备订单兑现',topic);
 const original=store.addRecord('测试：当前正在比较价格变化',topic);
 const value={...state(original),decision_frame:{original_basis:{quote:'我参与是为了等待设备订单兑现',source_id:baseline},evaluation_horizon:null,contemplated_change:null,change_trigger:null}};
 await submit(topic,'测试整理背景',answer(value));
 for(let i=0;i<20;i++)store.addRecord('测试：后来的消息 '+i,topic);
 const rec=store.addRecord('测试：继续',topic);store.enqueue(rec,'chat');let found=false;
 await processRun(claim()!,async(_system,prompt)=>{const c=JSON.parse(prompt.split('\n程序执行回执')[0]);found=c.history.some((r:any)=>r.id===baseline)&&c.allowed_source_ids.includes(baseline);return answer(null)});
 assert.ok(found,'Decision quote must bring its original record back into context');
 store.deleteRecord(baseline);assert.equal(currentState(topic),undefined);
});
test('Uncited state inference is omitted with an audit event, not saved as evidence or allowed to lose the answer',async()=>{
 reset();const topic=store.createTopic('测试无来源推断'),source=store.addRecord('测试：我还没有换仓',topic);
 const value={...state(source),evidence:[{text:'测试：模型自行推断用户已经操作',direction:'context' as const,sources:[]}]};
 const {run}=await submit(topic,'测试整理',answer(value));
 assert.ok(['succeeded','partial'].includes(sql.one<any>('SELECT status FROM runs WHERE id=?',run)!.status));
 assert.deepEqual(JSON.parse(currentState(topic)!.content).evidence,[]);
 assert.ok(sql.one("SELECT id FROM events WHERE run_id=? AND type='unsupported_state_evidence_omitted'",run));
});
test.after(()=>{sql.db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true})});
