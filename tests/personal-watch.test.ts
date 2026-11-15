import test from 'node:test';
import assert from 'node:assert/strict';
import {entryVerdict,thirdSession,lotsAllowed,type Frame,type Rules} from '../server/personal-watch/rules';
import {minutes} from '../server/personal-watch/feed';
// Deliberately synthetic securities and levels.
const r:Rules={stock:{name:'样例甲',symbol:'sz000001'},peers:[{name:'样例乙',symbol:'sz000002'},{name:'样例丙',symbol:'sz000003'}],floor:10,zoneTop:10.5,repairLow:10.5,cap:11,stop:9,trimLow:12,trimHigh:13,target:14,timeLevel:11.5,percent:4};
function series():Frame{
 const bars=Array.from({length:225},(_,i)=>{
  const end=i<120?571+i:781+i-120;
  const open=end<855?10.3:end<=870?10.55:10.7;
  return {end,open,low:open-.05,high:open+.1,close:open+.05,lots:10,amount:open*1000};
 });
 return {bars,price:10.8,low:10.25,prev:10.7,at:'2026-11-13T14:45:10+08:00'};
}
test('complete entry; breach then recovery, direct rally, ambiguous order, peer divergence',()=>{
 const verdict=(f:Frame,peers=[series(),series()])=>entryVerdict(r,f,peers,885);
 assert.equal(verdict(series()).state,'entry');
 const f=series();f.bars[2].low=9.99;assert.equal(verdict(f).state,'invalid');
 const direct=series();direct.bars[0].open=11.2;assert.equal(verdict(direct).state,'invalid');
 const ambiguous=series();Object.assign(ambiguous.bars[0],{open:10.9,high:11.1});assert.equal(verdict(ambiguous).state,'unknown');
 const weak=series();weak.price=9;weak.low=9;assert.equal(verdict(series(),[series(),weak]).state,'waiting');
 const vwap=series();vwap.bars[180].amount*=20;assert.equal(verdict(vwap).state,'waiting');
 assert.equal(verdict(series(),[]).state,'unknown');
});
test('minute gaps, malformed amounts and incomplete session fail closed',()=>{
 const row='2026-11-13 09:31,20,21,21,20,10,20500';
 assert.equal(minutes([row],'2026-11-13',571).length,1);
 for(const rows of [[],[row,row],[row.replace('20500','205')],[row.replace('09:31','09:32')]])assert.throws(()=>minutes(rows,'2026-11-13',571));
 assert.equal(thirdSession('2026-11-13'),'2026-11-18');assert.equal(lotsAllowed(1000,r),0);
});
