import {registerRequestInputs,validateTextInputs} from './request-input.mjs';
import {messageEvidence} from './conversation-query.mjs';
import {composeFinalResponse} from './final-response.mjs';
import {capabilitySnapshot,loadInspection,renderFacts,queryChecks} from './runtime-facts.mjs';
import {tracedBrain,tracedRuntime,withTrace,immutableEvent} from './trace-context.mjs';
import {acceptRevision,recordTurn,acceptDecision,isAccepted} from './task-contract.mjs';
import {randomUUID} from 'node:crypto';
import {systemPrompt} from './catalog.mjs';
import {rememberUserAssets,rememberAssets} from './assets.mjs';
import {understandGoal,professionalOperations} from './intent.mjs';
import {TaskExecutor} from './execution-engine.mjs';
import {allowedTools} from './tool-policy.mjs';
import {runCompiled} from './compiled-runtime.mjs';
import {storeOf,currentTask,createTask,readyItem,taskSnapshot,taskArtifacts,reconcileTask,transition,approveTask,projectState,ingestInputs} from './task-state.mjs';
const fallback={rewrite:'creative-prompt-rewrite',marketing_script:'video-script-zh-v1',storyboard:'storyboard-one-shot-zh-v2',review_content:'video-prompt-safety-zh-v1'};
const statusText={PENDING:'任务尚未全部完成，已保存成果与剩余要求。',WAIT_CONFIRM:'方案已准备好，请确认后继续。',NEEDS_INPUT:'还需要补充输入。',WAITING:'生成任务已提交，正在等待真实结果；后台会继续查询。',PARTIAL:'任务部分完成，可继续执行剩余项。',BLOCKED:'当前任务尚未完成。',FAILED:'任务执行失败。',REFUSED:'无法执行该请求。',CANCELLED:'已停止后续步骤，已提交任务仍可查询。'};
export class Agent{
 constructor({brain,runtime,catalog,maxSteps=16,save=async()=>{},intake=understandGoal,verifier=null,protocol='legacy',simulation=false,actionMode='shadow',effectPolicy='trusted_embedder'}){Object.assign(this,{brain:tracedBrain(brain),runtime:tracedRuntime(runtime),catalog,maxSteps,save,intake,verifier,protocol,simulation,actionMode,effectPolicy});if(!['explicit_approval','trusted_embedder'].includes(effectPolicy))throw new Error('未知执行授权策略');if(effectPolicy==='explicit_approval'&&runtime)runtime.requireExecutionPermit=true;if(runtime?.brain)runtime.brain=tracedBrain(runtime.brain);if(verifier?.brain)verifier.brain=tracedBrain(verifier.brain);if(verifier?.videoBrain)verifier.videoBrain=tracedBrain(verifier.videoBrain);}
 async run(state,message,emit,signal,control={}){
  validateTextInputs(control.inputs||[]);
  if(control.requestId){const previous=state.turns?.find(t=>t.requestId===control.requestId);if(previous){
   if(previous.rawInput!==message||previous.explicitTarget!==(control.resumeTaskId||null)||(previous.explicitPlanHash||null)!==(control.planHash||null)||JSON.stringify(previous.inputs||[])!==JSON.stringify(control.inputs||[]))throw new Error('同一requestId不能代表不同请求');
   const events=state.events.filter(e=>e.requestId===control.requestId);if(!events.some(e=>e.type==='final'))throw new Error('原请求尚未结束；请恢复其持久任务，不能重新提交');
   for(const event of events)emit(structuredClone(event));return;
  }}
  return withTrace(state,this.save,()=>this.runInternal(state,message,emit,signal,control));
 }
 async runInternal(state,message,emit,signal,control={}){
  state.messages??=[];state.events??=[];state.currentRunId=control.requestId||randomUUID();storeOf(state);
  const focusBefore=storeOf(state).activeTaskId;
  const turn=recordTurn(state,message,control);turn.inputs=structuredClone(control.inputs||[]);
  const publish=async event=>{
   if(event.type==='final'){
    const previous=event.text;event.text=await composeFinalResponse(this.brain,state,turn,event,signal);
    const message=state.messages.findLast(m=>m.role==='assistant');
    if(message&&(typeof message.content==='string'?message.content:(message.content||[]).map(p=>p.text||'').join('\n'))===previous)message.content=[{type:'output_text',text:event.text}];
    event.responseReceipt=turn.responseReceipt;event.answerContract=turn.queryReceipt?.facts?.query?.answerContract||null;
    if(turn.queryReceipt){
     const answered=turn.responseReceipt?.status==='composed';
     turn.queryReceipt.checks.answerGenerated=answered;
     turn.queryReceipt.checks.answerCovered=answered&&turn.responseReceipt.coverage?.status==='evidence_presented';
     turn.queryReceipt.checks.answerCoverageStatus=turn.responseReceipt?.coverage?.status||'not_composed';
     if(!answered){event.status='failed';turn.queryReceipt.status='failed';state.lastTurn={runId:state.currentRunId,status:'failed',taskId:null};}
    }
   }
   messageEvidence(state);if(event.type==='final'){turn.status=event.status;turn.taskId=event.taskId??null;turn.finishedAt=new Date().toISOString();}const saved=immutableEvent(state,event);state.events.push(saved);await this.save(state);emit(structuredClone(saved));
  };
  const record=async(name,args,result,callId='exec_'+randomUUID(),automatic=false,context={})=>{
   const store=storeOf(state);store.toolCalls??={};const span=Object.values(store.toolCalls).findLast(c=>c.runId===state.currentRunId&&c.name===name&&!c.published&&JSON.stringify(c.args)===JSON.stringify(args));if(span){callId=span.id;span.published=true;}store.toolCalls[callId]={...(store.toolCalls[callId]||{}),id:callId,taskId:Object.hasOwn(context,'taskId')?context.taskId:currentTask(state)?.id,runId:state.currentRunId,requestId:state.currentRunId,name,args,result,startedAt:store.toolCalls[callId]?.startedAt||new Date().toISOString(),timing:span?'execution_span':'logical_commit',status:result.isError?'failed':'completed',automatic,finishedAt:new Date().toISOString()};
   state.messages.push({type:'function_call',name,call_id:callId,arguments:JSON.stringify(args)},{type:'function_call_output',call_id:callId,output:JSON.stringify(result)});
   if(!result.isError)rememberAssets(state,result,name);
   await publish({type:'tool_result',name,callId,result:['use_skill','read_skill','read_skill_reference'].includes(name)&&!result.isError?{slug:args.slug,loaded:true,automatic,contract:result.contract}:result,media:!!(result.images||result.videoUrl||result.audioUrl||result.taskId&&!result.itemId)});
   await publish({type:'task_state',task:taskSnapshot(state)});
  };
  const executor=new TaskExecutor({state,runtime:this.runtime,catalog:this.catalog,brain:this.brain,save:this.save,record,verifier:this.verifier});
  const answered=new Set(state.messages.filter(m=>m.type==='function_call_output').map(m=>m.call_id));
  for(const call of state.messages.filter(m=>m.type==='function_call'&&!answered.has(m.call_id)))state.messages.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify({isError:true,text:'上轮中断，先读取持久执行记录，不重复提交。'})});
  try{
   let task=currentTask(state);
   if(control.resumeTaskId){
    task=storeOf(state).tasks[control.resumeTaskId];if(task)storeOf(state).activeTaskId=task.id;
    if(task?.supersededBy)throw new Error('该任务已被修订取代');
    if(!task||task.id!==control.resumeTaskId)throw new Error('恢复对象不是当前任务');
    turn.taskId=task.id;turn.revision=task.revision;turn.decision={status:'accepted',operations:[{operation:control.planHash?'approve':'resume',targetTaskId:task.id,targetRevision:task.revision,evidence:control}]};
    if(control.planHash)approveTask(state,task.id,control.planHash);
    else if(task.status==='WAIT_CONFIRM')throw new Error('具体方案尚未确认');
    if(['REFUSED','COMPLETED','NEEDS_INPUT'].includes(task.status))throw new Error('该任务不能直接续跑，请补充需求或创建新版本');
    (task.continuationEvidence??=[]).push({requestId:state.currentRunId,source:'explicit_control',text:message});
    transition(state,'PLANNING');
   }else{
    const snapshot=taskSnapshot(state);rememberUserAssets(state,message);ingestInputs(state);state.messages.push({role:'user',content:message});
    const currentMessage=messageEvidence(state).at(-1);registerRequestInputs(state,currentMessage,control.inputs||[]);
    await publish({type:'start',runId:state.currentRunId,sessionId:state.id});
    let goal;const begin=Date.now();
    try{goal=await this.intake(this.brain,this.catalog,{query:message,currentMessage,actionMode:this.actionMode,userMemory:state.userMemory||[],strictControl:this.protocol==='compiled',auditContracts:true,taskCandidates:Object.values(storeOf(state).tasks).map(t=>({...t,artifacts:taskArtifacts(state,t)})),runtimeFacts:capabilitySnapshot(this.runtime,this.catalog),taskSnapshot:snapshot,sessionId:state.id,runId:state.currentRunId,replyTo:control.replyTo||null,recentTurns:(state.turns||[]).filter(t=>t.runId!==state.currentRunId).slice(-4),messages:messageEvidence(state).slice(0,-1),history:messageEvidence(state).slice(0,-1).slice(-8),assets:[...Object.values(storeOf(state).inputs||{}),...(state.assets||[])].slice(-60)},signal);}
    catch(error){
     await publish({type:'intent_error',durationMs:Date.now()-begin,error:error.message,intakeTrace:error.intakeTrace,partialSemantic:error.partialSemantic});
     if(!currentTask(state))state.status='failed';state.lastTurn={runId:state.currentRunId,status:'failed',taskId:null};turn.status='failed';turn.error=error.message;
     turn.failureReceipt={stage:error.intakeStage||'understand_validation',origin:'system_intake',code:error.code||'contract_validation',message:error.message,issues:error.repairIssues||error.issues||[],partialIntent:error.partialSemantic||null,accepted:false,executed:false};
     const text=error.partialSemantic?'已收到需求，但系统在整理请求时遇到错误，本轮尚未执行。':'系统未能完成本轮请求解析，尚未执行。';state.messages.push({role:'assistant',type:'message',content:[{type:'output_text',text}]});
     await publish({type:'final',text,status:'failed',taskId:null,artifacts:[]});return;
    }
    if(goal.semantic?.continuation?.taskId&&goal.semantic.continuation.mode!=='new'){task=storeOf(state).tasks[goal.semantic.continuation.taskId]||task;}
    if(goal.readOnlyTurn)turn.restoreFocus=focusBefore;
    acceptDecision(turn,goal,task);turn.businessAction=structuredClone(goal.businessAction||null);
    if(goal.readOnlyTurn&&goal.safety.disposition==='allow'){
     // A query has a turn receipt, not a new production task or artifact version.
     const facts=await loadInspection(executor,goal.tasks[0],signal),checks=queryChecks(facts);
     const status=checks.completionAllowed?'completed':'blocked',text=checks.completionAllowed?'已读取所需记录，回答整理暂未完成。':'所需记录不完整。';
     turn.queryReceipt={facts,checks,status};state.lastTurn={runId:state.currentRunId,status,taskId:null};
     if(!task)state.status=status;
     state.messages.push({role:'assistant',type:'message',content:[{type:'output_text',text}]});
     await publish({type:'intent',runId:state.currentRunId,goal,decision:turn.decision,durationMs:Date.now()-begin});
     await publish({type:'final',text,status,taskId:null,artifacts:[],queryReceipt:turn.queryReceipt});storeOf(state).activeTaskId=focusBefore;projectState(state);await this.save(state);return;
    }
    if(goal.cancelTaskId){task=storeOf(state).tasks[goal.cancelTaskId];if(!task)throw new Error('取消对象不存在');storeOf(state).activeTaskId=task.id;task.cancelledByUser=true;task.cancellation={requestId:state.currentRunId,evidence:message,at:new Date().toISOString()};transition(state,'CANCELLED','用户取消了未完成执行义务；已提交任务仅查询已有回执。');await this.finish(state,publish);return;}
    if(goal.resumeTaskId&&task?.id===goal.resumeTaskId)storeOf(state).activeTaskId=task.id;
    if(goal.resumeTaskId&&task?.id===goal.resumeTaskId){(task.continuationEvidence??=[]).push({requestId:state.currentRunId,messageId:messageEvidence(state).at(-1)?.messageId,text:message});
     if(goal.semantic.continuation.mode==='approve'&&task.status==='WAIT_CONFIRM'&&task.effectPolicy!=='explicit_approval')approveTask(state,task.id,task.approval.planHash,{source:'interpreted_intent'});
     else if(task.status==='WAIT_CONFIRM'){await this.finish(state,publish);return;}
     if(task.status==='REFUSED')throw new Error('已拒绝任务不能恢复');transition(state,'PLANNING');
    }else if(task?.status==='NEEDS_INPUT'&&goal.semantic?.continuation?.mode==='clarify'&&goal.semantic.continuation.taskId===task.id){
     const previous=task,replacement=createTask(state,goal,previous.query+'\n补充：'+message);delete storeOf(state).tasks[replacement.id];replacement.id=previous.id;replacement.createdAt=previous.createdAt;replacement.revision=previous.revision+1;replacement.revisions=structuredClone(previous.revisions||[]);replacement.previousGoal=structuredClone(previous.goal);replacement.approval.required ||=previous.approval.required;replacement.approval.status=replacement.approval.required?'pending':'not_required';storeOf(state).tasks[previous.id]=replacement;storeOf(state).activeTaskId=previous.id;task=replacement;projectState(state);
    }else task=createTask(state,goal,message,{parentTaskId:goal.semantic?.continuation?.mode==='revise'?goal.semantic.continuation.taskId:null});
    if(!task.contract||task.contract.version!==task.revision){task.effectPolicy=this.effectPolicy;if(this.effectPolicy==='explicit_approval'&&task.items.some(i=>['image','video','audio'].includes(i.output)&&!i.runtimeQuery)){task.approval.required=true;task.approval.status='pending';task.approval.source='explicit_control';}}
    if(!task.contract||task.contract.version!==task.revision)acceptRevision(task,state.currentRunId);turn.taskId=task.id;turn.revision=task.revision;
    await publish({type:'intent',runId:state.currentRunId,goal,decision:turn.decision,durationMs:Date.now()-begin});await publish({type:'task_state',task:taskSnapshot(state)});
    if(task.status==='REFUSED'){task.reason=task.goal.safety.reason;await this.finish(state,publish);return;}
    if(task.status==='NEEDS_INPUT'){task.reason=task.goal.missingInputs.join('；');await this.finish(state,publish);return;}
   }
   if(this.effectPolicy==='explicit_approval'&&task.items.some(i=>['image','video','audio'].includes(i.output)&&!i.runtimeQuery)&&task.effectPolicy!=='explicit_approval'){task.effectPolicy='explicit_approval';task.approval={required:true,status:'pending',planHash:null,source:'explicit_control'};}
   await this.save(state);let incompleteReplies=0,lastText='';
   if(this.protocol==='compiled'||task.protocol==='compiled-v1'){
    task.validationMode=this.simulation?'simulation':'production';await runCompiled(executor,signal,publish);await this.finish(state,publish);return;
   }
   if(task.approval.status==='approved'&&task.approval.payload){
    const payload=task.approval.payload,item=task.items.find(i=>i.id===payload.itemId);
    if(item&&item.status!=='COMPLETED'){
     if(payload.batchId)await executor.executeBatch(payload.batchId,item,signal);
     else if(payload.items?.length===1){const result=await executor.submit(payload.tool,payload.items[0],item,signal,{approved:true});await record(payload.tool,payload.items[0],result);}
    }
   }
   for(let step=0;step<this.maxSteps;step++){
    signal.throwIfAborted();reconcileTask(state);
    if(task.status==='WAITING'){await executor.refresh(signal);await publish({type:'task_state',task:taskSnapshot(state)});}
    if(['WAIT_CONFIRM','NEEDS_INPUT','BLOCKED','WAITING','REFUSED'].includes(task.status)){await this.finish(state,publish,lastText);return;}
    const item=readyItem(state);
    if(item){
     const selected=task.goal.skills.filter(slug=>this.catalog.skills.find(s=>s.slug===slug)?.contract.operations.includes(item.operation));
     if(!selected.length&&professionalOperations.has(item.operation))selected.push(fallback[item.operation]);
     for(const slug of selected){if(item.methods.some(m=>m.skillId===slug))continue;const args={slug,task:item.description},result=await executor.execute('use_skill',args,item,signal);await record('use_skill',args,result,undefined,true);}
    }
    const scoped=item?allowedTools(state,item):[];
    const input=[{role:'system',content:systemPrompt(this.catalog)+'\n'+executionRules+'\n实际服务配置：'+JSON.stringify(this.runtime.capabilities?.()||{})},...state.messages,{role:'system',content:'唯一任务状态：'+JSON.stringify(taskSnapshot(state))+'\n当前交付项：'+JSON.stringify(item||null)+'。'+(task.status==='COMPLETED'?'所有技术交付已齐，请返回最终正文与真实Artifact。不得再生成。':'只执行当前可用阶段，工具错误后修正计划。')}];
    if(JSON.stringify(input).length>420000)throw new Error('任务上下文过长，请保留Artifact并新建任务');
    const output=await this.brain.respond(input,scoped,signal);if(!output?.length)throw new Error('模型返回空内容');
    const calls=output.filter(o=>o.type==='function_call'),texts=output.filter(o=>o.type==='message').flatMap(o=>o.content||[]).filter(p=>p.type==='output_text').map(p=>p.text).join('\n');
    if(!calls.length){
     if(task.status==='COMPLETED'){await this.finish(state,publish,texts);return;}
     if(item&&['generate_image','edit_image','generate_video'].includes(item.operation)&&task.approval.required&&!task.approval.planHash){
      try{await executor.prepareApproval(item,signal);await this.finish(state,publish);return;}
      catch(error){state.messages.push({role:'system',content:'待确认方案必须先保存有效具体参数：'+error.message});}
     }
     if(item?.output==='text'&&texts.trim()){
      try{const result=await executor.execute('commit_text_deliverable',{content:texts},item,signal);await record('commit_text_deliverable',{content:texts},result);lastText=texts;incompleteReplies=0;if(task.status==='COMPLETED'){await this.finish(state,publish,texts);return;}continue;}
      catch(error){state.messages.push({role:'system',content:'交付验证失败：'+error.message});}
     }else state.messages.push({role:'system',content:'本轮尚缺实际产物，不能仅交方案或声称成功。请执行当前目标、查询真实结果；缺配置则defer_current_stage。'});
     if(++incompleteReplies>=3){transition(state,'BLOCKED','缺少实际工具观察或任务产物');await this.finish(state,publish);return;}continue;
    }
    if(calls.length>32)throw new Error('单轮请求超过执行预算');
    if(texts)state.messages.push({role:'assistant',type:'message',content:[{type:'output_text',text:texts}]});
    for(const call of calls){
     signal.throwIfAborted();let args={},result;
     try{args=JSON.parse(call.arguments);if(!scoped.some(t=>t.name===call.name))throw new Error('本阶段未开放该工具，请遵守用户交付范围');
      if(['WAIT_CONFIRM','NEEDS_INPUT','BLOCKED','REFUSED'].includes(task.status))throw new Error('任务已暂停，不再执行后续工具');
      const store=storeOf(state);store.toolCalls??={};store.toolCalls[call.call_id]={id:call.call_id,taskId:task.id,itemId:item?.id,name:call.name,args,status:'running',startedAt:new Date().toISOString()};
      await publish({type:'tool_start',name:call.name,callId:call.call_id});result=await executor.execute(call.name,args,item,signal);
     }catch(error){result={isError:true,text:error.message};}
     await record(call.name,args,result,call.call_id);if(call.name==='update_plan'&&!result.isError)await publish({type:'plan',...args});
    }
    if(task.status==='WAIT_CONFIRM'||task.status==='NEEDS_INPUT'){await this.finish(state,publish);return;}
   }
   reconcileTask(state);if(task.status!=='COMPLETED'&&task.status!=='WAITING')transition(state,'PARTIAL',`本轮达到${this.maxSteps}轮上限，已保存进度，可继续剩余项`);await this.finish(state,publish);
  }catch(error){if(!turn.taskId){const text='本轮执行入口失败：'+error.message;turn.error=error.message;state.lastTurn={runId:state.currentRunId,status:'failed',taskId:null};state.messages.push({role:'assistant',content:text});await publish({type:'final',text,status:'failed',taskId:null,artifacts:[]});return;}const task=currentTask(state);if(task&&!['REFUSED','WAIT_CONFIRM','NEEDS_INPUT','COMPLETED'].includes(task.status))transition(state,signal.aborted?'CANCELLED':'FAILED',error.message);else if(!task)state.status=signal.aborted?'cancelled':'failed';await this.finish(state,publish,error.message);}
 }
 async finish(state,publish,text=''){
  const task=currentTask(state);projectState(state);const delivered=a=>isAccepted(a)||a.verification?.technical==='passed'&&a.verification?.semantic!=='failed'&&a.publication!=='audit'&&task?.requirements?.some(r=>r.status==='fulfilled'&&r.artifactIds.includes(a.id));
  let finalText=task?.status==='COMPLETED'?text||(task?.verification?.quality==='not_evaluated'?'流程已完成，内容质量未评估。':'产物已返回，验收通过。'):task?.status==='SIMULATED'?'模拟执行检查通过；未生成真实媒体，未进行视觉验收。':(statusText[task?.status]||'任务尚未完成。')+(task?.reason?'\n'+task.reason:'');
  if(!task)finalText=text||'任务入口失败，尚未执行生成。';
  if(task?.status==='WAIT_CONFIRM')finalText+='\n确认仅针对当前展示的方案；修改方案后需要重新确认。';
  if(task?.items.some(i=>['image','video','audio'].includes(i.output))){const known=new Set([...(state.assets||[]).map(a=>a.url),...taskArtifacts(state).map(a=>a.url)].filter(Boolean));const urls=[...finalText.matchAll(/https?:\/\/[^\s<>"\)\]，。；]+/g)].map(m=>m[0]);if(urls.some(url=>!known.has(url)))finalText=task.status==='COMPLETED'?'本次成果已返回，真实地址如下。':(statusText[task.status]||'任务尚未完成。')+(task.reason||'');}
  for(const a of taskArtifacts(state)){
   if(task?.protocol==='compiled-v1'?!delivered(a):a.purpose!=='deliverable'||a.verification.semantic==='failed')continue;
   if(a.type==='text'&&a.content&&(task?.protocol==='compiled-v1'||!finalText.includes(a.content)))finalText+='\n\n'+(a.metadata.deliverySlot!==undefined?'文档 '+(a.metadata.deliverySlot+1)+'\n':'')+a.content;
   if(a.url&&!finalText.includes(a.url))finalText+='\n\n'+a.type+'：'+a.url;
  }
  const bareText=task?.status==='COMPLETED'&&task.items.every(i=>i.output==='text'&&['title','prompt','answer'].includes(i.form));
  if(bareText)finalText=taskArtifacts(state).filter(isAccepted).filter(a=>a.type==='text').map(a=>a.content).join('\n\n');
  for(const item of task?.items||[])if(item.readReceipt?.text)finalText+='\n\n'+item.readReceipt.text;
  if(task?.changeSets){const rows=Object.values(task.changeSets).flatMap(g=>Object.values(g.targets));finalText+='\n\n文档更新：\n'+rows.map(r=>`${r.source.id} v${r.source.version}：${r.status==='published'?'已发布新版本':r.status==='no_change'?'无需变化，保留原版本':r.status==='failed'?'未完成：'+(r.error||r.verification?.issues?.join('；')||'验收未通过'):'待处理'}`).join('\n');}
  if(task?.items.some(i=>i.coverage)){const all=task.items.filter(i=>i.coverage);finalText+='\n\n来源内容覆盖：'+all.map(i=>(i.coverageProgress?.covered?.length||0)+'/'+i.coverage.unitIds.length).join('、')+'。';}
  if(!bareText&&!task?.items.some(i=>i.coverage)&&task?.goal.assumptions?.length&&!finalText.includes('假设'))finalText+='\n\n本次假设：'+task.goal.assumptions.join('；');
  if(taskArtifacts(state).some(a=>['image','video','audio'].includes(a.type)&&!['passed','failed'].includes(a.verification.semantic)))finalText+='\n\n内容检查：已确认工具返回；部分成果的内容质量尚未核验。';
  state.lastTurn={runId:state.currentRunId,status:state.status,taskId:task?.id};const turn=state.turns?.find(t=>t.runId===state.currentRunId);if(turn){turn.status=state.status;turn.taskId=task?.id;turn.finishedAt=new Date().toISOString();}
  state.messages.push({role:'assistant',type:'message',content:[{type:'output_text',text:finalText}]});await publish({type:'task_state',task:taskSnapshot(state)});await publish({type:'final',text:finalText,status:state.status,taskId:task?.id,artifacts:taskArtifacts(state).filter(delivered)});
  if(turn&&Object.hasOwn(turn,'restoreFocus')){storeOf(state).activeTaskId=turn.restoreFocus;projectState(state);await this.save(state);}
 }
}
const executionRules=`你围绕持久任务执行Plan–Execute–Verify。task_state是唯一状态源，聊天里说过完成不代表完成。系统只开放当前交付项可用工具。状态由真实Artifact和执行记录计算，不由update_plan的done标签决定。
专业文字可以run_skill获得符合合同的结构化内容，也可use_skill后创作并commit_text_deliverable。正文不是“将要做”的计划。每个交付项分别提交，禁止一份正文冒充不同任务。参考资料必须使用返回的完整path，不能猜路径。
多图/多视频优先propose_image_batch/propose_video_batch保存全部参数，再execute_batch；执行器负责逐项持久化、去重和查询，不需十次模型调用。每条视频参数与分镜时长一致，不把30秒内容挤进12秒并声称完整成片。计划失败后根据issues修改；最多一次额外媒体修复预算。
用户仅在明确要求时确认。需要确认的媒体阶段也必须先调用propose_image_batch/propose_video_batch把具体执行参数存下，这不会提交付费生成；只交文字方案不等于进入WAIT_CONFIRM。WAIT_CONFIRM必须停下，不能自行批准。普通已授权生成不额外询问。持久taskSnapshot包含计划、执行和Artifact，不重复创造批次。只有属于用户的原图或本轮真实产物能作为引用。
验证失败的Artifact保留版本与反馈，修复时运用合适Skill重新规划，不能冒充质量通过。模拟或无法观察的媒体只证明技术返回，不声称视觉审核通过。`;
