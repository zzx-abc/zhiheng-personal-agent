import {fixture} from './radar-frame';
/** 用户提供、未经本次独立行情核验的测试输入；生成日线只是精确复现数值，不是真实行情。 */
export const provenance='用户提供、未经本次独立行情核验的测试输入；其余日线为隔离合成数据';
export function r1Fixture(){
 const f=fixture('2026-11-13T10:07:56.000Z',0);f.provider=provenance;
 const values:Record<string,[number,number,number]>={sz301313:[70.79,.43,6.33],sz300613:[79.48,24.46,16.84],sz301536:[96.61,15.64,10.76],sz300666:[209.04,6.99,6.64],sh688019:[218,4.07,2.06],sz300054:[58.93,.89,-1.39]};
 for(const p of Object.values(f.points)){p.quoteAt='2026-11-13T08:14:00Z';const v=values[p.symbol];if(v){p.quote!.price=v[0];p.bars.at(-1)!.close=100;p.bars.at(-4)!.close=100/(1+v[1]/100);p.bars.at(-6)!.close=100/(1+v[2]/100);p.bars.forEach(b=>b.high=Math.max(b.high!,b.close));}}
 f.points.sh688836.quote=null;f.points.sh688836.bars=[];
 const t=f.themeConfigs!.find(t=>t.id==='semiconductor-local')!;
 // Intentionally put the risk object last to test ranking independently of configuration order.
 t.members.sort((a,b)=>Number(a.symbol==='sz300054')-Number(b.symbol==='sz300054'));
 t.priceLines=[['sz300666','above',205.16],['sh688019','above',222],['sz300054','below',60.55]].map(([symbol,direction,price])=>({symbol:String(symbol),direction:direction as 'above'|'below',price:Number(price),sourceDate:'2026-11-05',basis:'unadjusted',validUntil:null,comparability:'unverified',verification:'',verifiedThrough:null}));
 return f;
}
