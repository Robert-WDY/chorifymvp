// Responses SSE: only public output_text deltas are surfaced. Function argument
// fragments and reasoning are never exposed or dispatched as tool calls.
export async function readResponseStream(response,{onTextDelta,signal}={}){
 if(!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('供应商未返回声明支持的文本事件流');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',completed,total=0;
 async function frame(text){
  const data=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  if(!data||data==='[DONE]')return;
  const event=JSON.parse(data);
  if(['response.failed','response.incomplete','error'].includes(event.type))throw new Error('模型事件流未完成；没有执行工具参数');
  if(event.type==='response.output_text.delta'&&typeof event.delta==='string')await onTextDelta?.(event.delta);
  if(event.type==='response.completed'){
   if(completed||!event.response||event.response.status!=='completed'||!Array.isArray(event.response.output))throw new Error('模型完成事件无效');
   completed=event.response;
  }
 }
 try{
  while(true){signal?.throwIfAborted();const {done,value}=await reader.read();total+=value?.byteLength||0;if(total>4*1024*1024)throw new Error('模型事件流超出读取预算');
   buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});buffer=buffer.replace(/\r\n/g,'\n');let end;
   while((end=buffer.indexOf('\n\n'))!==-1){const next=buffer.slice(0,end);buffer=buffer.slice(end+2);await frame(next);}
   if(buffer.length>1024*1024)throw new Error('模型事件分片超出读取预算');
   if(done){if(buffer.trim())await frame(buffer);break;}
  }
  if(!completed)throw new Error('模型事件流截断，公开文字未完成；工具参数未执行');
  return completed;
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
