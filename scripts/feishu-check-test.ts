import * as Lark from '@larksuiteoapi/node-sdk';
import '../server/notifications';
import {connection} from '../server/feishu/config';
import {profile,type Scope} from '../server/feishu/unified-store';
import {latestCheck,referenceCheck,checkText,sendCheckTest} from '../server/feishu/radar-checks';
import {platformText} from '../server/feishu/runtime';
const args=process.argv.slice(2),p=profile(),c=connection();
if(!p||!c)throw Error('先核验并启用统一群绑定');
const scope:Scope={app:p.appId,tenant:p.tenantKey,sender:p.ownerOpenId,chat:p.radarChatId,scene:'group',thread:'',generation:c.generation,eventId:'',messageId:''};
const index=args.indexOf('--run');
const check=index>=0?referenceCheck(scope,args[index+1]):latestCheck(scope);
if(!args.includes('--send-authorized')){console.log('预览，未发送。只有明确获得用户群测试授权后才能使用 --send-authorized。\n'+checkText(check));}
else {
 if(process.env.AGENT_TEST_MODE==='1'||p.environment!=='production')throw Error('隔离测试不能向真实飞书发送');
 Lark.defaultHttpInstance.defaults.timeout=15000;
 const client=new Lark.Client({appId:c.appId,appSecret:c.appSecret,logger:{error:()=>{},warn:()=>{},info:()=>{},debug:()=>{},trace:()=>{}}});
 const result=await sendCheckTest(scope,check.run_id,{download:async()=>{throw Error('unused')},reply:async()=>{throw Error('unused')},send:async(chat,text,uuid)=>{const result=await client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:chat,msg_type:'text',content:JSON.stringify({text:platformText(text)}),uuid}});return {code:result.code??-1,messageId:result.data?.message_id};}});
 console.log(JSON.stringify(result));if(result.status!=='sent')process.exitCode=1;
}
