const $=id=>document.getElementById(id);
const key='chorify.context-agent.session';
let config,sessionId=localStorage.getItem(key),running=false,submitting=false,streaming=false,cursor=-1,pollTimer;
let pending=new Map(),questions=new Map(),cards=new Map(),seen=new Set(),selected=new Set(),rendered=new Set();
const labels={agent:'Agent 决策',summary:'整理较早会话',image_observation:'观察图片',read_asset:'读取素材',read_history:'读取历史',search_history:'查找历史',read_skill:'读取专业方法',inspect_workspace:'查询工作区',request_user_input:'发布问题',generate_image:'准备图片方案',edit_image:'准备图片修改',generate_video:'准备视频方案',confirm_media:'确认并执行方案',execute_approved:'执行已批准方案',save_document:'保存文稿',analyze_image:'观察图片',compare_images:'比较原图与成品',read_media_result:'读取媒体回执'};
const states={running:'进行中',succeeded:'已完成',failed:'失败',unknown:'结果未知',pending:'已提交，处理中',partial:'部分完成',prepared:'方案已准备',waiting_user:'等待回答',not_executed:'未执行',cancelled:'已取消'};
labels.delivery_check='交付正文验收';
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
async function checked(response){if(!response.ok){let body;try{body=await response.json();}catch{}const error=new Error(body?.error||'请求失败');error.status=response.status;throw error;}return response;}
const get=path=>fetch(path).then(checked).then(r=>r.json());
const post=(path,data)=>fetch(path,{method:'POST',headers:{'Content-Type':'application/json','x-context-token':config.csrf},body:JSON.stringify(data)}).then(checked);
function status(text){$('status').textContent=text;}
function controls(){for(const id of ['send','new'])$(id).disabled=running;proposals();renderQuestions();}
function message(id,role,text,seq=-1){
 const old=cards.get(id);if(old&&old.seq>seq)return;
 const box=old?.node||el('article',undefined,'message '+role);box.replaceChildren(el('div',role==='user'?'你':'Chorify','label'),document.createTextNode(typeof text==='string'?text:JSON.stringify(text)));
 if(!old)$('messages').append(box);cards.set(id,{node:box,seq});
}
function activity(e){
 const id=e.activityId,old=cards.get(id);if(old&&old.seq>e.seq)return;
 const box=old?.node||el('article',undefined,'activity');box.dataset.activityId=id;box.dataset.status=e.status;
 box.replaceChildren(el('strong',labels[e.name]||e.name),el('span',states[e.status]||e.status,'badge'));
 if(e.durationMs!==undefined)box.append(el('small',`实际耗时 ${(e.durationMs/1000).toFixed(2)} 秒`));
 if(e.error)box.append(el('p',e.error,'error'));
 if(e.note)box.append(el('p',e.note));
 const summary={receiptId:e.receiptId,proposalId:e.proposalId,resultRefs:e.resultRefs,receipts:e.receipts,submission:e.submission,submitted:e.submitted,simulated:e.simulated};
 if(e.category==='tool'&&e.status!=='running'){const detail=el('details');detail.append(el('summary','结果概览'),el('pre',JSON.stringify(summary,null,2)));box.append(detail);}
 if(!old)$('messages').append(box);cards.set(id,{node:box,seq:e.seq});
}
function ingest(e){
 if(e.type!=='public_event'||seen.has(e.eventId))return;seen.add(e.eventId);
 if(e.kind==='message'){if(e.streamId&&cards.has(e.streamId+':text')){cards.get(e.streamId+':text').node.remove();cards.delete(e.streamId+':text');}message(e.messageId,e.role,e.text,e.seq);}
 if(e.kind==='text_delta'){const id=e.streamId+':text',old=cards.get(id);const text=(old?.text||'')+e.delta;message(id,'assistant',text+'\n（生成中，尚未完成）',e.seq);cards.get(id).text=text;}
 if(e.kind==='text_incomplete'){const id=e.streamId+':text',old=cards.get(id);if(old)message(id,'assistant',(old.text||'')+'\n（'+(e.note||'连接中断，文字未完成')+'）',e.seq);}
 if(e.kind==='activity')activity(e);
 if(e.kind==='proposal'){pending.set(e.proposal.proposalId,e.proposal);proposals();}
 if(e.kind==='document'){
  const a=e.asset,id='saved:'+a.id,old=cards.get(id);if(!old){const box=el('article',undefined,'message assistant');box.dataset.assetId=a.id;box.append(el('strong','已保存：'+(a.title||'文稿')+' · v'+a.version),el('p',e.changed===false?'正文与上一版相同。':'以下为已保存的版本。'),el('pre',a.content));$('messages').append(box);cards.set(id,{node:box,seq:e.seq});}
 }
 if(e.kind==='interaction'){questions.set(e.interaction.interactionId,e.interaction);renderQuestions();}
 if(e.kind==='turn_end')status(e.status==='waiting_user'?'等待你的回答；没有自动继续调用。':e.status==='completed'?'本轮回复结束；交付状态以实际结果为准。':e.message||states[e.status]||e.status);
}
function assets(items){
 $('assets').replaceChildren();const valid=new Set(items.map(a=>a.id));selected=new Set([...selected].filter(id=>valid.has(id)));
 for(const a of items){const box=el('div',undefined,'asset');box.dataset.assetId=a.id;
  const check=el('input');check.type='checkbox';check.checked=selected.has(a.id);check.setAttribute('aria-label','选中 '+(a.name||a.title||a.id));check.onchange=()=>{check.checked?selected.add(a.id):selected.delete(a.id);localStorage.setItem(key+'.selection.'+sessionId,JSON.stringify([...selected]));};
  const label=el('label',undefined,'selection');label.append(check,document.createTextNode((a.name||a.title||a.type)+' · v'+a.version+(a.simulated?' · 模拟产物':'')+' · '+a.id));box.append(label);
  if(a.url&&!a.simulated){let u;try{u=new URL(a.url);}catch{}if(u?.protocol==='https:'){if(['image','video'].includes(a.type)){const media=el(a.type==='image'?'img':'video');media.src=a.url;if(a.type==='video')media.controls=true;else media.alt=a.name||'图片';box.append(media);}const link=el('a','打开原文件');link.href=a.url;link.target='_blank';link.rel='noopener noreferrer';box.append(link);}}
  if(a.content){const detail=el('details');detail.append(el('summary','查看完整文稿'),el('pre',a.content));box.append(detail);} $('assets').append(box);
 }
}
function proposals(){
 $('proposals').replaceChildren();if(!pending.size)return;
 const box=el('section',undefined,'proposal');box.append(el('strong','已保存的媒体方案'),el('p',running?'本轮仍在准备。方案已经发布，结束后可确认。':'检查具体参数后再批准；选择风格不等于批准生成。'));
 const chosen=new Set();
 for(const [id,p]of pending){const row=el('div',undefined,'proposal-item');row.dataset.proposalId=id;
  const label=el('label',undefined,'selection'),check=el('input');check.type='checkbox';check.checked=false;check.onchange=()=>{check.checked?chosen.add(id):chosen.delete(id);};label.append(check,document.createTextNode((labels[p.name]||p.name)+' · '+id));row.append(label);
  const args=p.args||{};row.append(el('p',args.prompt||args.instruction||'已保存参数'),el('p',[args.size,args.ratio,args.duration?args.duration+'秒':null].filter(Boolean).join(' · ')));
  if(args.imageId||args.referenceImages?.length)row.append(el('p','参考素材：'+[args.imageId,...args.referenceImages||[]].filter(Boolean).join('、')));
  const detail=el('details');detail.append(el('summary','完整参数'),el('pre',JSON.stringify(args,null,2)));row.append(detail);box.append(row);
 }
 const button=el('button','批准选中的'+(config?.mediaMode==='simulation'?'模拟':'媒体')+'方案');button.disabled=running;button.onclick=()=>chosen.size?run('/api/approve',{proposalIds:[...chosen]}):status('请勾选具体方案。');box.append(button);$('proposals').append(box);
 const ids=[...pending.keys()].filter(id=>!rendered.has(id));if(ids.length&&config&&sessionId){const target=sessionId;post('/api/proposals/rendered',{sessionId:target,proposalIds:ids}).then(()=>{if(target===sessionId)ids.forEach(id=>rendered.add(id));}).catch(()=>{});}
}
function renderQuestions(){
 $('questions').replaceChildren();
 for(const item of questions.values()){
  if(item.status!=='pending')continue;const form=el('form',undefined,'question');form.dataset.interactionId=item.interactionId;form.append(el('strong',item.message));
  const fields=[];
  for(const q of item.questions){const field=el('fieldset');field.append(el('legend',q.label));const prior=item.answers?.[q.key];
   if(prior){field.append(el('p','已回答：'+(prior.text||q.options?.find(o=>o.id===prior.optionId)?.label||prior.optionId)));}
   else{const select=el('select');select.name=q.key;select.append(new Option('请选择（可先回答部分问题）',''));for(const o of q.options||[])select.append(new Option(o.label,o.id));if(q.options?.length)field.append(select);
    let text;if(q.allowFreeText){text=el('input');text.type='text';text.maxLength=2000;text.placeholder='或输入你的回答';text.setAttribute('aria-label',q.label+' 自由回答');field.append(text);}fields.push({q,select,text});}
   form.append(field);
  }
  const submit=el('button','提交回答');submit.type='submit';submit.disabled=running;form.append(submit);
  for(const [action,label]of [['decline','暂不回答'],['cancel','取消问题']]){const b=el('button',label);b.type='button';b.disabled=running;b.onclick=()=>run('/api/answer',{interactionResponse:{interactionId:item.interactionId,action}});form.append(b);}
  form.onsubmit=e=>{e.preventDefault();const answers={};for(const {q,select,text}of fields){if(text?.value.trim())answers[q.key]={text:text.value.trim()};else if(select.value)answers[q.key]={optionId:select.value};}if(!Object.keys(answers).length)return status('请至少回答一项。');run('/api/answer',{interactionResponse:{interactionId:item.interactionId,action:'submit',answers}});};$('questions').append(form);
 }
}
function recovery(error){status((error.status===404?'原会话不存在。':error.status===403?'无权访问原会话。':'恢复会话失败：'+error.message)+' 已保留原会话标识，可重试或明确新建。');$('retry').hidden=false;}
async function refresh(){
 $('debug-link').href='/debug?session='+encodeURIComponent(sessionId||'');
 if(!sessionId)return;if(traceSession&&traceSession!==sessionId){$('trace-list').replaceChildren();$('trace-count').textContent='';$('trace-more').hidden=true;traceSession=null;}$('history-export').href='/api/session/'+encodeURIComponent(sessionId)+'/export';const target=sessionId,s=await get('/api/session/'+encodeURIComponent(target));if(target!==sessionId)return;
 let events=[...s.events],next=s;while(next.hasMore){next=await get('/api/events/'+encodeURIComponent(target)+'?after='+next.cursor);events.push(...next.events);}cursor=next.cursor;
 $('messages').replaceChildren();cards.clear();seen.clear();const eventMessages=new Set(events.filter(e=>e.kind==='message').map(e=>e.messageId));for(const m of s.messages)if(!eventMessages.has(m.id))message(m.id,m.role,m.content);
 pending.clear();questions.clear();for(const e of events.sort((a,b)=>a.seq-b.seq))ingest(e);
 pending.clear();for(const p of Object.values(s.proposals||{}))if(p.kind==='proposal'&&!p.unavailable&&!Object.values(s.proposals).some(a=>a.kind==='approval'&&a.proposalIds.includes(p.proposalId)))pending.set(p.proposalId,p);
 for(const item of s.interactions||[])questions.set(item.interactionId,item);
 assets(s.assets);running=streaming||s.running;
 if(!running)for(const {node}of cards.values())if(node.dataset.status==='running'){node.dataset.status='unknown';node.querySelector('.badge').textContent='上次运行中断，结果未确认';}
 controls();$('retry').hidden=true;if(running&&!streaming)schedulePoll();
}
function schedulePoll(){clearTimeout(pollTimer);pollTimer=setTimeout(async()=>{if(streaming||!sessionId)return;try{const e=await get('/api/events/'+encodeURIComponent(sessionId)+'?after='+cursor);for(const item of e.events)ingest(item);cursor=e.cursor;if(e.running||e.hasMore)schedulePoll();else{running=false;await refresh();}}catch(error){recovery(error);}},700);}
async function newSession(){if(running||submitting)return;const s=await(await post('/api/session',{})).json();sessionId=s.id;localStorage.setItem(key,sessionId);selected.clear();rendered.clear();cursor=-1;await refresh();await loadHistory();status('已开始新对话，旧对话保留在历史列表。');}
let historyOffset=0;
let traceOffset=0,traceSession,traceSource;
async function loadTrace(reset=true){
 if(!sessionId)return;
 if(reset){traceOffset=0;traceSession=sessionId;traceSource=$('trace-source').value;$('trace-list').replaceChildren();}
 const target=traceSession,source=traceSource,page=await get('/api/session/'+encodeURIComponent(target)+'/history?source='+encodeURIComponent(source)+'&offset='+traceOffset);
 if(target!==sessionId||source!==$('trace-source').value)return;
 for(const row of page.rows){const detail=el('details'),summary=el('summary',row.index+' · '+row.label),body=el('pre','展开后读取完整记录');detail.append(summary,body);let loaded=false;detail.ontoggle=async()=>{if(!detail.open||loaded)return;try{const result=await get('/api/session/'+encodeURIComponent(target)+'/history?source='+encodeURIComponent(source)+'&index='+row.index);body.textContent=JSON.stringify(result.record,null,2);loaded=true;}catch(error){body.textContent=error.message;}};$('trace-list').append(detail);}
 traceOffset+=page.rows.length;$('trace-count').textContent=page.total+'条记录';$('trace-more').hidden=!page.hasMore;
}
$('trace-load').onclick=()=>loadTrace().catch(recovery);
$('trace-more').onclick=()=>loadTrace(false).catch(recovery);
$('trace-source').onchange=()=>loadTrace().catch(recovery);
async function loadHistory(reset=true){
 if(reset)historyOffset=0;
 const page=await get('/api/sessions?query='+encodeURIComponent($('history-query').value||'')+'&offset='+historyOffset);
 if(reset)$('history-list').replaceChildren();
 for(const item of page.sessions){const button=el('button',item.title+' · '+item.turnCount+'轮'+(item.id===sessionId?' · 当前':''));button.type='button';button.disabled=running||submitting;button.onclick=async()=>{if(running||submitting)return;try{await get('/api/session/'+encodeURIComponent(item.id));sessionId=item.id;localStorage.setItem(key,sessionId);selected.clear();rendered.clear();cursor=-1;clearTimeout(pollTimer);try{selected=new Set(JSON.parse(localStorage.getItem(key+'.selection.'+sessionId)||'[]'));}catch{}await refresh();await loadHistory();}catch(error){recovery(error);}};$('history-list').append(button);}
 historyOffset+=page.sessions.length;$('history-more').hidden=!page.hasMore;$('history-count').textContent=page.total+'个会话'+(page.unavailable?'；'+page.unavailable+'份记录暂不可读':'');
}
$('history-refresh').onclick=()=>loadHistory().catch(recovery);
$('history-more').onclick=()=>loadHistory(false).catch(recovery);
$('history-query').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();loadHistory().catch(recovery);}};
async function run(path,data){
 if(running||!sessionId)return;streaming=running=true;controls();status('正在处理…');
 try{const response=await post(path,{sessionId,requestId:crypto.randomUUID(),selectedAssetIds:[...selected],...data});const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let end;while((end=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const e=JSON.parse(line);ingest(e);if(e.type==='end'&&e.status==='error')status(e.message||'运行失败');}if(done){if(buffer.trim())ingest(JSON.parse(buffer));break;}}
 }catch(error){status('连接或运行失败：'+error.message+'。将保留当前会话并恢复实际进度。');}
 finally{streaming=running=false;try{await refresh();await loadHistory();}catch(error){recovery(error);}controls();}
}
$('message').onkeydown=e=>{if(e.key!=='Enter'||e.shiftKey||e.ctrlKey||e.altKey||e.metaKey||e.isComposing||e.keyCode===229)return;e.preventDefault();if(!e.repeat&&!running&&!submitting)$('chat').requestSubmit($('send'));};
$('chat').onsubmit=async e=>{e.preventDefault();if(running||submitting||!sessionId||!$('message').value.trim())return;submitting=true;try{const text=$('message').value,inputs=[];for(const f of $('files').files){if(f.size>128*1024)throw new Error('文字文件超过128 KiB');inputs.push({type:'text',name:f.name,content:await f.text()});}if($('image').value.trim())inputs.push({type:'image',name:'产品参考图',url:$('image').value.trim()});$('message').value='';$('files').value='';$('image').value='';await run('/api/chat',{message:text,inputs});}catch(error){status(error.message);}finally{submitting=false;}};
$('new').onclick=()=>newSession().catch(recovery);
$('retry').onclick=()=>initialize();
$('cancel').onclick=()=>post('/api/cancel',{sessionId}).then(()=>status('已请求停止；已提交的调用保留原回执。')).catch(e=>status(e.message));
async function initialize(){try{config=await get('/api/config');$('config').textContent=`Chorify MVP · ${config.model} · ${config.modelEnabled?'模型调用已启用':'模型调用未启用'} · ${config.mediaMode==='simulation'?'媒体模拟模式（不生成真实图片或视频）':'真实媒体需逐次批准'}`;try{selected=new Set(JSON.parse(localStorage.getItem(key+'.selection.'+sessionId)||'[]'));}catch{selected.clear();}if(sessionId){await refresh();await loadHistory();}else await newSession();}catch(error){recovery(error);}}
await initialize();
