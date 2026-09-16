import {createHash} from 'node:crypto';
const hash=text=>createHash('sha256').update(text).digest('hex');
export const requestMessageId=(query,sessionId='',runId='')=>'msg_'+hash(JSON.stringify([sessionId,runId,query])).slice(0,20);
export const evidenceSpansSchema={type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['messageId','start','end'],properties:{messageId:{type:'string',minLength:1},start:{type:'integer',minimum:0},end:{type:'integer',minimum:1}}}};
export function validateTextInputs(inputs=[]){
 if(!Array.isArray(inputs)||inputs.length>12)throw new Error('文字输入最多 12 份');
 let size=0;for(const input of inputs){
  if(!input||typeof input.filename!=='string'||!input.filename.trim()||input.filename.length>200||typeof input.content!=='string'||!input.content.trim()||!['text/plain','application/json',undefined].includes(input.mimeType))throw new Error('文字输入需要文件名、正文和合法类型');
  size+=input.content.length;
 }if(size>100000||Buffer.byteLength(JSON.stringify(inputs))>48*1024)throw new Error('文字附件总大小超过 48KB；完整 HTTP 请求仍受 64KB 限制');return inputs;
}
export function registerRequestInputs(state,message,inputs=[]){
 validateTextInputs(inputs);const store=state.taskStore;store.inputs??={};
 const add=(content,filename,purpose,span,mimeType='text/plain')=>{
  const id='input_'+hash(JSON.stringify([state.id,message.messageId,filename,span,content])).slice(0,24);
  let structure;if(mimeType==='application/json'){try{const parsed=JSON.parse(content);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))structure=parsed;}catch{ /* Original text remains available; no invented parsed facts. */ }}
  store.inputs[id]??={id,assetId:id,type:'text',kind:'text',version:1,sessionId:state.id,filename,mimeType,content,contentHash:hash(content),...(structure?{metadata:{structure}}:{}),source:'用户提供',purpose,sourceMessageId:message.messageId,sourceSpan:span||null,createdAt:new Date().toISOString()};
  return id;
 };
 // Plain requests already live in the message ledger. Only concrete inline
 // blocks and explicit text attachments become input artifacts.
 const ids=[];
 for(const match of message.content.matchAll(/```([^\r\n]*)\r?\n([\s\S]*?)```/g)){
  const content=match[2];if(!content.trim())continue;
  const start=match.index+match[0].indexOf('\n')+1,header=match[1].trim();
  ids.push(add(content,header||'内联文字','source',{start,end:start+content.length},header==='json'?'application/json':'text/plain'));
 }
 for(const input of inputs)ids.push(add(input.content,input.filename,'source',null,input.mimeType));
 return ids;
}
export function bindRequestEvidence(semantic,{query,currentMessage,messages=[],previous}){
 const available=[...messages,currentMessage].filter(m=>m?.role==='user');
 for(const d of semantic.deliverables||[]){
  let spans=d.requestEvidenceSpans;
  if(!spans?.length){
   const quote=d.requestEvidence||query;
   const current=currentMessage.content.indexOf(quote);
   let source=current>=0?currentMessage:null;
   if(!source&&semantic.continuation?.mode!=='new'&&previous)source=available.find(m=>m.content===previous.query&&m.content.includes(quote));
   if(!source)throw Object.assign(new Error('请求证据不匹配用户原文；模型引用错误，不能拼接省略号或虚构位置'),{code:'evidence_binding',issues:[{path:'/deliverables/'+semantic.deliverables.indexOf(d)+'/requestEvidence'}]});
   const start=source.content.indexOf(quote);
   if(source.content.indexOf(quote,start+1)>=0)throw Object.assign(new Error('请求引文在同一消息中不唯一；提供可唯一定位的更完整连续原话，不猜字符位置'),{code:'evidence_binding',issues:[{path:'/deliverables/'+semantic.deliverables.indexOf(d)+'/requestEvidence'}]});
   spans=[{messageId:source.messageId,start,end:start+quote.length}];
  }
  d.requestEvidenceSpans=spans.map(span=>{
   const m=available.find(m=>m.messageId===span.messageId);
   if(!m||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start||span.end>m.content.length)throw Object.assign(new Error('请求证据位置不存在于真实用户消息'),{code:'evidence_binding',issues:[{path:'/deliverables/'+semantic.deliverables.indexOf(d)+'/requestEvidenceSpans'}]});
   return {...span};
  });
  if(semantic.continuation?.mode==='new'&&!d.requestEvidenceSpans.some(span=>span.messageId===currentMessage.messageId))throw Object.assign(new Error('新操作不能仅凭历史请求证据获得当前执行权限'),{code:'evidence_binding',issues:[{path:'/deliverables/'+semantic.deliverables.indexOf(d)+'/requestEvidenceSpans'}]});
  // Preserve separate excerpts rather than fabricating one allegedly literal quote.
  d.evidenceSegments=d.requestEvidenceSpans.map(span=>({...span,text:available.find(m=>m.messageId===span.messageId).content.slice(span.start,span.end)}));
  d.requestEvidence=d.evidenceSegments.length===1&&d.evidenceSegments[0].text.length<=1600?d.evidenceSegments[0].text:'';
 }
 return semantic;
}
