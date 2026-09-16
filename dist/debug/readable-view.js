import {list,label,fieldLabel,displayValue,aliasesFor,modelMessages,selectedCalls,describeRun} from './readable.mjs';
import {cleanDisplay,structuredModelOutput} from './readable.mjs';
const e=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const box=(title,...content)=>{const n=e('section','','card reading-card');n.append(e('h2',title),...content);return n;};
const hint=text=>e('p',text,'muted');
const disclosure=(title,child,open=false,key=title)=>{const d=e('details');d.open=open;d.dataset.readKey=key;d.append(e('summary',title),child);return d;};
const raw=(title,data,key=title)=>disclosure(title,e('pre',typeof data==='string'?data:JSON.stringify(data??null,null,2)),false,key);
function parse(v){if(typeof v==='string'&&/^\s*[\[{]/.test(v)){try{return JSON.parse(v);}catch{}}return v;}
function readable(value,names,depth=0){
 value=parse(value);
 if(value===null||typeof value!=='object')return e('div',displayValue(value,names),'reading-text');
 if(Array.isArray(value)){const n=e('ol','','reading-list');if(!value.length)return hint('无');for(const v of value){const li=e('li');li.append(readable(v,names,depth+1));n.append(li);}return n;}
 const n=e('dl','','reading-fields');
 for(const [k,v] of Object.entries(value)){
  if(v===undefined||['annotations','logprobs'].includes(k))continue;
  const dt=e('dt',fieldLabel(k)),dd=e('dd');
  const child=readable(v,names,depth+1);
  if(depth>1&&v&&typeof v==='object')dd.append(disclosure('展开'+fieldLabel(k),child));else dd.append(child);
  n.append(dt,dd);
 }return n;
}
const field=(name,value,names)=>{const n=e('div','','reading-field');n.append(e('h3',name),readable(value,names));return n;};
function checks(validations,names){const n=e('div');if(!validations?.length)return hint('没有保存单独的校验结果；不能由调用成功推断检查通过。');for(const v of validations)n.append(box(label(v.phase||'validation')+' · '+(v.accepted===true?'接受':v.accepted===false?'拒绝':'结果未记录'),readable(v.error||v.issues||v.reason||'未记录说明',names),raw('校验原始结果与解析后的合同',v)));return n;}
export function modelReading(c,r){
 const names=aliasesFor(r),n=e('div'),m=modelMessages(c);
 n.append(hint(`模型调用 ${c.modelSequence||''} · ${c.stage?.title||label(c.phase)}${c.stage?.repair?' · 格式或合同修复重试':''}`));
 n.append(hint(m.source+'。下方 JSON 是模型返回格式，不是最终交付类型。输入全文按需展开。'));
 const sizes=m.messages.map((msg,index)=>({消息:index+1,角色:msg.role,字符数:JSON.stringify(msg.content??msg).length}));
 n.append(field('输入构成',sizes,names));
 const messages=e('div');
 for(const [i,msg] of m.messages.entries()){
  const role={system:'系统提示词',developer:'开发者指令',user:'用户输入 / 上下文',assistant:'模型历史输出',tool:'工具返回上下文'}[msg.role]||label(msg.type||'上下文');
  const row=box(`${i+1}. ${role}`,messageBody(msg,names));messages.append(row);
 }
 n.append(disclosure('完整提示词与上下文（'+m.messages.length+' 条消息）',messages,false,'messages:'+c.callId));
 const offered=list(c.actualRequest?.tools??c.tools);
 n.append(field('提供给模型的工具',offered.length?offered.map(t=>({name:t.name||t.function?.name,description:t.description||t.function?.description,parameters:t.parameters||t.function?.parameters})): '本次请求没有提供函数工具。模型可能按结构合同生成方案，不能据此认定整轮未使用工具。',names));
 const chosen=selectedCalls(c);
 n.append(field('模型选择的工具与输入',chosen.length?chosen.map(t=>({name:t.name,arguments:parse(t.args)})):'本次输出没有函数工具选择记录。程序调度的工具见执行步骤。',names));
 const outputs=c.structuredOutput||structuredModelOutput(c.output);
 n.append(field('模型输出（解析后的结构）',c.output==null?(c.error||'等待返回'):outputs,names),raw('模型输入与结构化输出 JSON',{stage:c.stage,input:cleanDisplay(m.messages),output:outputs},'io:'+c.callId));
 n.append(checks(c.validations,names),disclosure('同期可用上下文（有记录时）',readable(c.availableContext,names)),raw('完整供应商请求 / 返回、模型参数与技术标识',c,'model-raw:'+c.callId));return n;
}
function messageBody(msg,names){
 const n=e('div');if(msg.type==='function_call'){n.append(field('历史工具选择',msg.name,names),field('历史工具输入',parse(msg.arguments),names));return n;}
 if(msg.type==='function_call_output'){n.append(field('历史工具结果',parse(msg.output),names));return n;}
 const content=msg.content??msg;
 if(typeof content==='string')n.append(e('pre',content,'prompt-text'));
 else if(Array.isArray(content))for(const part of content){if(typeof part==='string')n.append(e('pre',part,'prompt-text'));else if(typeof part.text==='string')n.append(e('pre',part.text,'prompt-text'));else n.append(readable(part,names));}
 else n.append(readable(content,names));return n;
}
export function toolReading(t,r){
 const names=aliasesFor(r),n=e('div');
 const chosen=r.contextSnapshots.flatMap(selectedCalls).find(c=>c.id===t.callId);
 const plan=r.plan.snapshots.flatMap(s=>list(s.executionPlan?.nodes)).find(n=>n.tool===t.name&&(!t.itemId||n.itemId===t.itemId));
 n.append(hint(chosen?'动作提出者：模型函数调用，按调用标识匹配。':t.automatic?'动作提出者：程序自动执行（记录有 automatic 标记）。':plan?'计划记录为此节点绑定了该工具；实际提出者没有单独落盘。':'本轮已记录工具执行；谁选择该调用未单独记录，不冒充模型选择。'));
 n.append(field('实际提供给工具的输入',t.request,names));
 n.append(field('系统校验结果',t.validation,names));
 n.append(field('工具返回结果',t.result??(t.error?'调用失败，见错误说明':'等待返回'),names));if(t.error)n.append(field('错误说明',t.error,names));
 n.append(raw('原始工具输入输出与调用标识',t,'tool-raw:'+t.callId));return n;
}
function intentReading(r,names){const n=e('div'),c=r.intent.acceptedContract;
 n.append(hint(c?'以下是程序正式接受的需求。':'以下仍是模型草稿，不能视为已接受或已执行的需求。'));
 n.append(readable(c||r.intent.candidates.at(-1)?.parsedRawOutput||'尚无结构化意图记录',names));
 for(const [i,d] of r.intent.candidates.entries())n.append(disclosure(`第 ${i+1} 份理解草稿 · ${d.accepted?'记录接受':'未确认接受 / 被拒绝'}`,box('草稿内容',readable(d.parsedRawOutput,names),checks(d.validations,names)),false,'candidate:'+d.callId));
 return n;
}
function stateReading(r,names,snapshot=null){const n=e('div'),diffs=r.stateDiffs.filter(d=>(!snapshot||d.to===snapshot.id));
 for(const d of diffs){const task=d.scope.startsWith('task:');const block=e('div');block.append(e('h3',task?'持久任务状态变化':'请求合同变化（不是任务状态写入）'));
  if(!d.changes.length)block.append(hint('这两份记录没有字段差异。'));
  for(const c of d.changes){const path=c.field.split('/').filter(Boolean).map(k=>names.get(k)||fieldLabel(k));const row=e('div','','change-line');row.append(e('strong',path.join(' / ')),field('之前',c.old,names),field('之后',c.new,names));block.append(row);}
  block.append(raw('差异的来源、原始字段与分类',d));n.append(block);
 }
 if(!diffs.length)n.append(hint('没有可比较的前后快照；首次出现不代表本轮新写入。'));
 if(snapshot)n.append(disclosure('这一时点的完整结构化 State',readable(snapshot.data,names)),raw('这一时点的原始 State',snapshot,'state-raw:'+snapshot.id));return n;
}
export function progressReading(r){const names=aliasesFor(r),d=describeRun(r),n=e('div');
 if(!d.subgoals.length)n.append(hint(r.delivery.queryReceipt?'本轮是只读查询，没有新建创作子目标。查询检查见执行过程。':'尚未保存子目标或交付合同。'));
 for(const g of d.subgoals){const body=box(g.title,field('当前记录状态',g.status,names),field('执行内容',{operation:g.operation,output:g.output,count:g.artifactCount??g.count,spec:g.spec,constraints:g.constraints,dependsOn:g.dependsOn},names));
  const history=e('ol','','progress-history');let previous='';for(const h of g.history){const fingerprint=JSON.stringify([h.status,h.coverage,h.artifactCount]);if(fingerprint===previous)continue;previous=fingerprint;const li=e('li');li.append(e('strong',label(h.status)),hint(h.at||'时间未记录'),readable({requirementCoverage:h.coverage,已关联产物数:h.artifactCount},names));history.append(li);}body.append(field('完成度更新过程',history.children.length?'以下按任务快照顺序列出。':'未记录逐阶段进度',names),history);
  body.append(field('逐条要求的验收证据',g.coverage.length?g.coverage:'未记录逐条覆盖率，不能从产物数量推算百分比。',names),raw('子目标原始记录',g));n.append(body);
 }return n;
}
export function confirmationReading(r){const names=aliasesFor(r),c=describeRun(r).confirmation,n=e('div');
 n.append(field('本轮入口',c.entry,names),field('本轮需求理解模型调用数',c.intakeCalls,names),field('保存的处理决定',c.operation,names),field('此前保存的批准对象 / 版本',c.before,names),field('本轮批准与任务状态记录',c.history,names));
 n.append(hint(c.note));
 n.append(box('随后做了什么、如何返回',field('后续模型调用',r.contextSnapshots.map((m,i)=>({调用:'第 '+(i+1)+' 次',阶段:names.get(m.phase)||label(m.phase),结果:m.error||((m.output!==null&&m.output!==undefined)?'已有输出记录':'等待返回')})),names),field('实际工具调用',r.tools.map(t=>({name:t.name,status:t.status})),names),field('本轮返回状态',r.status,names),field('返回用户的正文',r.finalResponse.text??'尚无最终返回记录',names),field('已记录的错误',r.errors,names)));
 n.append(disclosure('当前代码的确认处理顺序（机制说明，不等于本轮各检查均已落盘）',readable([
  '按钮请求进入 /api/task/continue：检查会话是否正在运行，加载指定任务，检查是否可继续；待确认任务核对方案指纹。',
  'Agent 显式续跑不重新调用需求理解模型；approveTask 检查活动任务、待确认状态、方案指纹、任务版本及合同指纹，批准后转入规划。',
  '用户输入“确认”仍走 /api/chat 与需求理解；正式接受的操作决定是批准、修订还是新任务，不能仅凭字面确认。',
  '后续按保存的计划和权限执行；最终以工具回执、任务快照与 final 事件说明做了什么、返回什么。',
  '过期或不匹配的按钮请求可能在 HTTP 入口即被拒绝，尚未创建 Run；本页不会伪造这些旧请求的检查记录。'
 ],names)),raw('本轮确认相关证据',c));return n;
}
export function storyView(r,host){
 const d=describeRun(r),names=aliasesFor(r);
 host.append(box('系统如何理解这句话',e('p',displayValue(d.summary,names),'query-text'),hint(d.accepted?'来源：程序接受的需求合同。':r.timeline.find(s=>s.phase==='USER INPUT')?.data?.explicitTarget?'来源：显式续跑入口记录。':'来源：最近一份草稿，尚未证实接受。'),disclosure('意图、约束、引用对象及拒绝草稿',intentReading(r,names))));
 host.append(box('这次走了什么路径',e('p',d.route,'route-text'),hint('路径依据已保存记录归纳；下方逐步证据区分已执行、未返回和缺少记录。'),r.delivery.queryReceipt?field('读取了什么、检查了什么',r.delivery.queryReceipt,names):hint(d.compiled?'已记录 compiled-v1：程序按合同编译执行图；模型调用与程序调度分别展示。':'未取得足够协议证据，不能把计划全部称为模型自主决策。')));
 const plan=box('规划与每个子目标的进度',progressReading(r));
 if(d.nodes.length){const steps=e('ol');d.nodes.forEach((node,i)=>{const li=e('li');li.append(e('h3',`步骤 ${i+1}：${names.get(node.itemId)||label(node.kind)}`),readable({执行方式:label(node.kind),依赖:node.dependsOn?.length?node.dependsOn.map(id=>names.get(id)||'未命名依赖步骤'):'无前置依赖（不代表实际并行）',绑定工具:node.tool||'未绑定媒体工具',选用方法:node.skillId||node.requiredMethods,status:node.status,outputContract:node.outputContract},names));steps.append(li);});plan.append(disclosure('保存的执行步骤与依赖',steps,true));}else plan.append(hint(r.delivery.queryReceipt?'只读查询未建立创作执行图。':'本轮尚无执行图记录。'));
 host.append(plan,box('按实际发生顺序查看',hint('每一步都能展开查看人类可读的完整输入、返回与检查；原始 JSON 作为辅助证据保留。')));
 for(const [index,s] of r.timeline.entries()){
  const c=r.contextSnapshots.find(c=>c.callId===s.id),t=r.tools.find(t=>t.callId===s.id),data=s.data;
  let title=label(s.phase),body=e('div'),summary='';
  if(c){title='模型：'+(names.get(c.phase)||label(c.phase==='unrecorded'?'MODEL':c.phase));summary=c.error?'调用失败：'+c.error:c.output?'已返回；'+c.validations.filter(v=>v.accepted===false).length+' 条拒绝记录':'等待模型返回';body=modelReading(c,r);}
  else if(t){title='工具：'+label(t.name);summary=label(t.status);body=toolReading(t,r);}
  else if(s.phase==='USER INPUT'){summary=data.rawInput;body.append(field('用户原话',data.rawInput,names),field('本轮素材',data.assets,names));}
  else if(s.phase==='INTENT'){summary=displayValue(d.summary,names);body=intentReading(r,names);}
  else if(s.phase==='TASK_STATE'){const snapshot=r.stateSnapshots.find(x=>x.source===s.source+'/task');summary=label(data.task?.status);body=stateReading(r,names,snapshot);}
  else if(s.phase==='FINAL'){summary=label(data.status);body.append(field('实际返回用户的内容',data.text,names),field('返回的产物',data.artifacts,names));}
  else if(s.phase==='PLAN_PROGRESS'){summary=label(data.node?.status);body.append(readable(data.node,names));}
  else {summary=data.error||data.name&&label(data.name)||'';body.append(readable(data,names));}
  const section=e('section','','reading-step'),caption=e('div','','step-caption');caption.append(e('span',String(index+1),'step-number'),e('h3',title),hint(s.at?new Date(s.at).toLocaleString():'时间未记录'));
  section.append(caption,e('p',summary,'reading-text'),disclosure('查看这一步的输入、输出和判断',body,false,'step:'+s.id),raw('原始记录与技术标识',s,'raw-step:'+s.id));host.append(section);
 }
 const hasConfirmation=d.confirmation.operation||d.confirmation.history.some(h=>h.approval?.required);
 host.append(hasConfirmation?box('确认之后发生了什么',confirmationReading(r)):disclosure('确认与续跑（本轮没有确认动作）',confirmationReading(r)),box('最终返回',field('本轮状态',r.status,names),field('返回正文',r.finalResponse.text??'本轮尚无 final 记录',names),field('任务验收结果',r.verification.business,names)),box('当前证据还缺什么',readable(r.missingData,names)));
}
export {readable,stateReading};
