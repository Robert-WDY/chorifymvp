import {describeRun,aliasesFor,label,displayValue,list,modelStage,structuredModelOutput} from './readable.mjs';
import {readable,modelReading,toolReading} from './readable-view.js';
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const card=(title,...children)=>{const n=el('section','','card');n.append(el('h2',title),...children);return n;};
const note=text=>el('p',text,'muted');
const text=value=>el('div',value??'尚未返回','query-text');
const details=(title,child,key=title,open=false)=>{const n=el('details');n.dataset.readKey=key;n.open=open;n.append(el('summary',title),child);return n;};
const field=(title,v,names)=>card(title,readable(v,names));
const matches=(id,target)=>id===target||typeof id==='string'&&id.startsWith(target+':stage:');
export function groupFlows(r){
 const d=describeRun(r),flows=d.subgoals.map((g,i)=>({...g,id:g.id||'contract:'+i,models:[],tools:[],nodes:d.nodes.filter(n=>n.itemId===g.id)})),shared={models:[],tools:[]};
 for(const [index,c] of r.contextSnapshots.entries()){
  c.stage??=modelStage(c);c.modelSequence??=index+1;c.structuredOutput??=structuredModelOutput(c.output);
  if(!c.nodeId){
   const components=r.sessionView?.assembly.find(a=>a.callId===c.callId)?.components||[];
   const goal=components.find(p=>p.goal)?.goal;
   const matches=flows.filter(f=>f.description===(typeof goal==='string'?goal:goal?.description));
   if(matches.length===1){c.nodeId=matches[0].id;c.bindingEvidence='recorded_payload_unique_target';}
  }
 }
 for(const c of r.contextSnapshots){const a=r.sessionView?.assembly.find(a=>a.callId===c.callId),ids=[c.nodeId,...(a?.components||[]).flatMap(p=>[p.item?.id,p.node?.itemId])].filter(Boolean);const targets=flows.filter(f=>ids.some(id=>matches(id,f.id)));(targets.length===1?targets[0]:shared).models.push(c);}
 for(const t of r.tools){const urls=(t.result?.images||[]).map(a=>a.url).filter(Boolean),artifactItems=(r.artifacts||[]).filter(a=>a.debugEvidenceScope==='recorded_in_run'&&urls.includes(a.url)).map(a=>a.itemId);const ids=[t.itemId,t.nodeId,t.request?.nodeId,t.request?.itemId,t.result?.itemId,...artifactItems].filter(Boolean);const targets=flows.filter(f=>ids.some(id=>matches(id,f.id)));(targets.length===1?targets[0]:shared).tools.push(t);}
 return {flows,shared};
}
function operations(models,tools,r){
 const n=el('div','','flow-steps');
 const steps=[...models.map(c=>({at:c.at,id:c.callId,title:`模型调用 ${c.modelSequence||''} · ${c.stage?.title||label(c.phase)}${c.stage?.repair?' · 修复重试':''}`,summary:c.error||((c.validations||[]).some(v=>v.accepted===false)?'输出被校验拒绝':c.output?'已返回':'等待返回'),body:()=>modelReading(c,r)})),...tools.map(t=>({at:t.startedAt,id:t.callId,title:'工具 · '+label(t.name),summary:label(t.status),body:()=>toolReading(t,r)}))].sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0));
 for(const [i,s] of steps.entries()){const body=el('div');const d=details(`${i+1}. ${s.title} · ${s.summary}`,body,'operation:'+s.id);d.addEventListener('toggle',()=>{if(d.open&&!body.childNodes.length)body.append(s.body());});n.append(d);}
 return n;
}
export function flowView(r,host){
 const names=aliasesFor(r),d=describeRun(r),{flows,shared}=groupFlows(r),accepted=r.intent.acceptedContract;
 const explicit=r.timeline?.find(t=>t.phase==='USER INPUT')?.data?.explicitTarget;
 host.append(card('识别了什么意图',text(displayValue(d.summary,names)),note(explicit?'本轮读取已保存的任务合同。':accepted?'程序已接受这一理解。':'尚未接受；这里展示最近一份模型草稿。'),text(d.route)));
 if(r.intent?.businessAction)host.append(details('业务动作与程序编译结果',readable(r.intent.businessAction,names),'business-action'));
 if(shared.models.length||shared.tools.length)host.append(card('共同入口与共享步骤',note('需求理解先于子意图规划。未记录子意图归属的调用也保留在这里，不强行归到某个目标。'),operations(shared.models,shared.tools,r)));
 if(!flows.length){host.append(card('本轮交付',text(accepted&&['inspect','present','retain'].includes(accepted.turnOperation?.kind)?'读取已有信息并回复，不创建新的创作成果。':'尚未形成可执行的交付合同。'),r.delivery.queryReceipt?readable(r.delivery.queryReceipt,names):note('没有进入子意图执行。')));return;}
 for(const [i,f] of flows.entries()){
  const box=card(`子意图 ${i+1} · ${f.title}`,text(label(f.status)),readable({交付内容:label(f.output||f.kind),数量:f.artifactCount??f.count},names),details('合同约束与参数（模型提取的原始记录）',readable({约束:f.constraints||[],规格:f.spec||{}},names),'contract:'+f.id));
  const deps=(f.dependsOn||[]).map(x=>typeof x==='number'?flows[x]?.title:names.get(x)||x);
  box.append(field('如何规划',{前置依赖:deps.length?deps:'无前置依赖',方法:f.requiredMethods||[],执行步骤:f.nodes.map(n=>({方式:label(n.kind),工具:n.tool?label(n.tool):'未绑定媒体工具',方法:n.skillId||n.requiredMethods,状态:label(n.status)}))},names));
  box.append(operations(f.models,f.tools,r));
  const progression=el('ol','','progress-history');let last='';for(const h of f.history||[]){const key=JSON.stringify([h.status,h.coverage,h.artifactCount]);if(key===last)continue;last=key;const li=el('li');li.append(el('strong',label(h.status)),note(h.at||''),readable({关联产物数:h.artifactCount,逐项完成情况:h.coverage??'未记录'},names));progression.append(li);}box.append(card('任务状态与完成度',progression,readable(f.coverage?.length?f.coverage:'没有逐项覆盖记录，不能用产物个数推算完成百分比。',names)));
  const artifacts=r.artifacts.filter(a=>a.itemId===f.id&&a.debugEvidenceScope==='recorded_in_run');
  const result=card('这个子意图的结果');if(!artifacts.length)result.append(note('本轮尚无已记录的产物结果。'));for(const a of artifacts)result.append(details(`${label(a.type)} · 版本 ${a.version||1} · ${(a.acceptance?.delivery?.passed?'交付齐备，内容未评估':label(a.verification?.semantic))}`,a.content?text(a.content):text(a.url||'没有正文或地址'),'artifact:'+a.id,true));box.append(result);host.append(box);
 }
}
function chat(messages){const n=el('div','','history-messages');for(const m of messages){const b=el('article','','history-message '+m.role);b.append(note((m.round?'第 '+m.round+' 轮 · ':'')+(m.role==='assistant'?'助手':'用户')),text(m.content));n.append(b);}if(!messages.length)n.append(note('没有此前消息。'));return n;}
export function historyView(r,host){
 const s=r.sessionView,names=aliasesFor(r);if(!s){host.append(note('尚未读取会话上下文记录。'));return;}
 host.append(card('本轮之前的对话',chat(s.history)));
 const picker=el('select');picker.setAttribute('aria-label','选择上下文调用');s.assembly.forEach((a,i)=>picker.add(new Option(`第 ${i+1} 次模型调用 · ${label(r.contextSnapshots.find(c=>c.callId===a.callId)?.phase)}`,String(i))));
 const body=el('div');const update=()=>{body.replaceChildren();const a=s.assembly[Number(picker.value)];if(!a){body.append(note('本轮没有模型请求。'));return;}
  const c=a.conversation,p=a.components.find(p=>p.conversation),included=c?.recentMessages||[];
  body.append(note(a.source==='actual_request'?'以下从实际发给模型的请求中读取。':'以下来自传输前输入，实际供应商请求未记录。'));
  if(c){body.append(text(`本次带入 ${included.length} 条历史正文、${list(c.messageIndex).length} 条消息索引、${list(c.recentAttempts).length} 次近期请求记录。`),card('实际带入的历史正文',chat(included)));
   const omitted=s.history.filter(h=>!included.some(m=>m.role===h.role&&m.content===h.content));if(omitted.length)body.append(details('此前逐轮对话中未出现在本次历史正文里的消息',chat(omitted)));
   body.append(details('历史的使用规则与未完成请求',readable({使用规则:c.policy,未完成请求:c.pendingRequest,近期请求:c.recentAttempts},names)));
  }else body.append(note('这个调用没有 conversation.recentMessages 字段；不能把入口的历史默认视为已传到本节点。'));
  if(p)body.append(details('同时带入的任务、素材和历史成果',readable({当前任务:p.taskSnapshot,任务列表:p.taskIndex,历史文档:p.sourceDocuments,素材:p.assets},names)));
  const seq=el('ol');for(const m of a.sequence){const li=el('li');li.append(el('strong',({system:'系统指令 / 校验反馈',user:'本次输入',assistant:'历史输出 / 待修复草稿',tool:'工具返回'})[m.role]||m.role),note(m.keys.length?'字段：'+m.keys.map(k=>({conversation:'历史对话',query:'用户请求',taskSnapshot:'当前任务',sourceDocuments:'来源文档',skillDirectory:'Skill 目录',referenceCatalog:'引用目录',taskIndex:'任务索引',assets:'素材',executionDefaults:'执行默认值'})[k]||k).join('、'):''),details('完整内容',el('pre',m.content),'message:'+a.callId+':'+m.index));seq.append(li);}body.append(card('历史与当前输入怎样拼接',seq));
 };picker.addEventListener('change',update);host.append(card('本次实际使用了什么上下文',picker,body));update();
}
function stateSummary(snapshot,names){
 if(!snapshot)return note('未记录完整的全局业务 State。');const s=snapshot.data,n=el('div');
 n.append(readable({会话状态:s.sessionStatus,当前任务:s.activeTaskId?names.get(s.activeTaskId)||'已保存任务':'无活动任务',任务数:Object.keys(s.tasks||{}).length,产物数:Object.keys(s.artifacts||{}).length,执行数:Object.keys(s.executions||{}).length,对话消息数:s.messageCount},names));
 for(const t of Object.values(s.tasks||{}))n.append(card(t.query||'任务',text(label(t.status)),readable({版本:t.revision,原因:t.reason,批准:t.approval},names)));
 return n;
}
export function globalView(r,host){
 const rounds=r.sessionView?.globalRounds||[],picker=el('select');picker.setAttribute('aria-label','选择全局状态轮次');rounds.forEach((s,i)=>picker.add(new Option(`第 ${s.number} 轮 · ${s.query}`,String(i))));picker.value=String(rounds.length-1);const body=el('div');
 const update=()=>{body.replaceChildren();const round=rounds[Number(picker.value)];if(!round)return;
  const names=aliasesFor(r);for(const snapshot of [round.before,round.after])for(const t of Object.values(snapshot?.data?.tasks||{}))names.set(t.id,t.query||'任务');
  if(round.before||round.after){const pair=el('div','','two');pair.append(card('本轮开始',stateSummary(round.before,names)),card('本轮结束',stateSummary(round.after,names)));body.append(pair,details('这轮改变了哪些结构化字段',readable(round.changes?.map(c=>({字段:c.field,之前:c.old,之后:c.new}))??'缺少前后快照',names)),details('完整业务 State',readable({开始:round.before,结束:round.after},names)));}
  else{body.append(note('这一轮没有保存完整的全局 State。下面仅展示当时留下的任务状态，不能代表全部会话状态。'));
   if(!round.taskSnapshots.length)body.append(note('这一轮也没有任务快照；对话原文仍可在“历史上下文”查看。'));
   let previous='';for(const snap of round.taskSnapshots){const t=snap.task,key=JSON.stringify([t.id,t.status,t.revision,t.approval,t.items?.map(i=>[i.status,i.coverageProgress])]);if(key===previous)continue;previous=key;body.append(card(t.query||'任务',text(label(t.status)),note(snap.at||''),readable({版本:t.revision,批准:t.approval,子目标:t.items?.map(i=>({目标:i.description,状态:i.status,完成情况:i.requirementCoverage||i.coverageProgress}))},names),details('这个时点的任务 State',readable(t,names))));}
  }
 };picker.addEventListener('change',update);host.append(card('逐轮全局 State',picker,body));update();
}
