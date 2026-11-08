import { runDshModel } from './dsh-adapter.mjs';
console.log(await runDshModel({handshakeOnly:true,timeoutMs:30000}));
const control=new AbortController();control.abort();
try { await runDshModel({handshakeOnly:true,signal:control.signal}); throw new Error('Abort check failed'); }
catch(e) { if(e.message!=='DSH_ABORTED') throw e; console.log('PASS: pre-aborted request refused'); }
try { await runDshModel({prompt:'no key'}); throw new Error('Missing key check failed'); }
catch(e) { if(e.message!=='KIMI_API_KEY_MISSING') throw e; console.log('PASS: missing key refused without runtime/model'); }
