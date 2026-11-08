import {test} from 'node:test';import assert from 'node:assert/strict';import{summarizeDshUsage}from'./usage.mjs';
// Explicit synthetic accounting fixtures, never presented as AI results.
test('cache counts disjoint and usage chunk counted once per attempt',()=>{
 const result=summarizeDshUsage([{type:'assistant/message',data:{usage:{inputTokens:10,outputTokens:20,cacheReadTokens:30},message:{source:{model:'fixture'}},stream:[{type:'chunk',chunk:{type:'usage',usage:{inputTokens:10,outputTokens:20,cacheReadTokens:30}}}]}}]);
 assert.equal(result.usage.promptTokens,40);assert.equal(result.usage.completionTokens,20);assert.equal(result.model,'fixture');assert.equal(result.usageStatus,'reported');
});
test('missing accounting remains unknown or partial',()=>{
 assert.equal(summarizeDshUsage([]).usage,null);
 assert.equal(summarizeDshUsage([{type:'assistant/attempt',data:{}},{type:'assistant/message',data:{usage:{inputTokens:1,outputTokens:2}}}]).usageStatus,'partial');
});
test('failed attempt with final usage included',()=>{
 const r=summarizeDshUsage([{type:'assistant/attempt',data:{stream:[{type:'chunk',chunk:{type:'usage',usage:{inputTokens:2,outputTokens:3}}}]}}]);assert.equal(r.usage.promptTokens,2);
});
