import test from 'node:test';
import assert from 'node:assert/strict';
import {dshRunError} from './run-error.mjs';
test('missing executor is actionable, without leaking model contents',()=>{
 const result={finishReason:'error',finalResponse:'PRIVATE MODEL CONTENT',events:[{type:'turn/end',data:{reason:{error:{message:'The selected tool executor is unavailable. Load an executor in this composition before running the agent.'}}}}]};
 assert.match(dshRunError(result),/执行器未就绪/);assert.ok(!dshRunError(result).includes('PRIVATE'));
});
test('provider diagnostics redact saved and bearer credentials',()=>{
 const result={finishReason:'error',events:[{type:'turn/end',data:{reason:{error:{message:'Provider rejected secret-key and Bearer abc123 and sk-example-secret'}}}}]};
 const message=dshRunError(result,'secret-key');
 for(const value of ['secret-key','abc123','sk-example-secret'])assert.ok(!message.includes(value));
});
test('truncated model output is not presented as success',()=>assert.match(dshRunError({finishReason:'length',events:[]}),/长度上限/));
