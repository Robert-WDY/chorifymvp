import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {redactDebug} from './debug-trace.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function directoryIdentity(directory){const path=resolve(directory);return createHash('sha256').update(process.platform==='win32'?path.toLowerCase():path).digest('hex');}
export async function readDebugBody(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>65536)throw fail('请求超过 64KB',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('请求 JSON 无效');}}
export class DebugLiveBridge{
 constructor({backendUrl,source}){
  const u=new URL(backendUrl);if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw fail('实时后台必须是固定的本机 HTTP 地址');
  this.base=u.origin;this.source=source;
 }
 async config(){
  let res;try{res=await fetch(this.base+'/api/config',{redirect:'error',signal:AbortSignal.timeout(5000)});}catch{throw fail('创作后台未连接，请启动配套后台',503);}
  if(!res.ok)throw fail('无法读取创作后台配置',503);
  const config=await res.json();if(config.dataDirectoryId!==directoryIdentity(this.source.directory))throw fail('后台与调试台的数据目录不一致，已阻止发送',409);
  if(typeof config.csrf!=='string')throw fail('后台缺少有效会话令牌',503);return config;
 }
 async publicConfig(){const c=await this.config();return {enabled:true,available:true,backendUrl:this.base,source:this.source.id,model:c.model,provider:c.provider,businessActionMode:c.businessActionMode||'shadow',brainReady:!!c.brainReady,runtimeVersion:c.runtimeVersion||null,finalResponseComposer:c.finalResponseComposer===true};}
 async sessions(){await this.config();const res=await fetch(this.base+'/api/sessions?limit=200',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!res.ok)throw fail('读取实时会话列表失败',503);return redactDebug(await res.json());}
 async submit(req,res,payload,{cancel=false}={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fail('请求必须是对象');
  const allowed=cancel?['sessionId']:['sessionId','requestId','message','inputs'];
  if(Object.keys(payload).some(k=>!allowed.includes(k)))throw fail('存在未支持的提交字段');
  if(payload.sessionId!==undefined&&!uuid.test(payload.sessionId))throw fail('会话 ID 无效');
  if(cancel&&!payload.sessionId)throw fail('停止操作需要会话 ID');
  if(!cancel&&(!uuid.test(payload.requestId)||typeof payload.message!=='string'||!payload.message.trim()||payload.message.length>30000))throw fail('需要有效 requestId 和 1–30000 字指令');
  const c=await this.config();
  if(!cancel&&!c.brainReady)throw fail('后台尚未配置模型密钥',503);
  // One explicit browser submission = one existing backend POST. Never retry a POST.
  let upstream;try{upstream=await fetch(this.base+(cancel?'/api/cancel':'/api/chat'),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','x-mvp-token':c.csrf},body:JSON.stringify(payload)});}catch{throw fail('提交结果未知；请用原 Run ID 查看进度，不要重复发送',502);}
  if(!upstream.ok||cancel){const result=await upstream.json().catch(()=>({error:'后台响应无效'}));res.writeHead(upstream.status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(redactDebug(result)));return;}
  res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});res.flushHeaders();
  let buffer='';const decoder=new TextDecoder();
  const line=text=>{if(!text.trim()){if(!res.destroyed)res.write('\n');return;}const event=redactDebug(JSON.parse(text));if(!res.destroyed)res.write(JSON.stringify(event)+'\n');};
  try{for await(const chunk of upstream.body){buffer+=decoder.decode(chunk,{stream:true});let at;while((at=buffer.indexOf('\n'))>=0){line(buffer.slice(0,at));buffer=buffer.slice(at+1);}if(buffer.length>16*1024*1024)throw new Error('oversized_event');}buffer+=decoder.decode();if(buffer.trim())line(buffer);}
  catch{if(!res.destroyed)res.write(JSON.stringify({type:'debug_connection_error',message:'事件连接中断，正在观察原 Run；不会自动重发。'})+'\n');}
  finally{res.end();}
 }
}
