import {assertExecutionProjection} from './execution-projection.mjs';
import {digest} from './document-contract.mjs';
import {assertIntentSnapshot} from './intent-snapshot.mjs';
import {requirementDefinitions} from './task-requirements.mjs';
import {businessStateSnapshot} from './trace-state.mjs';
import {createHash,randomUUID} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function contractDelta(before,after,path=''){
 if(JSON.stringify(before)===JSON.stringify(after))return [];
 if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after))return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(k=>contractDelta(before[k],after[k],path+'/'+k));
 return [{path,before:before??null,after:after??null}];
}
export function acceptRevision(task,requestId){
 assertExecutionProjection(task);task.requestId=requestId;assertIntentSnapshot(task.intentSnapshot);
 task.contract={projectionVersion:1,itemIds:task.items.map(i=>i.id),effectPolicy:task.effectPolicy||'trusted_embedder',version:task.revision,hash:hash(task.goal),goal:structuredClone(task.goal),acceptedAt:new Date().toISOString(),requestId,
  scopeAudit:structuredClone(task.goal.requestContract||null),finalObligations:{media:Object.fromEntries(['image','video','audio'].map(kind=>[kind,task.items.filter(i=>i.output===kind&&!i.runtimeQuery).reduce((n,i)=>n+i.count,0)]))},executionPermission:{mediaSubmission:task.goal.requestContract?.currentPermission?.mediaSubmission==='denied'?'denied':task.approval.required?'requires_revision_bound_approval':(!task.items.some(i=>['image','video','audio'].includes(i.output)&&!i.runtimeQuery)?'denied':task.approval.required?'requires_revision_bound_approval':task.goal.requestContract?.readOnly?'denied':'allowed')},specOrigins:task.items.map(i=>({itemId:i.id,fields:i.specOrigins||{}})),effects:{mediaSubmissionAllowed:task.goal.requestContract?.currentPermission?.mediaSubmission!=='denied'&&!task.goal.requestContract?.readOnly&&task.items.some(i=>['image','video','audio'].includes(i.output)&&!i.runtimeQuery)},
  requirements:task.items.flatMap(i=>[
   {id:i.id+':delivery',category:i.runtimeQuery?'read':'delivery',nodeId:i.id,value:{output:i.output,artifactCount:i.runtimeQuery?0:i.artifactCount??(i.output==='text'?1:i.count),artifactReferences:i.runtimeQuery?.targets||[],contentCardinality:i.contentCardinality??(i.output==='text'?i.count:null)},evidence:i.runtimeQuery?'read_receipt':'accepted_artifact'},
   ...(i.coverage?[{id:i.id+':coverage',category:'delivery',nodeId:i.id,value:structuredClone(i.coverage),evidence:'source_unit_coverage'}]:[]),
   {id:i.id+':spec',category:'content',nodeId:i.id,value:structuredClone(i.spec),evidence:'schema_and_binding'},
   ...i.constraints.map((v,n)=>({id:i.id+':constraint:'+n,category:'content',nodeId:i.id,value:v,evidence:'acceptance'})),
   ...(i.requiredMethods||[]).map(v=>({id:i.id+':method:'+v,category:'process',nodeId:i.id,value:v,evidence:'runtime_method'})),
   {id:i.id+':authorization',category:'authorization',nodeId:i.id,value:!!task.approval.required,evidence:'revision_bound_approval'}]),
  facts:structuredClone(task.goal.semantic?.facts||[]),globalConstraints:structuredClone(task.goal.semantic?.globalConstraints||[])};
 (task.revisions??=[]).push(structuredClone(task.contract));
 return task.contract;
}
export function recordTurn(state,message,control){
 const turn={requestId:state.currentRunId,runId:state.currentRunId,rawInput:message,assets:structuredClone(state.assets||[]),explicitTarget:control?.resumeTaskId||null,explicitPlanHash:control?.planHash||null,createdAt:new Date().toISOString(),status:'understanding',stateBefore:businessStateSnapshot(state)};
 if(control?.runtimeVersion)turn.runtimeVersion=control.runtimeVersion;
 (state.turns??=[]).push(turn);return turn;
}
export function acceptDecision(turn,goal,task){
 const c=goal.semantic?.continuation||{mode:'new'};
 if(c.mode!=='new'&&(!task||c.taskId!==task.id))throw new Error('任务控制操作必须绑定真实目标，不能作为新任务接受');
 turn.decision={id:randomUUID(),operations:[{operation:goal.tasks?.length&&goal.tasks.every(t=>t.operation.startsWith('inspect_')||t.operation==='query_task')?'inspect':({continue:'resume'})[c.mode]||c.mode,targetTaskId:c.taskId||null,targetRevision:task?.revision,evidence:goal.controlEvidence||turn.rawInput,delta:c.mode==='revise'?{before:task?.contract?.hash,after:hash(goal),changes:contractDelta(task?.goal?.semantic,goal.semantic)}:null}],status:'accepted',intakeTrace:structuredClone(goal.intakeTrace||[]),semantic:structuredClone(goal.turnSemantic||goal.semantic)};
}
export function assertContract(task){assertExecutionProjection(task);if(task.contract?.effectPolicy==='explicit_approval'&&(!task.approval.required||task.effectPolicy!=='explicit_approval')&&task.items.some(i=>['image','video','audio'].includes(i.output)&&!i.runtimeQuery))throw new Error('独立媒体授权策略被修改');assertIntentSnapshot(task.intentSnapshot);if(task.requirements&&task.requirementsHash!==hash(requirementDefinitions(task)))throw new Error('Requirement定义已改变，必须重新接受用户修订');if(task.contract&&task.contract.hash!==hash(task.goal))throw new Error('已接受的任务合同被修改，必须创建修订版本');if(task.supersededBy)throw new Error('旧执行义务已被修订取代，不能继续提交');if(task.cancelledByUser)throw new Error('用户已取消该任务，不能继续提交');}
export function methodSatisfied(item,artifact){
 if(artifact.acceptance?.checks?.completionAllowed===false||artifact.acceptance?.checks?.topicMatched===false)return false;
 if(artifact.metadata?.conversion?.outputHash&&artifact.metadata.conversion.outputHash!==digest(artifact.content))return false;
 if(artifact.acceptance?.inputHash&&artifact.type==='text'&&artifact.acceptance.inputHash!==digest(artifact.content))return false;
 const required=item.requiredMethods||[];
 const consumers=required.filter(slug=>['video-script-zh-v1','storyboard-one-shot-zh-v2','storyboard-one-shot-zh','creative-prompt-rewrite'].includes(slug));
 const binding=item.resolvedSelectorBinding||item.selectorBinding;
 if(/^task:\d+$/.test(item.sourceSelection?.source||'')&&item.output==='text'&&!item.resolvedSelectorBinding)return false;
 const selectionReceipt=binding&&artifact.metadata?.sourceSelectionBinding&&hash(artifact.metadata.sourceSelectionBinding)===hash(binding);
 if(item.resolvedSelectorBinding&&!selectionReceipt)return false;
 const selectedIndex=binding?.type==='direction'?binding.index:item.spec?.selectedDirectionIndex;
 if(selectedIndex&&(consumers.length||!required.length)&&!(!required.length&&selectionReceipt)&&!(item.methods||[]).some(m=>m.outputArtifactIds?.includes(artifact.id)&&m.input?.sources?.some(s=>s.selectedDirection?.index===selectedIndex&&s.selectedDirection.artifactId===s.id&&s.selectedDirection.version===s.version&&s.version)))return false;
 return required.every((slug,index)=>(item.methods||[]).some(m=>{
  if(!(m.skillId===slug&&m.status==='validated'&&m.contentHash&&m.modelCallIds?.length&&m.outputArtifactIds?.includes(artifact.id)&&m.contractValidated===true))return false;
  if(item.output!=='text'||required.length<2)return true;
  const stage=artifact.metadata.stages?.[index],previous=artifact.metadata.stages?.[index-1];
  return stage?.skillId===slug&&m.nodeId===stage.stageId&&m.stageIndex===index&&m.supportOutputArtifactIds?.includes(stage.artifactId)&&(!previous||m.inputArtifacts.some(a=>a.id===previous.artifactId&&a.version===previous.version));
 }));
}
// A read model of the existing methods ledger, never a second writable ledger.
export function methodExecution(item,artifacts=[]){
 return (item.requiredMethods||[]).map(skillId=>{
  const records=(item.methods||[]).filter(m=>m.skillId===skillId),m=records.findLast(r=>r.status==='validated')||records.at(-1);
  const outputs=m?.outputArtifactIds||[],verified=outputs.some(id=>{const a=artifacts.find(a=>a.id===id);return a&&isAccepted(a)&&methodSatisfied(item,a);});
  return {skillId,validationScope:m?.validationScope||'schema_and_lineage',scriptChecks:m?.scriptChecks||{status:'not_recorded'},inputArtifactIds:m?.inputArtifactIds||m?.inputArtifacts?.map(a=>a.id)||m?.input?.sources?.map(a=>a.id)||[],outputArtifactIds:outputs,callId:m?.modelCallIds?.at(-1)||null,callIds:m?.modelCallIds||[],contentHash:m?.contentHash||null,status:m?.status==='failed'?'failed':verified?'verified':outputs.length?'produced_artifact':m?.modelCallIds?.length?'executed':m?.contentHash?'loaded':'selected'};
 });
}
export function isAccepted(a){return a?.purpose==='deliverable'&&a.verification?.technical==='passed'&&['passed','simulated_passed'].includes(a.verification?.semantic)&&!['superseded','audit'].includes(a.publication);}
