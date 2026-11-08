/** Search engines can return crawl dates as publication dates. Only expose the
 * dated official URL separately, and never silently treat search metadata as it. */
export function assessSourceTime(url:string,searchDate:unknown,begin:Date,end:Date){
 const pathname=new URL(url).pathname;
 const iso=pathname.match(/\/(20\d{2}-\d{2}-\d{2})(?:\/|_)/)?.[1];
 const compact=pathname.match(/[_/](20\d{2})(\d{2})(\d{2})(?:[_./])/);
 const candidate=iso||(compact?`${compact[1]}-${compact[2]}-${compact[3]}`:null);
 const valid=(s:string|null)=>!!s&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 const pathDate=valid(candidate)?candidate:null;
 const indexed=typeof searchDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(searchDate)&&valid(searchDate)?searchDate:null;
 const day=pathDate||indexed;
 const outside=!!day&&(day<begin.toISOString().slice(0,10)||day>end.toISOString().slice(0,10));
 return {pathDate,outside,uncertain:!pathDate,note:`来源时效：URL路径日期 ${pathDate||'未知'}；搜索返回日期 ${indexed||'未知'}。路径日期和搜索日期不等于已核对的原文发布日期。`};
}
