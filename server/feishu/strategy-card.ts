/** Native v1 card, plain_text only. No unimplemented callbacks or unreachable mobile URLs. */
export function strategyCard(text:string){return {config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:'知衡｜策略观察'},template:'blue'},elements:text.split('\n').filter(x=>x&&x!=='知衡｜策略观察').map(content=>({tag:'div',text:{tag:'plain_text',content}}))};}
