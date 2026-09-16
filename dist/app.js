import {displayReply} from './fact-display.js';
import {renderAssistantReply,renderFinalReply} from './reply-view.js';
const $ = selector => document.querySelector(selector);
let config, sessionId = sessionStorage.getItem('creative-session'), busy = false;
let pollTimer;
let historyRequest=0,historyOffset=0,historyQuery='',historyDebounce;
let historyEntries=[];
const drafts=new Map();
let renderedEvents=0,renderedUsers=0,viewRevision=0,followTail=true,scrollPending=false;
const workspace=$('#workspace');
workspace.addEventListener('scroll',()=>{followTail=workspace.scrollHeight-workspace.clientHeight-workspace.scrollTop<80;});
function scrollToLatest(){
 if(!followTail||scrollPending)return;scrollPending=true;
 requestAnimationFrame(()=>{scrollPending=false;if(followTail)workspace.scrollTop=workspace.scrollHeight;});
}
new ResizeObserver(scrollToLatest).observe($('#chat'));
const taskPanelExpansion=new Map();
const calls = new Map();
const taskLabels={PENDING:'用户要求尚未完成，可继续',PLANNING:'正在规划',EXECUTING:'正在执行',VERIFYING:'正在检查',COMPLETED:'交付已齐',PARTIAL:'部分完成，可继续',WAITING:'生成中',WAIT_CONFIRM:'等待确认方案',NEEDS_INPUT:'需要补充信息',BLOCKED:'暂时无法继续',FAILED:'执行失败',REFUSED:'无法执行',CANCELLED:'已停止'};
function element(tag,text){const node=document.createElement(tag);node.textContent=text||'';return node;}
function toggleHistory(open){document.body.classList.toggle('history-open',open);$('#history-overlay').hidden=!open;$('#history-toggle').setAttribute('aria-expanded',String(open));}
function renderHistory(){
 const list=$('#history-list');list.replaceChildren();
 if(!historyEntries.length){const empty=element('p',historyQuery?'没有匹配的对话':'还没有历史对话');empty.className='history-empty';list.append(empty);}
 for(const entry of historyEntries){
  const button=element('button');button.type='button';button.className='history-item';button.dataset.sessionId=entry.id;button.title=entry.title;button.disabled=busy;
  if(entry.id===sessionId){button.classList.add('active');button.setAttribute('aria-current','page');}
  const title=element('span',entry.title);title.className='history-title';
  const preview=element('span',entry.preview);preview.className='history-preview';
  const date=new Date(entry.updatedAt),time=Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);
  const meta=element('span',`${time} · ${entry.turnCount} 轮${entry.status==='running'?' · 进行中':''}`);meta.className='history-meta';
  button.append(title,preview,meta);button.addEventListener('click',()=>openSession(entry.id));list.append(button);
 }
}
async function loadHistory({more=false}={}){
 const query=$('#history-search').value.trim();more=more&&query===historyQuery;
 const request=++historyRequest,offset=more?historyOffset:0;
 $('#history-refresh').disabled=true;$('#history-more').disabled=true;
 try{
  const response=await fetch('/api/sessions?'+new URLSearchParams({q:query,offset:String(offset),limit:'50'}));if(!response.ok)throw new Error('历史对话暂时无法读取');
  const result=await response.json();if(request!==historyRequest)return;
  historyQuery=query;historyEntries=more?[...historyEntries,...result.sessions]:result.sessions;historyOffset=offset+result.sessions.length;
  renderHistory();$('#history-more').hidden=!result.hasMore;
 }catch(error){if(request!==historyRequest)return;const notice=element('p',error.message+'，请点击刷新重试。');notice.className='history-empty';$('#history-list').replaceChildren(notice);$('#history-more').hidden=true;}
 finally{if(request===historyRequest){$('#history-refresh').disabled=false;$('#history-more').disabled=false;}}
}
async function openSession(id){
 if(busy)return;if(id===sessionId&&renderedEvents){toggleHistory(false);return;}
 drafts.set(sessionId||'new',$('#message').value);viewRevision++;clearTimeout(pollTimer);setBusy(true);
 sessionId=id;sessionStorage.setItem('creative-session',id);renderedEvents=0;renderedUsers=0;calls.clear();taskPanelExpansion.clear();followTail=true;
 $('#chat').replaceChildren();renderTask(null);$('#message').value=drafts.get(id)||'';renderHistory();toggleHistory(false);
 let status;
 try{status=await restore();}catch(error){add('p','notice',`读取对话失败：${error.message}。请重新选择该对话重试。`);}
 finally{setBusy(status==='running');renderHistory();}
}
function renderTask(task){
 const diagnostics=(task?.artifacts||[]).filter(a=>a.purpose==='deliverable').flatMap(a=>a.acceptance?.constraintChecks?.checks||[]).filter(c=>c.status==='failed');
 const panel=$('#task-panel');panel.replaceChildren();panel.hidden=!task||!diagnostics.length&&['COMPLETED','SIMULATED'].includes(task.status);if(panel.hidden)return;
 const row=element('div');row.className='task-status-row';
 const details=element('details');details.className='task-status-details';details.open=taskPanelExpansion.get(task.id)??task.status==='WAIT_CONFIRM';
 const summary=element('summary');summary.append(element('strong',task.supersededBy?'已由修订任务接替':taskLabels[task.status]||task.status));
 const title=element('span',task.goal?.summary||'任务进度');title.className='task-status-title';title.title=task.goal?.summary||'';summary.append(title);details.append(summary);
 const body=element('div');body.className='task-status-body';
 for(const item of task.items||[]){const completed=(task.artifacts||[]).filter(a=>a.itemId===item.id&&a.purpose==='deliverable'&&!['superseded','audit'].includes(a.publication)&&a.type===item.output&&(task.validationPolicy==='strict'?a.verification.semantic==='passed':a.verification.semantic!=='failed')).reduce((n,a)=>n+(a.type==='text'&&Number.isInteger(a.metadata?.unitCount)&&a.metadata.unitCount>0?a.metadata.unitCount:1),0);body.append(element('p',item.description+(task.verification?.quality==='not_evaluated'?' · 流程完成（内容未验收） ':' · 验收 ')+completed+'/'+item.count+' · '+(taskLabels[item.status]||item.status)));}
 if(task.executionPlan){const steps=element('details');steps.append(element('summary','已保存的执行步骤'));for(const node of task.executionPlan.nodes)steps.append(element('p',(node.skillId||'文字交付')+' → '+(node.tool||node.kind)+' · '+node.status+' · 方案 v'+node.revision));body.append(steps);}
 if(diagnostics.length)body.append(element('p','成果已保存，但结构化约束检查发现差异：'+diagnostics.map(c=>c.field+' 要求 '+c.expected+'，实际 '+c.actual).join('；')));
 if(task.actions?.awaitingReconciliation)body.append(element('p','正在等待供应商提交回执核对；请保留当前记录。'));
 if(task.reason)body.append(element('p',task.reason));
 if(task.status==='WAIT_CONFIRM'){
  const plan=element('details');plan.open=true;plan.append(element('summary','待确认的生成方案'));
  for(const [i,args] of (task.approval.payload?.items||[]).entries())plan.append(element('h4','第 '+(i+1)+' 项'+(args.duration?' · '+args.duration+' 秒':'')+(args.ratio?' · '+args.ratio:'')+(args.size?' · '+args.size:'')),element('pre',[args.prompt,...(args.referenceImages||[]).map(url=>'参考图片：'+url),args.firstFrameUrl?'首帧：'+args.firstFrameUrl:''].filter(Boolean).join('\n')));body.append(plan);
 }
 details.append(body);details.addEventListener('toggle',()=>{if(details.isConnected)taskPanelExpansion.set(task.id,details.open);});row.append(details);
 if(task.actions?.canResume){
  const button=element('button',task.actions.resumeLabel);button.disabled=busy;button.addEventListener('click',()=>continueTask(task).catch(error=>add('p','notice',error.message)));row.append(button);
 }
 panel.append(row);
}
async function continueTask(task){
 if(busy)return;viewRevision++;clearTimeout(pollTimer);followTail=true;setBusy(true);
 try{const response=await fetch('/api/task/continue',{method:'POST',headers:{'Content-Type':'application/json','X-MVP-Token':config.csrf},body:JSON.stringify({sessionId,taskId:task.id,requestId:crypto.randomUUID(),...(task.actions?.requiresApproval?{planHash:task.approval.planHash}:{})})});
  if(!response.ok)throw new Error((await response.json()).error);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines)if(line.trim())event(JSON.parse(line));}
  if(buffer.trim())event(JSON.parse(buffer));await restore();
 }finally{setBusy(false);loadHistory();}
}
function renderMedia(result) {
  if(result.isError) return;
  if(result.taskId && ['queued','running'].includes(result.status)) add('p','notice',`媒体任务 ${result.taskId} · ${result.status}。后台将自动查询并返回结果。`);
  if(result.audioUrl && (safeUrl(result.audioUrl)||/^\/media\/[a-f0-9-]{36}\.(mp3|wav)$/.test(result.audioUrl))) {
    const audio=document.createElement('audio');audio.src=result.audioUrl;audio.controls=true;$('#chat').append(audio);addMediaLink(result.audioUrl,'打开音频');
  }
  for(const scene of result.scenes||[]) {add('p','notice',`片段 ${scene.index} · ${scene.startSeconds}–${scene.endSeconds} 秒`);renderMedia({videoUrl:scene.videoUrl});}
  for(const item of result.images || []) {
    if(!safeUrl(item.url)) continue;
    const img=document.createElement('img');img.src=item.url;img.alt='生成图片';img.className='media-result';
    img.addEventListener('error',()=>add('p','notice','图片链接加载失败或已过期。'));
    $('#chat').append(img); addMediaLink(item.url,'打开原图');
  }
  if(result.videoUrl && safeUrl(result.videoUrl)) {
    const video=document.createElement('video');video.src=result.videoUrl;video.controls=true;video.preload='metadata';video.className='media-result';
    $('#chat').append(video);addMediaLink(result.videoUrl,'打开视频');
  }
}
function safeUrl(value) { try{return new URL(value).protocol==='https:';}catch{return false;} }
function addMediaLink(url,label) { const a=add('a','media-link',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer'; }
function add(tag, className, text) { const element = document.createElement(tag); element.className = className; element.textContent = text; $('#chat').append(element); scrollToLatest(); return element; }
function event(data) {
  renderedEvents++;
  if(data.type==='task_state')renderTask(data.task);
  if(data.type==='intent') {const box=add('details','','');const title=document.createElement('summary');title.textContent='理解你的需求：'+data.goal.summary;box.append(title);const pre=document.createElement('pre');pre.textContent=JSON.stringify(data.goal,null,2);box.append(pre);}
  if (data.type === 'start') { renderedUsers++;sessionId = data.sessionId; sessionStorage.setItem('creative-session', sessionId); }
  if (data.type === 'notice') add('p', 'notice', data.text);
  if (data.type === 'plan') {
    const box = add('div', 'plan', ''); const title = document.createElement('strong'); title.textContent = data.summary; box.append(title);
    const list = document.createElement('ol'); for (const step of data.steps) { const li = document.createElement('li'); li.textContent = `${{pending:'待执行',running:'进行中',done:'已完成'}[step.status]} · ${step.title}`; list.append(li); } box.append(list);
  }
  if (data.type === 'tool_start') { const box = add('details', '', ''); const summary = document.createElement('summary'); summary.textContent = `执行 ${data.name}…`; box.append(summary); calls.set(data.callId, box); }
  if (data.type === 'tool_result') {
    const box = calls.get(data.callId) || add('details', '', '');
    if (!box.querySelector('summary')) box.append(document.createElement('summary'));
    box.querySelector('summary').textContent = `${data.result.isError ? '调用失败' : '已返回'} · ${data.name}${data.result.reused ? '（复用已有结果）' : ''}`;
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(data.result, null, 2); box.append(pre);
    if (data.media) { box.append(element('p','候选预览：工具已返回，是否可交付以最终验收为准。')); renderMedia(data.result); }
  }
  if (data.type === 'final') {
    const reply=add('div', 'bubble assistant', displayReply(data.text));
    renderFinalReply(reply,displayReply(data.text),data.status);
    for(const artifact of (data.artifacts||[]).filter(a=>a.purpose==='deliverable'&&a.verification?.technical==='passed'&&['passed','simulated_passed'].includes(a.verification?.semantic)&&!['superseded','audit'].includes(a.publication))){
      const revise=element('button',`修改此${{text:'正文',image:'图片',video:'视频',audio:'音频'}[artifact.type]||'结果'} · v${artifact.version}`);revise.type='button';revise.className='revise-result';
      revise.addEventListener('click',()=>{$('#message').value=`基于产物 ${artifact.id}${artifact.url?'（'+artifact.url+'）':''} 修改：`;$('#message').focus();});reply.append(revise);
    }
  }
  scrollToLatest();
}
function setBusy(value) { busy = value; $('#send').disabled = value; $('#new').disabled = value; $('#stop').hidden = !value;document.querySelectorAll('#task-panel button, .history-item').forEach(b=>b.disabled=value); }
async function submit(message) {
  if (busy) throw new Error('当前任务正在执行');
  if (typeof message !== 'string' || !message.trim() || message.length > 30000) throw new Error('请输入有效需求');
  viewRevision++;clearTimeout(pollTimer);followTail=true;
  $('#welcome')?.remove(); add('div', 'bubble user', message); $('#message').value = ''; setBusy(true);
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MVP-Token': config.csrf }, body: JSON.stringify({ message, sessionId, requestId:crypto.randomUUID() }) });
    if (!res.ok) throw new Error((await res.json()).error);
    const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, {stream:true}); const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) if (line.trim()) event(JSON.parse(line)); }
    if (buffer.trim()) event(JSON.parse(buffer));
    await restore();return { sessionId };
  } catch (error) { add('p', 'notice', `${error.message}。若连接中断，可刷新页面查看执行结果。`); throw error; }
  finally { setBusy(false);loadHistory(); }
}
$('#form').addEventListener('submit', e => { e.preventDefault(); submit($('#message').value).catch(() => {}); });
$('#new').addEventListener('click', () => { sessionStorage.removeItem('creative-session'); location.reload(); });
$('#history-refresh').addEventListener('click',()=>loadHistory());
$('#history-more').addEventListener('click',()=>loadHistory({more:true}));
$('#history-search').addEventListener('input',()=>{clearTimeout(historyDebounce);historyRequest++;$('#history-more').disabled=true;historyDebounce=setTimeout(()=>loadHistory(),200);});
$('#history-toggle').addEventListener('click',()=>toggleHistory(!document.body.classList.contains('history-open')));
$('#history-overlay').addEventListener('click',()=>toggleHistory(false));
document.addEventListener('keydown',e=>{if(e.key==='Escape')toggleHistory(false);});
$('#stop').addEventListener('click', () => fetch('/api/cancel', { method:'POST', headers:{'Content-Type':'application/json','X-MVP-Token':config.csrf}, body:JSON.stringify({sessionId}) }).catch(() => add('p','notice','停止请求未送达，请重试。')));
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('#message').value = button.dataset.prompt; $('#message').focus(); }));
$('#message').addEventListener('keydown', e => {
 if(e.key!=='Enter'||e.shiftKey||e.isComposing||e.keyCode===229)return;
 e.preventDefault();if(!busy&&!e.repeat&&config)$('#form').requestSubmit();
});
async function restore() {
  clearTimeout(pollTimer);
  const revision=viewRevision;
  const response = await fetch(`/api/session/${sessionId}`);if(revision!==viewRevision)return; if (!response.ok) {if(response.status===404||response.status===400){sessionStorage.removeItem('creative-session'); sessionId = null;}throw new Error('无法读取此会话');}
  const state = await response.json();if(revision!==viewRevision||state.events.length<renderedEvents)return;
  $('#welcome')?.remove();
  if(!renderedEvents&&!renderedUsers&&!state.events.some(e=>e.type==='start')){for(const message of state.messages||[])add('div','bubble '+message.role,displayReply(message.content));renderedUsers=state.users.length;renderedEvents=state.events.length;}
  for (const entry of state.events.slice(renderedEvents)) { if (entry.type === 'start') add('div','bubble user',state.users[renderedUsers] || ''); event(entry); }
  renderTask(state.task);scrollToLatest();
  setBusy(state.status === 'running');
  if (state.status === 'running'||state.pendingTasks) pollTimer=setTimeout(() => {if(!busy||state.status==='running')restore().catch(() => setBusy(false));}, 5000);
  if (state.status === 'interrupted') add('p','notice','上次执行被服务重启中断。已提交的任务需在 方舟 查验。');
  return state.status;
}
try {
  config = await (await fetch('/api/config')).json();
  $('#model').textContent = `${config.providerName||'模型'} · ${config.model}`;
  $('#connection').textContent = `${config.skills.length} 个本地 Skill · ${config.capabilities.tools.length} 个工具`;
  const missing=Object.values(config.capabilities.services||{}).filter(s=>!s.configured).length;
  $('#hint').textContent = `独立运行 · 支持粘贴 HTTPS 素材地址${missing?` · ${missing} 项扩展服务待配置`:''}`;
  for (const skill of config.skills) { const item = document.createElement('div'); item.className = 'skill'; item.textContent = skill.name; item.title = skill.description; $('#skills').append(item); }
  const serviceNames={generate_voiceover:'配音',clone_voice:'音色克隆',propose_lipsync:'口型同步',slice_video:'场景切片',propose_video_upscale:'视频超分',propose_video_replication:'视频复刻',merge_videos:'视频合并',analyze_video:'专业视频分析'};
  const status=document.createElement('details');const label=document.createElement('summary');label.textContent='扩展服务配置';status.append(label);
  for(const [name,service] of Object.entries(config.capabilities.services||{})){const row=document.createElement('p');row.textContent=`${serviceNames[name]||name}：${service.configured?'已配置':'待配置'}`;row.title=service.missing.join(', ');status.append(row);}
  $('#skills').append(status);
  if (sessionId) {try{await restore();}catch(error){add('p','notice',error.message);}}
  await loadHistory();
  if (document.modelContext?.registerTool) {
    const lifecycle = new AbortController();
    addEventListener('pagehide', () => lifecycle.abort(), {once:true});
    await document.modelContext.registerTool({ name:'run_creation_task', description:'提交创作需求并等待本轮执行结束。可能调用方舟付费媒体工具。',
      inputSchema:{type:'object',properties:{message:{type:'string',minLength:1,maxLength:30000}},required:['message'],additionalProperties:false},
      annotations:{readOnlyHint:false,untrustedContentHint:true}, execute: input => submit(input.message) }, { signal:lifecycle.signal });
  }
} catch (error) { add('p','notice',`初始化失败：${error.message}`); }
