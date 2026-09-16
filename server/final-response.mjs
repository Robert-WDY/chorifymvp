import {finalResponsePrompt} from './prompt-text.mjs';
import {completionFacts} from './task-requirements.mjs';
import {isAccepted} from './task-contract.mjs';
import {validationTrace} from './trace-context.mjs';
import {assistantProse} from '../dist/reply-view.js';
const textOf=m=>typeof m.content==='string'?m.content:(m.content||[]).map(p=>p.text||'').join('\n');
const renderSource=a=>a.type==='image'&&a.url?'![图片 v'+a.version+']('+a.url+')':a.content||a.url;
function savedPlan(task,store,receipt){
 // A saved read receipt can refer to an earlier revision. Never substitute the active task.
 const selected=receipt&&receipt.revision!==task.revision?receipt:task;
 const approval=selected.approval,node=selected.executionPlan?.nodes?.find(n=>n.itemId===approval?.payload?.itemId);
 const artifact=node?store.artifacts[node.skillArtifactId]:null;
 if(!approval?.payload?.items?.length&&!receipt?.proposals?.length)return null;
 return {taskId:task.id,revision:selected.revision,summary:selected.goal?.summary||selected.summary,
  approval:approval?{required:approval.required,status:approval.status,planHash:approval.planHash}:null,
  ...(approval?.payload?.items?{parameters:structuredClone(approval.payload.items)}:{}),
  ...(artifact?{artifact:{id:artifact.id,version:artifact.version,concept:artifact.metadata?.structure?.concept}}:receipt?.proposals?{proposals:receipt.proposals}:{})};
}
export function projectResponseInput(context){
 const view=structuredClone(context),facts=view.facts;
 if(facts?.completion){
  facts.completion=facts.completion.map(c=>{const index=view.state.selectedTasks.findIndex(t=>t.taskId===c.taskId&&JSON.stringify(t.requirements)===JSON.stringify(c.requirements));return index<0?c:{taskId:c.taskId,contextRef:'/state/selectedTasks/'+index};});
 }
 if(facts?.tasks)facts.tasks=facts.tasks.map(t=>{const index=view.savedPlans.findIndex(p=>p.taskId===t.id&&p.revision===t.revision);if(index<0)return t;const {plan,approval,batches,proposals,...identity}=t;return {...identity,savedPlanRef:'/savedPlans/'+index};});
 // Exact quotations remain readable once; duplicate presentation aliases point to entries.
 if(facts?.query?.type==='presentation'){
  for(const key of ['artifacts','messages'])if(facts[key])facts[key]=facts[key].map(a=>{const index=facts.entries?.findIndex(e=>e.id===a.id&&e.content===a.content&&e.url===a.url);return index>=0?{id:a.id,version:a.version,contextRef:'/facts/entries/'+index}:a;});
  view.selectedSources=view.selectedSources.map(({content,url,...a})=>({...a,delivery:'program_attached'}));
 }
 if(['task_plan','presentation'].includes(facts?.query?.type)&&!view.failure){delete view.executionMessage;view.executionMessageSource=facts.query.type==='task_plan'?'/savedPlans':'program_attached';}
 return view;
}
export function responseContext(state,turn,event){
 const store=state.taskStore||{tasks:{},artifacts:{},executions:{}};
 const tasks=Object.values(store.tasks).filter(t=>!t.goal?.readOnlyTurn&&(turn.queryReceipt?.facts?.query?.taskIds?.includes(t.id)||!t.supersededBy));
 const selected=turn.queryReceipt?.facts?.query?.taskIds||[];
 const task=store.tasks[event.taskId];
 const ledgerQuery=['artifact_inventory','task_plan','task_inspect','execution_inspect'].includes(turn.queryReceipt?.facts?.query?.type);
 const scopeTasks=selected.length?tasks.filter(t=>selected.includes(t.id)):task?[task]:ledgerQuery?tasks:[];
 const artifacts=Object.values(store.artifacts).filter(a=>a.purpose==='deliverable');
 const references=new Set((turn.decision?.semantic?.deliverables||[]).flatMap(d=>[...(d.references||[]),...(d.supportingSources||[])]));
 const messages=(state.messages||[]).filter(m=>['user','assistant'].includes(m.role));
 // Only the immediately relevant answer is supplied, not the entire chat again.
 const prior=turn.queryReceipt?.facts?.query?.type==='history'?messages.slice(0,-1).findLast(m=>m.role==='assistant'):null;
 const dimensions=turn.queryReceipt?.facts?.query?.answerContract?.questionDimensions||turn.decision?.semantic?.deliverables?.map(d=>d.description)||[];
 const savedArtifacts=(event.artifacts||[]).map(a=>store.artifacts[a.id]).filter(Boolean);
 const answerContract=turn.queryReceipt?.facts?.query?.answerContract;
 const sessionCounts=ledgerQuery&&answerContract?.scope==='session'&&dimensions.some(d=>['required_count','produced_count','remaining_count','completion_status'].includes(d));
 return {
  executionReceipt:{contractAccepted:turn.decision?.status==='accepted',executionStatus:event.status,artifactIds:savedArtifacts.map(a=>a.id),failureStage:turn.failureReceipt?.stage||task?.recovery?.kind||null},
  query:turn.rawInput,answerContract:{...turn.queryReceipt?.facts?.query?.answerContract,questionDimensions:dimensions.length?dimensions:[turn.rawInput]},
  facts:turn.queryReceipt?.facts?{...turn.queryReceipt.facts,sources:undefined}:null,turnStatus:event.status,
  savedPlans:scopeTasks.map(t=>savedPlan(t,store,turn.queryReceipt?.facts?.tasks?.find(record=>record.id===t.id))).filter(Boolean),
  state:{activeTaskId:ledgerQuery||task?store.activeTaskId:null,selectedTasks:scopeTasks.map(t=>completionFacts(t,store)),...(sessionCounts?{sessionMedia:Object.fromEntries(['image','video','audio'].map(kind=>[kind,{produced:artifacts.filter(a=>a.type===kind&&a.sourceExecutionId&&store.executions[a.sourceExecutionId]?.status==='succeeded').length,accepted:artifacts.filter(a=>a.type===kind&&isAccepted(a)).length}]))}:{})},
  artifacts:savedArtifacts.map(a=>({id:a.id,type:a.type,version:a.version,content:a.content,url:a.url,dependsOn:a.dependsOn,parentArtifact:a.parentArtifact,accepted:isAccepted(a)||a.publication==='superseded'&&!!task?.requirements?.some(r=>r.status==='fulfilled'&&r.artifactIds.includes(a.id)),delivered:isAccepted(a)||a.verification?.technical==='passed'&&a.verification?.semantic!=='failed'&&a.publication!=='audit'&&!!task?.requirements?.some(r=>r.status==='fulfilled'&&r.artifactIds.includes(a.id))})),
  selectedSources:turn.queryReceipt?.facts?.sources||artifacts.filter(a=>references.has(a.id)).map(a=>({id:a.id,type:a.type,content:a.content,url:a.url,version:a.version})),
  priorAnswer:turn.queryReceipt&&prior?{messageId:prior.messageId,content:textOf(prior)}:undefined,
  executionMessage:event.text||'',unacceptedIntent:!turn.decision?turn.intentSnapshot:null,
  failure:turn.failureReceipt||null,
  acceptance:(event.artifacts||[]).map(a=>({artifactId:a.id,delivery:a.acceptance?.delivery||null,constraintChecks:a.acceptance?.constraintChecks||a.metadata?.constraintChecks||null,qualityStatus:a.acceptance?.quality?.status||'not_evaluated',factualSupport:a.acceptance?.factualSupport||'not_checked'})),
  limitations:{legacyTaskScopeMayBeIncomplete:scopeTasks.some(t=>t.intentSnapshot?.origin!=='first_parsed_intent')}
 };
}
// This proves that ledger dimensions were presented, not that free-form prose is true.
export function answerEvidence(context){
 const dimensions=context.answerContract.questionDimensions;
 const supported=new Set(['completion_status','required_count','produced_count','remaining_count']);
 const tasks=context.state.selectedTasks,requested=dimensions.filter(d=>supported.has(d));
 const canPresent=requested.length>0&&tasks.length>0&&tasks.every(t=>t.requirements.length>0);
 const rows=canPresent?tasks.flatMap(t=>{
  const lines=[];
  if(requested.includes('completion_status'))lines.push('任务完成情况：'+(t.completionStatus==='fulfilled'?'已完成':'尚未全部完成'));
  for(const [kind,c] of Object.entries(t.byType)){
   if(!c.required&&!c.produced)continue;
   const counts=[];
   if(requested.includes('required_count'))counts.push('要求 '+c.required);
   if(requested.includes('produced_count'))counts.push('已生成 '+c.produced);
   if(requested.includes('remaining_count'))counts.push('待交付 '+c.remaining);
   if(counts.length)lines.push(({image:'图片',video:'视频',audio:'音频',text:'文字内容'})[kind]+'：'+counts.join('，'));
  }
  if(!t.scopeVerified)lines.push('以上是旧账本记录，尚未核实是否覆盖原始请求的全部要求。');
  return ['任务：'+t.request,...lines].join('\n');
 }):[];
 const items=dimensions.map(d=>({dimension:d,status:canPresent&&supported.has(d)&&tasks.every(t=>t.scopeVerified)?'evidence_presented':'unverified'}));
 return {text:rows.join('\n\n'),coverage:{status:items.length&&items.every(i=>i.status==='evidence_presented')?'evidence_presented':'unverified',items,semanticVerified:false}};
}
export async function composeFinalResponse(brain,state,turn,event,signal){
 const context=responseContext(state,turn,event);
 const documents=context.artifacts.filter(a=>a.type==='text'&&a.delivered);
 const presented=context.facts?.query?.type==='presentation'?context.facts.entries||[]:[];
 const protectedDelivery=!!(turn.failureReceipt||event.taskId||turn.taskId)&&!turn.queryReceipt;
 const task=state.taskStore?.tasks?.[event.taskId||turn.taskId];
 const waiting=task?.items?.filter(i=>i.activation?.timing==='after_user_input').map(i=>i.activation.condition)||[];
 const notice=turn.failureReceipt?'系统未能完成本轮请求整理，尚未执行生成。':waiting.length?(context.artifacts.some(a=>a.delivered)?'已保存本轮完成的成果，后续等待：':'需求已保留，尚未产生成果，需要补充：')+waiting.join('；'):task?.status==='NEEDS_INPUT'?'还需要补充：'+(task.goal?.missingInputs||[]).join('；'):['completed','simulated'].includes(event.status)?'':'本轮尚未全部完成。'+(task?.reason||'已保留执行记录和已有成果。');
 const constraintNotice=context.acceptance.some(a=>a.constraintChecks?.status==='failed')?'成果已保存，但结构化数值约束存在差异，请查看任务详情。':'';
 const deliveryText=()=>[notice,constraintNotice,...(task?.items||[]).filter(i=>i.readReceipt).map(i=>i.readReceipt.text),...documents.map(a=>a.content),...context.artifacts.filter(a=>a.type!=='text'&&a.delivered&&a.url).map(a=>a.type+'：'+a.url)].filter(Boolean).join('\n\n')||'本轮没有可交付的已保存产物。';
 if(protectedDelivery){
  const expected=context.artifacts.filter(a=>a.delivered).map(a=>a.id);
  turn.responseReceipt={status:'composed',source:'saved_artifact_projection',contractAccepted:context.executionReceipt.contractAccepted,artifactIds:expected,stateMutationAllowed:false,toolCallsAllowed:false};
  validationTrace({phase:'final_response',accepted:true,receipt:turn.responseReceipt});return deliveryText();
 }
 const input=[{role:'system',content:finalResponsePrompt},
  {role:'user',content:JSON.stringify(projectResponseInput(context))}];

 try{
  const output=await brain.respond(input,[],signal,{tracePhase:'final_response'});
  if(output.some(o=>o.type==='function_call'||o.tool_calls?.length))throw new Error('回答阶段没有工具权限');
  let answer=output.filter(o=>o.type==='message').flatMap(o=>o.content||[]).filter(p=>p.type==='output_text'||p.type==='text').map(p=>p.text||'').join('\n').trim();
  // Some adapters wrap plain answers in their legacy JSON envelope.
  if(answer.startsWith('{')){try{const value=JSON.parse(answer);if(typeof value.answer==='string')answer=value.answer;else if(typeof value.content==='string')answer=value.content;else throw new Error('回答缺少正文');}catch{throw new Error('回答阶段未返回可读正文');}}
  if(!answer)throw new Error('回答为空');
  answer=assistantProse(answer);
  const evidence=answerEvidence(context);
  // Keep a concrete execution failure visible if the composer omitted it. Intake
  // schema diagnostics already have a typed receipt and belong in Debug, not prose.
  const executionNotice=!turn.failureReceipt&&!turn.queryReceipt&&!['completed','simulated'].includes(event.status)?event.text:null;
  const attachments=[evidence.text,...documents.map(a=>a.content),...context.artifacts.filter(a=>a.type!=='text'&&a.delivered&&a.url).map(a=>a.type+'：'+a.url),...presented.map(renderSource),executionNotice].filter(Boolean);
  const text=[answer,...attachments.filter(s=>!answer.includes(s))].join('\n\n');
  turn.responseReceipt={status:'composed',source:'final_response_model',coverage:evidence.coverage,stateMutationAllowed:false,toolCallsAllowed:false};
  validationTrace({phase:'final_response',accepted:true,answerContract:context.answerContract,receipt:turn.responseReceipt});
  return text;
 }catch(error){
  // A presentation failure must not roll back accepted artifacts or resubmit media.
  turn.responseReceipt={status:'fallback',reason:error.message,stateMutationAllowed:false,toolCallsAllowed:false};
  validationTrace({phase:'final_response',accepted:false,error:error.message});
  return protectedDelivery?deliveryText():event.text||'本轮记录已保存，回答整理暂未成功。';
 }
}
