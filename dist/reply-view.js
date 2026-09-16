// Presentation-only decoding. Raw messages, artifacts and Trace stay unchanged.
// Code spans, fenced code and quoted strings retain intentional escapes.
export function finalReplyStatus(status){
 return ({failed:'本轮未执行完成',blocked:'本轮有未完成步骤',needs_input:'需要补充必要信息',waiting:'等待确认或执行结果',interrupted:'本轮执行已中断',cancelled:'本轮已停止'})[status]||'';
}
export function renderFinalReply(node,text,status){
 node.className='bubble assistant';
 renderAssistantReply(node,text);
 const label=finalReplyStatus(status);
 if(label){const badge=document.createElement('p');badge.className='reply-status';badge.textContent=label;node.prepend(badge);}
}
export function assistantProse(text){
 return String(text??'').replace(/(\x60{3}[\s\S]*?\x60{3}|\x60[^\x60]*\x60|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\\r\\n|\\n|\\([_*])/g,(match,code,escaped)=>code||escaped||'\n');
}
export function renderAssistantReply(node,text){
 const normalized=assistantProse(text);
 node.replaceChildren();
 const tokens=/(\x60{3}[\s\S]*?\x60{3}|\x60[^\x60]*\x60|\*\*[^*]+\*\*)/g;
 let offset=0;
 for(const match of normalized.matchAll(tokens)){
  node.append(document.createTextNode(normalized.slice(offset,match.index)));
  const token=match[0],element=document.createElement(token.startsWith('**')?'strong':'code');
  element.textContent=token.startsWith(String.fromCharCode(96).repeat(3))?token.slice(3,-3):token.startsWith('**')?token.slice(2,-2):token.slice(1,-1);
  node.append(element);offset=match.index+token.length;
 }
 node.append(document.createTextNode(normalized.slice(offset)));
}
