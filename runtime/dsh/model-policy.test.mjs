import test from 'node:test';
import assert from 'node:assert/strict';
import {modelPolicy} from './model-policy.mjs';
test('K3 uses explicit low effort with provider compatibility override',()=>{
 for(const name of ['kimi-k3','kimi-k3.1-pro']){
  const p=modelPolicy(name);assert.equal(p.reasoningEffort,'low');assert.match(p.modelYaml,/supportsReasoningEffort: true/);assert.match(p.modelYaml,/thinkingFormat: openai/);
 }
});
test('K3 reasoning parameters are not sent to K2 or unknown models',()=>{
 for(const name of ['kimi-k2.6','kimi-k2.7-code','moonshot-v1-8k','kimi-k30'])assert.equal(modelPolicy(name).reasoningEffort,undefined);
});
