import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.AGENT_DATA_DIR=mkdtempSync(path.join(tmpdir(),'zhiheng-intake-test-'));
const {intakeSchema,resolveIntakeRoute,intakeContext}=await import('../server/intake');
const {db}=await import('../server/db');
test('A declared need for market evidence executes tools even when comparison also needs review',()=>{
 const plan=intakeSchema.parse({route:'review',data_need:'market_data',review_required:true,understanding:'核对三只股票',first_help:'需要同一窗口行情',focus:null,followup:null,pause_focus:false,reply:null});
 const resolved=resolveIntakeRoute(plan);assert.equal(resolved.route,'check');assert.equal(resolved.review_required,true);
 const correction=resolveIntakeRoute({...plan,route:'chat',data_need:'none',review_required:false});assert.equal(correction.route,'chat');
});
test('Task understanding preserves the current request while omitting bulk historical market evidence',()=>{
 const current={id:'r',text:'当前需要比较三只股票'};
 const full={current,workingState:{thesis:{text:'旧假设'},assessment:'a'.repeat(2000)},history:Array.from({length:10},()=>({text:'x'.repeat(1000)})),retrievedCards:Array.from({length:6},()=>({body:'y'.repeat(1000)})),previousEvidence:[{body:'旧样本行情'.repeat(2000)}]};
 const packed=JSON.parse(intakeContext(JSON.stringify(full)));assert.deepEqual(packed.current,current);assert.equal(packed.history.length,2);assert.equal(packed.retrievedCards.length,4);assert.equal(packed.previousEvidence.length,0);assert.ok(JSON.stringify(packed).length<4000);
});
test.after(()=>{db.close();rmSync(process.env.AGENT_DATA_DIR!,{recursive:true,force:true})});
