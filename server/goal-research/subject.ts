import {themeCatalog} from '../observation/themes';
// Only public stock names from the project's verified catalog can become outbound search terms.
export const filingQuestion=(text:string)=>/上市申请|申请(?:发行|上市)|提交.{0,10}上市|港股上市|发行H股|递表/i.test(text);
export const asksHistory=(text:string)=>/我的记忆|我记忆中|我.{0,5}(以前|之前|过去).{0,10}(研究|判断|看法)|上次|此前.*疑问|原来的问题/.test(text);
export function namedSubjects(text:string){
 return [...new Set(themeCatalog().flatMap(t=>t.members.filter(m=>m.verified&&text.includes(m.name)).map(m=>m.name)))];
}
