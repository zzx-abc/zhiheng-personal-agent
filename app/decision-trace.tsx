'use client';
import type {WorkingState} from '../server/working-state';
const names={initial:'开始梳理',new_evidence:'补充了信息',thesis_revision:'依据发生变化',plan_change:'计划发生变化',correction:'理解已修正',result_only:'补充了结果',unresolved:'仍需分清'};
export function DecisionTrace({state,current,openSource}:{state:WorkingState;current:boolean;openSource:(id:string)=>void}){
 const frame=state.decision_frame;if(!frame||!Object.values(frame).some(Boolean))return null;
 return <section className="decision-trace" aria-label="这件事的判断脉络"><div className="card-meta"><span>{current?'这件事，先记住这条线':'当时整理的判断脉络 · 历史版本'}</span></div>
 {state.logic_change&&<p className="logic-change"><strong>{names[state.logic_change.kind]}</strong> · {state.logic_change.summary}</p>}
 <dl>{([['original_basis','原来的依据'],['change_trigger','这次的触发'],['contemplated_change','考虑的调整']] as const).map(([key,label])=>frame[key]&&<div key={key}><dt>{label}</dt><dd><button onClick={()=>openSource(frame[key]!.source_id)}>“{frame[key]!.quote}”</button></dd></div>)}</dl>
 <details><summary>核对周期、条件与实际行动</summary><dl>{([['evaluation_horizon','观察周期'],['validation_condition','验证条件'],['invalidation_condition','失效条件'],['reported_action','你报告的行动']] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{frame[key]?<button onClick={()=>openSource(frame[key]!.source_id)}>“{frame[key]!.quote}”</button>:<span className="muted">当前整理中未明确</span>}</dd></div>)}</dl><p className="muted">来自你的原话；观察周期不等于承诺持有，考虑调整不等于已经成交。可以直接说“这里理解错了”。</p></details>
 </section>;
}
