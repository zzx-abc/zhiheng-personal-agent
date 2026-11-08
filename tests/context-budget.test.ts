import test from 'node:test';import assert from 'node:assert/strict';
import {packContext,excerpt,CONTEXT_CHAR_LIMIT} from '../server/context-budget';
test('Growing history is bounded without changing the current request or corrected state',()=>{
 const raw='旧记录。'.repeat(10000)+'我只是在验证，不是交易规则。';
 const current={id:'current',text:'接着上次，观察周期不等于持有承诺。'};
 const workingState={decision_frame:{evaluation_horizon:{source_id:'original',quote:'我只是在验证，不是交易规则。'}}};
 const packed=packContext({current,workingState,history:[{id:'original',text:raw,kind:'message'},...Array.from({length:100},(_,i)=>({id:String(i),text:raw,kind:'message'}))],memories:[{id:'correction',kind:'correction',content:'没有实际换仓',source_id:'original',source_quote:'我只是在验证，不是交易规则。'}],evidence:[],previousEvidence:[],priorModelJudgments:[]});
 assert.ok(JSON.stringify(packed).length<=CONTEXT_CHAR_LIMIT);assert.deepEqual(packed.current,current);assert.deepEqual(packed.workingState,workingState);
 assert.ok(packed.history.find((x:any)=>x.id==='original').text.includes('不是交易规则'));assert.equal(packed.history[0].truncated,true);assert.ok(packed.contextSelection.omitted.history>0);assert.ok(raw.length>packed.history[0].text.length);
});
test('Oversized essential context fails explicitly instead of silently deleting the user request',()=>{assert.throws(()=>packContext({current:{text:'长'.repeat(50000)}}),/原文已保存/)});
test('Excerpt preserves source text rather than generating a model summary',()=>{const original='前文'.repeat(1000)+'明确纠正'+ '后文'.repeat(1000);const result=excerpt(original,200,['明确纠正']);assert.ok(result.text.includes('明确纠正'));assert.equal(result.text,original.slice(result.offset!,result.offset!+200));assert.ok(result.truncated)});
test('A three-stock normalized market payload keeps all instruments and timestamps intact',()=>{const body=JSON.stringify({instruments:['江丰电子','鼎龙股份','华大九天'].map(name=>({name,asOf:'2026-11-06',details:'数'.repeat(900)}))});const packed=packContext({current:{text:'比较这三只'},evidence:[{id:'market',level:'market',body}]});assert.equal(packed.evidence.length,1);assert.equal(packed.evidence[0].truncated,false);assert.equal(JSON.parse(packed.evidence[0].body).instruments.length,3)});
