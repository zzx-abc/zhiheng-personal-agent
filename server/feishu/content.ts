// Normalize inbound rich text, not the outgoing message/card schema.
export type Attachment={key:string;name:string;type:'file'|'image'};
export function readPost(raw:any){
 const post=raw?.content||raw?.content_v2?raw:raw?.zh_cn||raw?.en_us||{};
 const attachments:Attachment[]=[],unsupported=new Set<string>(),lines:string[]=[];
 function add(value:any,type:'file'|'image'){
  if(value?.is_folder){unsupported.add('文件夹');return;}
  const key=type==='image'?value?.image_key:value?.file_key;
  if(typeof key!=='string'||!key.trim()){unsupported.add('缺少标识的附件');return;}
  if(!attachments.some(x=>x.key===key))attachments.push({key,name:typeof value.file_name==='string'?value.file_name:type==='image'?'图片附件':'文件附件',type});
 }
 if(typeof post.title==='string'&&post.title.trim())lines.push(post.title);
 const blocks=Array.isArray(post.content_v2)?post.content_v2:post.content;
 if(Array.isArray(blocks))for(const block of blocks){
  if(!Array.isArray(block)){unsupported.add('未知段落');continue;}
  let text='';for(const node of block){switch(node?.tag){
   case 'text':case 'md':case 'code_block':text+=typeof node.text==='string'?node.text:'';break;
   case 'a':text+=(typeof node.text==='string'?node.text:'')+(typeof node.href==='string'?' '+node.href:'');break;
   case 'img':add(node,'image');break;
   case 'file':add(node,'file');break;
   case 'at':case 'emotion':break;
   case 'hr':text+='\n';break;
   default:unsupported.add('未接入的内容');
  }}if(text.trim())lines.push(text.trim());
 }
 // Current desktop client sends attachment cards here, outside the paragraphs.
 if(Array.isArray(post.files))for(const file of post.files)add(file,'file');
 if(post!==raw&&Array.isArray(raw?.files))for(const file of raw.files)add(file,'file');
 return {text:lines.join('\n').trim(),attachments,unsupported:[...unsupported]};
}
