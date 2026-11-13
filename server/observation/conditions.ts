/** Evidence states are not booleans. Omitted/disabled requirements never pass implicitly. */
export type ConditionStatus='PASS'|'FAIL'|'UNKNOWN'|'NOT_APPLICABLE'|'DISABLED';
export type EvidenceRef={source:string;availableAt:string|null;frameId:string;operand:string};
export type Atom={id:string;label:string;status:ConditionStatus;actual:number|null;threshold:number|null;unit:string;window:{start:string|null;end:string|null};quality:'valid'|'missing'|'invalid'|'not_applicable'|'disabled';reasons:string[];evidence:EvidenceRef[]};
export type Combination={status:ConditionStatus;operator:'AND'|'OR';required:string[];failed:string[];blocked:string[]};
export const statusLabel:Record<ConditionStatus,string>={PASS:'满足',FAIL:'未满足',UNKNOWN:'待核验',NOT_APPLICABLE:'本模式不适用',DISABLED:'配置已关闭'};
export function combine(operator:'AND'|'OR',atoms:Pick<Atom,'id'|'status'>[]):Combination{
 const failed=atoms.filter(a=>a.status==='FAIL').map(a=>a.id),blocked=atoms.filter(a=>!['PASS','FAIL'].includes(a.status)).map(a=>a.id);
 const status=operator==='AND'?(failed.length?'FAIL':!atoms.length||blocked.length?'UNKNOWN':'PASS'):(atoms.some(a=>a.status==='PASS')?'PASS':!atoms.length||blocked.length?'UNKNOWN':'FAIL');
 return {status,operator,required:atoms.map(a=>a.id),failed,blocked};
}
export function conditionLabel(c:{status?:ConditionStatus;met:boolean|null;combination?:Combination}){const s=c.status|| (c.met===null?'UNKNOWN':c.met?'PASS':'FAIL');return statusLabel[s]+(s==='FAIL'&&c.combination?.blocked.length?'，另有待核验项':'');}
