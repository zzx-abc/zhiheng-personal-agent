// Text-layer extraction only. No rendering, document scripts or external requests.
import {readFileSync} from 'node:fs';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
const input=readFileSync(0);let result;
try{const loading=getDocument({data:new Uint8Array(input),isEvalSupported:false,disableFontFace:true,useSystemFonts:false,verbosity:0});const doc=await loading.promise;const pages=[],unread=[];let total=0;
 for(let n=1;n<=Math.min(doc.numPages,100);n++){try{const page=await doc.getPage(n),content=await page.getTextContent();const text=content.items.map(x=>'str'in x?x.str+(x.hasEOL?'\n':' '):'').join('').trim();total+=text.length;if(total>500000){unread.push(n);break;}if(text.length<15)unread.push(n);else pages.push({page:n,text});page.cleanup();}catch{unread.push(n);}}
 const read=new Set(pages.map(p=>p.page));for(let n=1;n<=doc.numPages;n++)if(!read.has(n)&&!unread.includes(n))unread.push(n);
 result={pages,totalPages:doc.numPages,unreadPages:unread,notice:'物理页码，从1开始；只读取文字层，图片、扫描页和图表视觉关系未解析，表格数字需对照原件'};await loading.destroy();
}catch{result={error:'PDF无法读取：可能加密、损坏或超出资源限制'};}
process.stdout.write('\nZH_RESULT\n'+JSON.stringify(result));
