import {label} from './readable.mjs';
const root=document.querySelector('#live-console');
const node=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const key='chorify.debug.pending.v1';let config=null,pending=null,inFlight=false,polling=false,transportUnknown=false,lastHash='',eventsSeen=new Set();
try{pending=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
const save=()=>{try{if(pending)sessionStorage.setItem(key,JSON.stringify(pending));else sessionStorage.removeItem(key);}catch{}};
const header=node('div','','live-heading'),title=node('h2','发送指令 · 实时调试'),connection=node('span','连接后台中…','muted');
header.append(title,connection);
const form=node('form'),controls=node('div','','toolbar'),session=node('select');session.setAttribute('aria-label','实时测试会话');session.append(new Option('新建会话',''));
const reconnect=node('button','重新连接');reconnect.type='button';reconnect.addEventListener('click',()=>connect());
const message=node('textarea');message.rows=3;message.maxLength=30000;message.placeholder='输入你的指令，例如：给白色咖啡杯写三句广告文案，先不生成图片。';message.setAttribute('aria-label','调试指令');
const send=node('button','发送并跟随');send.type='submit';const cancel=node('button','停止本轮');cancel.type='button';cancel.disabled=true;
const mode=node('span','Enter 发送 · Shift+Enter 换行。发送后使用当前模型与工具账户。','muted');
const status=node('p','尚未发送指令。','live-status'),meta=node('p','','muted'),follow=node('a','查看本轮执行过程');follow.hidden=true;
const ids=node('pre'),idDetails=node('details');idDetails.append(node('summary','本轮技术标识'),ids);
const feed=node('ol','','live-feed'),feedDetails=node('details');feedDetails.open=true;feedDetails.append(node('summary','本轮事件与执行进度'),feed);
controls.append(session,reconnect,send,cancel);form.append(message,controls,mode);root.append(header,form,status,follow);
function sync(){send.disabled=!config?.available||!config?.brainReady||inFlight||!!pending;session.disabled=inFlight||!!pending;cancel.disabled=!pending||!config?.available;}
function log(text){const li=node('li',new Date().toLocaleTimeString()+'　'+text);feed.append(li);while(feed.children.length>100)feed.firstChild.remove();}
function runUrl(p){return '#detail?'+new URLSearchParams({runId:p.runId,sessionId:p.sessionId,source:p.source});}
function apiUrl(p){return '/api/debug/run/'+p.runId+'?'+new URLSearchParams({sessionId:p.sessionId,source:p.source});}
function attach(p){follow.href=runUrl(p);follow.hidden=false;meta.textContent='正在跟随本轮执行过程';ids.textContent='Session: '+p.sessionId+'\nRun: '+p.runId;}
async function sessions(preferred){try{const res=await fetch('/api/debug/live/sessions');if(!res.ok)return;const data=await res.json();session.replaceChildren(new Option('新建会话',''));for(const s of data.sessions||[])session.add(new Option((s.title||'未命名会话')+' · '+label(s.status),s.id));if(preferred&&!Array.from(session.options).some(o=>o.value===preferred))session.add(new Option('当前会话 · '+preferred,preferred));session.value=preferred||'';}catch{/* Connection status is reported by config/poll. */}}
async function connect(){
 connection.textContent='连接后台中…';try{const res=await fetch('/api/debug/live/config');config=await res.json();const version=config.runtimeVersion;connection.textContent=config.available?config.model+' · '+(version?(version.matches?'运行代码与磁盘一致':'后台仍运行旧代码，请更新服务')+' · 启动于 '+new Date(version.startedAt).toLocaleTimeString():'旧后台未提供代码版本')+(config.finalResponseComposer?' · 已启用最终回答阶段':' · 未启用最终回答阶段'):config.error||'只读模式：未配置实时后台';if(config.available){
  if(pending&&pending.source!==config.source){pending=null;save();}
  // Recover from the explicit Run URL as well: storage can be unavailable in embedded browsers.
  const params=new URLSearchParams(location.hash.split('?')[1]||'');
  if(!pending&&params.get('source')===config.source&&/^[a-f0-9-]{36}$/.test(params.get('runId')||'')&&/^[a-f0-9-]{36}$/.test(params.get('sessionId')||'')){
   pending={runId:params.get('runId'),sessionId:params.get('sessionId'),source:config.source};save();
  }
  await sessions(pending?.sessionId||session.value);if(pending){attach(pending);status.textContent='恢复观察原 Run，不重复发送。';poll();}
 }}catch{config=null;connection.textContent='调试服务无法连接';}sync();
}
function consume(event){
 const id=event.eventId;if(id&&eventsSeen.has(id))return;if(id)eventsSeen.add(id);
 if(event.type==='debug_connection_error'){transportUnknown=true;status.textContent=event.message;log(event.message);return;}
 const descriptions={start:'请求已受理',intent:'需求合同已接受',intent_error:'需求校验失败',execution_plan:'执行计划更新',task_state:'任务状态更新',tool_start:'开始工具',tool_result:'工具返回',plan_progress:'节点进度更新',final:'本轮返回'};
 log((descriptions[event.type]||label(event.type.toUpperCase()))+(event.name?' · '+label(event.name):'')+(event.status?' · '+label(event.status):'')+(event.error?' · '+event.error:''));
 if(event.type==='start'&&pending){location.hash=runUrl(pending);}
 if(event.type==='final'){status.textContent='本轮返回：'+event.status+'。正在读取最终 Trace。';}
 poll();
}
async function poll(){
 if(polling||!pending||!config?.available)return;polling=true;const target=pending;
 try{
  const res=await fetch(apiUrl(target));if(pending!==target)return;
  if(res.status===404){status.textContent=transportUnknown?'尚无落盘记录；提交结果未知，请勿重复发送。':'等待后台受理与首份 Trace…';return;}
  if(!res.ok)throw new Error('Trace 暂时读取失败');const r=await res.json();if(pending!==target)return;
  for(const t of r.timeline||[])if(t.data?.eventId)consumeRecorded(t.data);
  const running=r.contextSnapshots.filter(c=>!c.output&&!c.error).length;
  status.textContent=(r.finalResponse.source==='recorded_final_event'?'本轮已返回：':'执行状态：')+label(r.status)+' · 模型 '+r.contextSnapshots.length+' 次'+(running?'（'+running+' 次等待返回）':'')+' · 工具 '+r.tools.length+' 次';
  if(transportUnknown&&r.finalResponse.source!=='recorded_final_event')status.textContent+=' · 事件流已断开，继续读取持久 Trace';
  meta.textContent='本轮过程更新于 '+new Date().toLocaleTimeString();ids.textContent='Session: '+r.sessionId+'\nRun: '+r.runId;
  attachLinkOnly(target);
  if(lastHash!==r.evidence.sha256){lastHash=r.evidence.sha256;window.dispatchEvent(new CustomEvent('debug:trace',{detail:r}));}
  if(r.finalResponse.source==='recorded_final_event'){
   const sid=target.sessionId;pending=null;save();cancel.disabled=true;sync();await sessions(sid);
  }
 }catch{if(pending===target)status.textContent='暂时无法读取 Trace，稍后自动重连；不会重发指令。';}
 finally{polling=false;}
}
function attachLinkOnly(p){follow.href=runUrl(p);follow.hidden=false;}
function consumeRecorded(e){if(e.eventId&&eventsSeen.has(e.eventId))return;if(e.eventId)eventsSeen.add(e.eventId);log(label(e.type.toUpperCase())+(e.name?' · '+label(e.name):'')+(e.status?' · '+label(e.status):''));}
form.addEventListener('submit',async e=>{
 e.preventDefault();if(inFlight||pending||!config?.available||!config.brainReady)return;const text=message.value.trim();if(!text){message.focus();return;}
 const requestId=crypto.randomUUID(),sessionId=session.value||requestId,body={requestId,message:text,...(session.value?{sessionId}: {})};
 pending={runId:requestId,sessionId,source:config.source};save();attach(pending);inFlight=true;transportUnknown=false;lastHash='';eventsSeen=new Set();feed.replaceChildren();sync();status.textContent='正在提交指令…';
 try{
  const res=await fetch('/api/debug/live/chat',{method:'POST',headers:{'Content-Type':'application/json','x-debug-token':config.csrf},body:JSON.stringify(body)});
  if(!res.ok){const d=await res.json();if(res.status<500){pending=null;save();}else transportUnknown=true;throw new Error(d.error||'请求未成功');}
  message.value='';const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='';
  for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(line)consume(JSON.parse(line));}}
  buffer+=decoder.decode();if(buffer.trim())consume(JSON.parse(buffer));
 }catch(err){status.textContent=err.message||'连接中断，继续观察原 Run。';log(status.textContent);if(pending)transportUnknown=true;}
 finally{inFlight=false;sync();poll();}
});
message.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!send.disabled)form.requestSubmit();}});
cancel.addEventListener('click',async()=>{if(!pending)return;cancel.disabled=true;try{const res=await fetch('/api/debug/live/cancel',{method:'POST',headers:{'Content-Type':'application/json','x-debug-token':config.csrf},body:JSON.stringify({sessionId:pending.sessionId})});const d=await res.json();if(!res.ok)throw new Error(d.error);status.textContent='已请求停止本轮，等待后台记录最终状态。';log(status.textContent);}catch(e){status.textContent=e.message;}finally{sync();poll();}});
// Explicit adoption of an existing live session; archive sessions cannot be submitted.
window.addEventListener('debug:continue-session',async e=>{if(pending||inFlight)return;if(e.detail.source!==config?.source){status.textContent='这是只读归档。请新建实时会话发送指令。';return;}await sessions(e.detail.sessionId);message.focus();root.scrollIntoView({behavior:'smooth',block:'start'});});
setInterval(()=>{if(!document.hidden)poll();},2000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
sync();
connect();
