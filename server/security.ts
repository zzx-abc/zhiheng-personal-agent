import type { NextRequest } from 'next/server';
export function guard(req:NextRequest) {
 const host=req.headers.get('host')?.split(':')[0];
 if (!host || !['localhost','127.0.0.1','['].includes(host)) throw new Error('首版仅允许本机访问。手机接入需要先配置 HTTPS 和身份验证。');
 const origin=req.headers.get('origin');
 if(origin && origin !== new URL(req.url).origin && origin !== `http://${req.headers.get('host')}`) throw new Error('跨站请求已拒绝');
 const site=req.headers.get('sec-fetch-site');
 if(site==='cross-site') throw new Error('跨站请求已拒绝');
}
export function safePublicUrl(raw:string) {
 let u:URL; try{u=new URL(raw)}catch{return false;}
 if(u.protocol!=='https:' || u.username || u.password || u.port) return false;
 const h=u.hostname.toLowerCase();
 return ['cninfo.com.cn','sse.com.cn','szse.cn','bse.cn'].some(d=>h===d || h.endsWith('.'+d));
}
