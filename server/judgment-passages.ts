// Labels are search hints. Only exact spans of the owner's words may be quoted.
const dimensions=[
 {kind:'rotation',label:'方向与标的选择 资金轮动 换仓',pattern:/轮动|换仓|想换|调仓|切换|换到|换成|换去|转到|轮到|资金进|涨的.{0,8}(别的|别人|其他)|方向.{0,10}(没错|看好|没变)|手里.{0,8}(不动|没动)|国产替代流动/},
 {kind:'basis',label:'最初关注 买入依据 量价观察',pattern:/放量|成交量.{0,5}(放大|变大)|开始观察|当初.{0,12}(看中|关注)|最初.{0,8}(理由|看中)/},
 {kind:'fundamental',label:'产业假设 业务兑现 经营证据',pattern:/国产替代|行业景气|订单|收入兑现|客户验收|扩产/},
 {kind:'horizon',label:'验证周期 计划改变 失效条件',pattern:/中线|长线|短线|证伪|失效条件|等.{0,5}(季报|财报)/},
 {kind:'momentum',label:'异动 追涨 犹豫',pattern:/想追|追高|突然拉|怕踏空|又怕|错过行情/}
];
export const motives=(s:string)=>dimensions.filter(d=>d.pattern.test(s));
export function judgmentPassages(text:string){
 if(/^(请核实|帮我查|请查询|转发|群里说|摘录)/.test(text.trim())||!/(?:我|当时|本来|原先|出来的资金|持有的原因)/.test(text))return [];
 const spans=(text.match(/[^。！？!?；\n]+[！？!?]?/g)||[])
  .filter(sentence=>!/[？?]$/.test(sentence)&&!/^\s*(如果|假设|假如|要是|听说|作者认为)/.test(sentence));
 return spans.flatMap(sentence=>{
  // Keep short adjacent clauses together, while allowing two different reasons in one paragraph.
  const parts=sentence.split(/(?<=[，,])(?=原因|后来|后面|但|可|我又|出来的资金|我把|于是)/);
  return parts.map(p=>p.trim().replace(/[，,]$/,'')).filter(p=>p.length>=6&&p.length<=500&&!/[“「]|他说|作者认为/.test(p))
   .map(quote=>({quote,dimensions:motives(quote)})).filter(x=>x.dimensions.length);
 });
}
export function wantsJudgment(text:string){
 if(/会计口径|会计准则|什么意思|名词解释|怎么计算|如何计算|翻译/.test(text)&&!/我当时|我之前/.test(text))return false;
 return /我当时|我之前|为什么.{0,4}关注|原来.{0,6}理由|当初.{0,8}(看中|关注|为什么)|又想|想换|想追|有点犹豫|涨的.{0,8}(别人|别的|其他)|手里.{0,8}(没动|不动)|我.{0,15}(换仓|换到|切换|调仓|踏空|要不要换)|方向.{0,8}(没错|还看好|没变|看好)/.test(text);
}
