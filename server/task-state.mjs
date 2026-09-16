import {itemDefinition} from './execution-projection.mjs';
import {isDeferred,stageSummary} from './stage-contract.mjs';
import {recordChange} from './change-set.mjs';
import {coverageStatus,requirementCoverage} from './source-coverage.mjs';
import {unresolvedScope} from './workflow-contract.mjs';
import {methodSatisfied,methodExecution,isAccepted} from './task-contract.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {initializeRequirements,reconcileRequirements,fulfillmentArtifacts} from './task-requirements.mjs';

export function clientStatus(state,{running=false,monitoring=false}={}){const status=state.lastTurn?.status==='failed'?'failed':state.status;return running||monitoring&&status==='running'?'running':status==='running'?'interrupted':status;}
export const terminalStates=new Set(['COMPLETED','REFUSED','CANCELLED']);
export function taskActions(task,executions=[]){
 if(executions.some(e=>e.taskId===task?.id&&['pending','unknown'].includes(e.status)&&!e.providerTaskId))task={...task,recovery:{kind:'receipt_reconciliation'}};
 const canResume=!!task&&!task.cancelledByUser&&!task.supersededBy&&!['unsupported','missing_quote','receipt_reconciliation'].includes(task.recovery?.kind)&&['PENDING','PARTIAL','WAITING','WAIT_CONFIRM','FAILED','CANCELLED','BLOCKED','PLANNING','EXECUTING','VERIFYING'].includes(task.status);
 return {canResume,awaitingReconciliation:task?.recovery?.kind==='receipt_reconciliation',requiresApproval:task?.status==='WAIT_CONFIRM',resumeLabel:task?.status==='WAIT_CONFIRM'?'确认并执行此方案':'继续剩余任务'};
}
const stamp=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function storeOf(state){
 if(state.taskStore){const store=state.taskStore;if(!store.artifactDagVersion){for(const a of Object.values(store.artifacts||{})){a.dependsOn??=[...new Set((a.relationships||[]).map(r=>r.artifactId).concat(a.parentId||[]))];a.parentArtifact??=a.parentId||null;}store.artifactDagVersion=1;}return store;}
 const store=state.taskStore={version:1,activeTaskId:null,tasks:{},artifacts:{},executions:{},toolCalls:{},decisions:[],inputs:{}};
 for(const asset of state.assets||[])store.inputs[asset.assetId]=asset;
 for(const [bucket,tool] of [['videoTasks','generate_video'],['mediaTasks','legacy_media']])for(const result of Object.values(state[bucket]||{})){
  const id=randomUUID();store.executions[id]={id,taskId:'legacy',itemId:'legacy',tool,providerTaskId:result.taskId,status:['queued','running'].includes(result.status)?'submitted':'succeeded',result};
 }
 for(const action of Object.values(state.actions||{}))if(['unknown','pending'].includes(action.status)){const id=randomUUID();store.executions[id]={id,taskId:'legacy',itemId:'legacy',tool:action.name,args:action.args,status:'unknown'};}
 return store;
}
export function ingestInputs(state){const store=storeOf(state);store.inputs??={};for(const a of state.assets||[])if(a.source==='用户提供')store.inputs[a.assetId]=a;}
export function currentTask(state){const store=storeOf(state);return store.tasks[store.activeTaskId];}
export function taskArtifacts(state,task=currentTask(state)){return Object.values(storeOf(state).artifacts).filter(a=>a.taskId===task?.id);}
export function executionsFor(state,itemId){return Object.values(storeOf(state).executions).filter(e=>e.itemId===itemId);}
export function createTask(state,goal,query,{parentTaskId=null}={}){
 const store=storeOf(state),id=randomUUID();
 const task={id,query,goal:structuredClone(goal),parentTaskId,revision:1,status:'PLANNING',createdAt:stamp(),updatedAt:stamp(),plan:null,approval:{required:!!goal.semantic?.approval?.required,status:'not_required',planHash:null},items:goal.tasks.map((t,index)=>({...itemDefinition(goal,index),id:randomUUID(),status:'PENDING',artifactIds:[],observations:[],methods:[],issues:[]})),verification:{status:'pending',issues:[]}};
 for(const item of task.items)recordChange(task,item,{status:'pending'});
 initializeRequirements(task);
 if(task.approval.required)task.approval.status='pending';
 // Keep logical slot identity and multiplicity, including distinct source coverage.
 if(parentTaskId){const parent=store.tasks[parentTaskId];task.supersedes=parentTaskId;if(parent&&!['COMPLETED','SIMULATED','REFUSED'].includes(parent.status)){parent.supersededBy=id;parent.status='CANCELLED';parent.reason='未完成义务已转入修订任务 '+id;}}
 store.tasks[id]=task;store.activeTaskId=id;state.goal=task.goal;
 if(goal.safety.disposition==='refuse')task.status='REFUSED';
 else if(goal.needsClarification)task.status='NEEDS_INPUT';
 projectState(state);return task;
}
export function transition(state,status,reason,task=currentTask(state)){
 if(!task)return;
 if(!['PENDING','PLANNING','EXECUTING','VERIFYING','NEEDS_INPUT','WAIT_CONFIRM','WAITING','PARTIAL','BLOCKED','COMPLETED','SIMULATED','REFUSED','FAILED','CANCELLED'].includes(status))throw new Error('未知任务状态');
 if(task.protocol==='compiled-v1'&&status==='COMPLETED')throw new Error('完成状态只能由产物验收计算');
 if(status==='COMPLETED'&&!reconcileRequirements(task,storeOf(state)))throw new Error('用户Requirement尚未全部满足，不能标记完成');
 if(task.status==='REFUSED'&&status!=='REFUSED')throw new Error('已拒绝任务不可恢复执行');
 task.status=status;task.updatedAt=stamp();task.reason=reason||null;projectState(state);
}
export function setPlan(state,plan){const task=currentTask(state);if(!task)throw new Error('没有当前任务');
 const value={summary:plan.summary,steps:plan.steps.map(s=>({title:s.title,status:s.status}))};
 task.plan={...value,revision:(task.plan?.revision||0)+1};task.updatedAt=stamp();
 // Progress labels do not invalidate an approval; changing executable batch arguments does.
 projectState(state);return task.plan;
}
export function requireApproval(state,payload){const task=currentTask(state);const planHash=hash({revision:task.revision,contractHash:task.contract?.hash,payload});
 if(!task.approval.required)return true;
 if(task.approval.status==='approved'&&task.approval.planHash===planHash)return true;
 task.approval={...task.approval,required:true,status:'pending',revision:task.revision,contractHash:task.contract?.hash,planHash,payload:structuredClone(payload)};transition(state,'WAIT_CONFIRM','请确认已展示的具体方案');return false;
}
export function approveTask(state,taskId,planHash,{source='explicit_control'}={}){const store=storeOf(state),task=store.tasks[taskId];
 if(task?.effectPolicy==='explicit_approval'&&source!=='explicit_control')throw new Error('当前方案必须通过显式控制确认，模型意图不能代替批准');
 if(!task||taskId!==store.activeTaskId||task.status!=='WAIT_CONFIRM'||!planHash||task.approval.planHash!==planHash||task.approval.revision!==undefined&&task.approval.revision!==task.revision||task.approval.contractHash&&task.approval.contractHash!==task.contract?.hash)throw new Error('确认对象已变化，请刷新查看当前方案');
 task.approval.status='approved';task.approval.controlReceipt={source,taskId,revision:task.revision,planHash,at:stamp()};store.decisions.push({id:randomUUID(),taskId,planHash,source,decision:'approve',at:stamp()});transition(state,'PLANNING',null,task);return task;
}
export function addArtifact(state,{itemId,type,content,url,sourceExecutionId=null,parentId=null,purpose='deliverable',metadata={},verification}){
 const store=storeOf(state),task=currentTask(state),item=task?.items.find(i=>i.id===itemId);
 if(!task||!item)throw new Error('交付物必须绑定真实任务项');
 if(url&&!/^https:\/\//.test(url)&&!/^\/media\/[a-f0-9-]{36}\.(mp3|wav)$/.test(url))throw new Error('产物地址无效');
 const existing=Object.values(store.artifacts).find(a=>a.taskId===task.id&&a.itemId===itemId&&a.type===type&&a.sourceExecutionId===sourceExecutionId&&a.metadata?.deliverySlot===metadata.deliverySlot&&(url?a.url===url:a.content===content));
 if(existing)return existing;
 const sourceById=id=>store.artifacts[id]||store.inputs?.[id];
 if(parentId&&!sourceById(parentId))throw new Error('修订来源不存在');
 const parentSource=sourceById(parentId),parent=parentSource?{...parentSource,id:parentSource.id||parentSource.assetId||parentId,version:parentSource.version||1}:null;
 const relationships=(item.references||[]).filter(ref=>sourceById(ref)).map(ref=>({artifactId:ref,version:sourceById(ref).version||1,relation:parentId===ref?'revision_of':task.goal?.semantic?.deliverables?.[item.index]?.action==='respond'?'references':'derived_from'}));
 if(parent&&!relationships.some(r=>r.artifactId===parent.id))relationships.push({artifactId:parent.id,version:parent.version,relation:'revision_of'});
 const artifact={relationships,id:randomUUID(),taskId:task.id,itemId,type,purpose,status:'completed',version:parent?parent.version+1:1,parentId,content,url,sourceExecutionId,createdAt:stamp(),metadata,verification:verification||{technical:'passed',semantic:'not_checked'}};
 artifact.parentArtifact=parentId;
 artifact.dependsOn=[...new Set([...relationships.map(r=>r.artifactId),...(item.dependsOn||[]).flatMap(n=>task.items[n]?.artifactIds||[]),...(metadata.stages||[]).map(s=>s.artifactId),...(metadata.sourceArtifactIds||[])])];
 for(const id of artifact.dependsOn)if(!sourceById(id))throw new Error('产物依赖必须属于当前会话的实际产物或输入');
 store.artifacts[artifact.id]=artifact;if(purpose==='deliverable')item.artifactIds.push(artifact.id);
 projectState(state);return artifact;
}
export function observeExecution(state,execution,result){
 const store=storeOf(state),task=store.tasks[execution.taskId],item=task?.items.find(i=>i.id===execution.itemId);if(!item)return;
 execution.result=result;execution.updatedAt=stamp();execution.finishedAt=execution.updatedAt;
 execution.status=result.isError||['failed','cancelled','expired'].includes(result.status)?'failed':['queued','running'].includes(result.status)?'submitted':'succeeded';
 if(result.taskId)execution.providerTaskId=result.taskId;
 if(execution.status==='succeeded'){
  const previous=store.activeTaskId;store.activeTaskId=task.id;
  for(const image of result.images||[])if(image.url)addArtifact(state,{itemId:item.id,type:'image',url:image.url,sourceExecutionId:execution.id,metadata:{coverage:execution.coverage,simulated:!!result.simulated,args:execution.args,provider:{size:image.size}},parentId:execution.parentArtifactId});
  for(const [type,url] of [['video',result.videoUrl],['audio',result.audioUrl],...(result.scenes||[]).map(s=>['video',s.videoUrl])])if(url)addArtifact(state,{itemId:item.id,type,url,sourceExecutionId:execution.id,metadata:{simulated:!!result.simulated,args:execution.args,provider:result.metadata},parentId:execution.parentArtifactId});
  store.activeTaskId=previous;
 }
 for(const artifact of Object.values(store.artifacts).filter(a=>a.sourceExecutionId===execution.id)){const node=task.executionPlan?.nodes.find(n=>n.itemId===item.id);for(const method of item.methods)if(method.contractValidated&&method.outputArtifactIds?.includes(node?.skillArtifactId))method.outputArtifactIds.push(artifact.id);}
 reconcileTask(state,task);
}
export function itemEvidence(state,item){
 const names={runtime:['runtime_facts'],image:['analyze_image'],video:['read_video','analyze_video'],web:['search_web'],task:['get_video_task','wait_video_task','get_media_task','wait_media_task','refresh_task_results']};
 if(!names[item.requiredEvidence])return true;
 const observations=item.observations.filter(o=>names[item.requiredEvidence].includes(o.tool)&&!o.result?.isError);
 const refs=item.references.map(ref=>Object.values(storeOf(state).artifacts).find(a=>a.id===ref)?.url||state.assets?.find(a=>a.assetId===ref)?.url||ref).filter(ref=>ref.startsWith('https://')||item.requiredEvidence==='task');
 return !!observations.length&&refs.every(ref=>observations.some(o=>[o.args.url,o.args.videoUrl,o.args.taskId].includes(ref)||(o.tool==='refresh_task_results'&&o.result.results?.some(r=>r.taskId===ref&&!r.isError))));
}
export function reconcileTask(state,task=currentTask(state)){
 if(!task)return;
 const store=storeOf(state);
 for(const item of task.items){
  if(isDeferred(item)){item.status='NEEDS_INPUT';continue;}
  item.methodExecution=methodExecution(item,item.artifactIds.map(id=>store.artifacts[id]).filter(Boolean));
  if(item.readReceipt){
   const complete=item.readReceipt.checks?.completionAllowed&&item.artifactIds.length===0&&(item.requiredEvidence==='runtime'||itemEvidence(state,item));
   item.status=complete?'COMPLETED':'BLOCKED';
   if(!complete)task.recovery={kind:'query_contract_mismatch',nextActor:'system'};
   continue;
  }
  for(const a of item.artifactIds.map(id=>store.artifacts[id]).filter(Boolean)){const procedure=methodSatisfied(item,a);if(!procedure){a.acceptance={...a.acceptance,procedure:{passed:false,reason:'missing_runtime_method_evidence'}};a.publication='audit';}}
  const artifacts=fulfillmentArtifacts(item.artifactIds.map(id=>store.artifacts[id])).filter(a=>a?.status==='completed'&&a.verification.technical==='passed'&&(task.validationPolicy==='strict'?(a.verification.semantic==='passed'&&!a.metadata.simulated||task.validationMode==='simulation'&&a.verification.semantic==='simulated_passed'):a.verification.semantic!=='failed'));
  for(const a of artifacts.filter(a=>a.type!=='text'&&a.parentId)){const parent=store.artifacts[a.parentId];if(parent&&a.verification.semantic==='passed'){a.publication='current';parent.publication='superseded';}}
  const fileQuota=item.output!=='text'||artifacts.filter(a=>a.type==='text'&&methodSatisfied(item,a)&&!['superseded','audit'].includes(a.publication)).length>=(item.artifactCount||1);
  const expected=task.contract?.requirements?.find(r=>r.id===item.id+':coverage')?.value;
  const coverageItem=expected?{...item,coverage:expected}:item;
  const coverage=coverageStatus(coverageItem,fulfillmentArtifacts(item.artifactIds.map(id=>store.artifacts[id])),{mode:task.validationMode});if(item.coverage||item.resolvedCoverage)item.coverageProgress=coverage;
  item.requirementCoverage=requirementCoverage(coverageItem,fulfillmentArtifacts(item.artifactIds.map(id=>store.artifacts[id])),{mode:task.validationMode});
  const noChange=item.noChangeReceipt?.verification?.passed&&store.artifacts[item.noChangeReceipt.source.id]?.version===item.noChangeReceipt.source.version;
  const satisfied=noChange||coverage.complete&&fileQuota&&artifacts.filter(a=>a.type===item.output&&methodSatisfied(item,a)&&!['superseded','audit'].includes(a.publication)).reduce((n,a)=>n+(a.type==='text'&&Number.isInteger(a.metadata.unitCount)&&a.metadata.unitCount>0?a.metadata.unitCount:1),0)>=item.count&&itemEvidence(state,item);
  const executions=executionsFor(state,item.id);
  const unverified=task.validationPolicy==='strict'&&item.artifactIds.some(id=>['not_checked','unverified','simulated_not_checked'].includes(store.artifacts[id]?.verification.semantic));
  item.status=satisfied?'COMPLETED':executions.some(e=>e.status==='unknown')?'BLOCKED':executions.some(e=>e.status==='submitted')?'WAITING':item.status==='BLOCKED'?'BLOCKED':unverified?'VERIFYING':artifacts.length||item.issues.length?'PARTIAL':'PENDING';
 }
 task.requirementCoverage=task.items.flatMap(i=>i.requirementCoverage||[]);
 const fulfilled=reconcileRequirements(task,store);
 if(['REFUSED','NEEDS_INPUT','WAIT_CONFIRM','CANCELLED'].includes(task.status)){projectState(state);return;}
 const unknown=Object.values(store.executions).filter(e=>e.taskId===task.id&&['pending','unknown'].includes(e.status)&&!e.providerTaskId);
 if(unknown.length)task.recovery={kind:'receipt_reconciliation',nextActor:'operator',action:'reconcile_provider_receipt',executionIds:unknown.map(e=>e.id),automaticResubmit:false};
 else if(task.recovery?.kind==='receipt_reconciliation')delete task.recovery;
 const scopeIssue=unresolvedScope(task);
 if(unknown.length){task.status='BLOCKED';task.reason='供应商是否受理尚未确定，需核对提交回执；不能重新提交。';}
 else if(scopeIssue){task.status='BLOCKED';task.reason=scopeIssue;task.recovery={kind:'unresolved_scope',nextActor:'intake'};}
 else if(fulfilled){task.status=task.validationMode==='simulation'&&taskArtifacts(state,task).some(a=>a.metadata.simulated)?'SIMULATED':'COMPLETED';task.reason=null;const qualitySkipped=taskArtifacts(state,task).filter(a=>a.purpose==='deliverable'&&a.publication!=='superseded').some(a=>a.acceptance?.quality?.status==='not_evaluated');task.verification={status:qualitySkipped?'procedure_passed':task.validationPolicy==='strict'?'passed':'technical_passed',quality:qualitySkipped?'not_evaluated':task.validationPolicy==='strict'?'passed':'not_evaluated',issues:[],semantic:task.status==='SIMULATED'?'simulated_not_checked':qualitySkipped?'not_checked':task.validationPolicy==='strict'?'passed':'not_checked'};}
 else if(task.items.some(isDeferred)&&task.items.every(i=>i.status==='COMPLETED'||isDeferred(i))){task.status='NEEDS_INPUT';task.reason=task.items.filter(isDeferred).map(i=>i.activation.condition).join('；');}
 else if(task.items.some(i=>i.status==='BLOCKED'))task.status='BLOCKED';
 else if(task.items.some(i=>i.status==='WAITING'))task.status='WAITING';
 else if(task.items.some(i=>i.status==='VERIFYING'))task.status='VERIFYING';
 else if(task.items.some(i=>i.status==='PARTIAL'||i.status==='COMPLETED'))task.status='PARTIAL';
 else if(Object.values(store.executions).some(e=>e.taskId===task.id&&e.status==='failed'))task.status='FAILED';
 else if(task.status==='COMPLETED'||task.status==='VERIFYING')task.status='PLANNING';
 task.executionStatus=task.status;
 if(!unknown.length&&!fulfilled&&task.intentSnapshot?.origin==='first_parsed_intent'&&['PARTIAL','FAILED','BLOCKED','PLANNING'].includes(task.status))task.status='PENDING';
 for(const node of task.executionPlan?.nodes||[]){const item=task.items.find(i=>i.id===node.itemId);node.status=({COMPLETED:'completed',BLOCKED:'blocked',WAITING:'submitted'})[item?.status]||node.status;}
 for(const batch of Object.values(task.batches||{})){const records=batch.executionIds.map(id=>store.executions[id]).filter(Boolean);if(records.length===batch.items.length&&records.every(e=>e.status==='succeeded'))batch.status='completed';}
 if(task.plan)task.plan.steps.forEach((step,n)=>{step.status=task.items[n]?.status==='COMPLETED'?'done':task.items[n]?.status==='BLOCKED'?'blocked':'pending';});
 task.updatedAt=stamp();projectState(state);
}
export function readyItem(state){const task=currentTask(state);if(!task)return;
 return task.items.find(i=>!isDeferred(i)&&!['COMPLETED','BLOCKED','WAITING'].includes(i.status)&&i.dependsOn.every(n=>task.items[n]?.status==='COMPLETED'));
}
export function taskSnapshot(state,task=currentTask(state)){if(!task)return null;
 return structuredClone({...task,disposition:task.supersededBy?'superseded':task.cancelledByUser?'cancelled':'current',stages:stageSummary(task),actions:taskActions(task,Object.values(storeOf(state).executions)),items:task.items.map(i=>({...i,observations:i.observations.map(o=>({tool:o.tool,args:o.args,result:o.result})),methods:i.methods})),artifacts:taskArtifacts(state,task).map(a=>({...a,content:a.content?.slice(0,10000)})),executions:Object.values(storeOf(state).executions).filter(e=>e.taskId===task.id).map(e=>({id:e.id,itemId:e.itemId,tool:e.tool,status:e.status,providerTaskId:e.providerTaskId}))});
}
export function projectState(state){
 const store=storeOf(state),task=store.tasks[store.activeTaskId];if(!task)return;
 task.transitions??=[];if(task.transitions.at(-1)?.to!==task.status)task.transitions.push({from:task.transitions.at(-1)?.to||null,to:task.status,at:stamp(),reason:task.reason||null});
 const map={PENDING:'limited',PLANNING:'running',EXECUTING:'running',VERIFYING:'running',NEEDS_INPUT:'needs_input',WAIT_CONFIRM:'needs_input',WAITING:'waiting',PARTIAL:'limited',BLOCKED:'blocked',COMPLETED:'completed',REFUSED:'refused',FAILED:'failed',CANCELLED:'cancelled'};
 state.status=task.status==='SIMULATED'?'simulated':map[task.status]||'running';state.goal=task.goal;
 state.assets=[...Object.values(store.inputs||{}),...Object.values(store.artifacts).filter(a=>a.url&&isAccepted(a)).map(a=>({assetId:a.id,url:a.url,kind:a.type,source:'artifact',createdAt:a.createdAt}))];
 state.batches=Object.fromEntries(Object.values(store.tasks).flatMap(t=>Object.values(t.batches||{})).map(b=>[b.id,{...b,batchId:b.id}]));
 state.deliverables=Object.values(store.artifacts).filter(a=>a.type==='text'&&isAccepted(a)).map(a=>({id:a.id,runId:a.taskId,kind:'text',content:a.content}));
 state.videoTasks={};state.mediaTasks={};
 for(const e of Object.values(store.executions))if(e.providerTaskId&&e.result){(e.tool==='generate_video'?state.videoTasks:state.mediaTasks)[e.providerTaskId]=e.result;}
}
