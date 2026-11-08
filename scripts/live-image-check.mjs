import {chromium} from '@playwright/test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {runDshModel} from '../runtime/dsh/dsh-adapter.mjs';
if(!process.argv.includes('--live'))throw Error('Requires --live');
const config=JSON.parse(readFileSync('data/credentials.json','utf8'));
const db=new DatabaseSync('data/agent.sqlite');db.exec('PRAGMA busy_timeout=10000');
const used=Number(db.prepare("SELECT COALESCE(SUM(tokens),0) n FROM usage WHERE created_at>=?").get(new Date().toISOString().slice(0,7)+'-01').n);
if(used+30000>config.monthlyTokens)throw Error('Not enough remaining token budget for the image check');
const usageId='validation-image:'+randomUUID();db.prepare('INSERT INTO usage VALUES(?,?,?,?,?)').run(usageId,null,'validation:reserved:'+config.model,30000,new Date().toISOString());
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1000,height:650},deviceScaleFactor:1});
 await page.setContent('<html lang="zh"><body style="font:28px -apple-system,sans-serif;padding:55px;color:#203b30;background:#fafbf7"><p style="font-size:18px;color:#896d47">测试样例 · 非真实公司或市场数据</p><h1>甲公司订单观察</h1><p>2026 年第三季度（测试）</p><hr/><p>新增订单：同比增长 <b>20%</b></p><p>净利润：同比下降 <b>10%</b></p><p style="font-size:22px">未提供：订单单价、毛利率、回款情况</p></body></html>');
 const bytes=await page.screenshot({path:'data/vision-fixture.png'});
 const result=await runDshModel({apiKey:config.apiKey,model:config.model,maxTokens:4096,timeoutMs:90000,prompt:'这是一张明确标注的测试图片。读取其中订单和利润的同比变化，解释能否仅由订单增长推导利润改善。只返回JSON {orders_percent:number,profit_percent:number,conclusion:string,missing:string[]}，不猜未给出的数据。',images:[{mimeType:'image/png',data:bytes.toString('base64')}]});
 const value=JSON.parse(result.text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
 if(value.orders_percent!==20||value.profit_percent!==-10||!value.missing?.length)throw Error('Image numeric or missing-information check failed');
 if(result.usageStatus==='reported')db.prepare('UPDATE usage SET model=?,tokens=? WHERE id=?').run('validation:'+config.model,result.usage.promptTokens+result.usage.completionTokens,usageId);
 writeFileSync('data/vision-validation.json',JSON.stringify({testedAt:new Date().toISOString(),fixture:'明确标注的测试样例，不是用户事实',model:config.model,result:value},null,2),{mode:0o600});
 console.log('PASS: real DSH/Kimi image reading, +20% orders / -10% profit, missing evidence preserved.');
}finally{await browser.close();db.close()}
