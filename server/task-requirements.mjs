import {intentSnapshot,assertIntentSnapshot} from './intent-snapshot.mjs';
import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const requirementDefinitions=task=>(task.requirements||[]).map(({status,artifactIds,produced,remaining,...definition})=>definition);
// A later obligation may revise an already delivered object. Publication selects
// the current version; it must not erase fulfillment of the earlier obligation.
export function fulfillmentArtifacts(artifacts){
 return artifacts.filter(Boolean).map(a=>a.publication==='superseded'&&!artifacts.some(b=>b&&b.parentId===a.id&&b.itemId===a.itemId)?{...a,publication:'current'}:a);
}
export function initializeRequirements(task){
 if(task.requirements)return;
 task.intentSnapshot??=structuredClone(task.goal.intentSnapshot||intentSnapshot(task.query,{summary:task.goal.summary,deliverables:task.items.map((i,n)=>({description:i.description,kind:i.output,count:i.count,artifactCount:i.artifactCount,dependsOn:i.dependsOn,constraints:i.constraints,...task.goal.semantic?.deliverables?.[n]}))},{origin:'legacy_accepted_contract'}));
 assertIntentSnapshot(task.intentSnapshot);
 const snapshot=task.intentSnapshot;
 // Control-only revisions reuse an already accepted production obligation.
 const definitions=snapshot.deliverables.length?snapshot.deliverables:task.items.map((i,index)=>({id:'r'+(index+1),index,goal:i.description,type:i.output,count:i.count,artifactCount:i.artifactCount,dependsOn:i.dependsOn,constraints:i.constraints}));
 task.requirements=definitions.map(r=>{
  const indices=task.goal.requirementBindings?.[r.index]||[r.index],items=indices.map(i=>task.items[i]).filter(Boolean);
  for(const item of items)item.requirementIds=[...new Set([...(item.requirementIds||[]),r.id])];
  const type=['text','image','video','audio'].includes(r.type)?r.type:items[0]?.output;
  return {id:r.id,goal:r.goal||items[0]?.description||'',type,count:Number.isInteger(r.count)&&r.count>0?r.count:items.reduce((n,i)=>n+i.count,0)||1,
   artifactCount:type==='text'?(r.artifactCount||Math.max(1,items.reduce((n,i)=>n+(i.artifactCount||1),0))):null,
   dependsOn:r.dependsOn.map(i=>definitions[i]?.id||'unresolved:'+i),constraints:structuredClone(r.constraints||[]),
   source:snapshot.origin,itemIds:items.map(i=>i.id),status:'pending',artifactIds:[],produced:0,remaining:r.count||1};
 });
 task.requirementsHash=digest(requirementDefinitions(task));
 task.completionStatus='pending';
}
export function reconcileRequirements(task,store){
 initializeRequirements(task);assertIntentSnapshot(task.intentSnapshot);
 if(task.requirementsHash!==digest(requirementDefinitions(task)))throw new Error('Requirement 定义已改变，不能以执行重试覆盖用户要求');
 for(const r of task.requirements){
  const items=r.itemIds.map(id=>task.items.find(i=>i.id===id)).filter(Boolean);
  const artifacts=fulfillmentArtifacts([...new Set(items.flatMap(i=>i.artifactIds||[]))].map(id=>store.artifacts[id])).filter(a=>a.type===r.type&&a.purpose==='deliverable'&&a.verification?.technical==='passed'&&(task.validationPolicy==='strict'?['passed','simulated_passed'].includes(a.verification?.semantic):a.verification?.semantic!=='failed')&&!['superseded','audit'].includes(a.publication));
  const owned=artifacts.filter(a=>a.taskId===task.id&&items.some(i=>i.id===a.itemId));
  r.artifactIds=owned.map(a=>a.id);r.produced=owned.reduce((n,a)=>n+(r.type==='text'?a.metadata?.unitCount||1:1),0);r.remaining=Math.max(0,r.count-r.produced);
  const receiptsOnly=items.length>0&&items.every(i=>i.readReceipt?.checks?.completionAllowed||i.noChangeReceipt?.verification?.passed);
  r.status=items.length===r.itemIds.length&&items.length>0&&items.every(i=>i.status==='COMPLETED')&&(receiptsOnly||r.produced>=r.count&&(r.type!=='text'||owned.length>=r.artifactCount))?'fulfilled':'pending';
  if(r.status==='fulfilled'&&receiptsOnly)r.remaining=0;
 }
 // A dependent obligation cannot be fulfilled while its predecessor is pending.
 for(const r of task.requirements)if(r.dependsOn.some(id=>task.requirements.find(p=>p.id===id)?.status!=='fulfilled'))r.status='pending';
 task.completionStatus=task.requirements.length>0&&task.requirements.every(r=>r.status==='fulfilled')?'fulfilled':'pending';
 return task.completionStatus==='fulfilled';
}
export function completionFacts(task,store){
 const requirements=task.requirements||task.items.map((i,n)=>({id:'legacy:'+n,goal:i.description,type:i.output,count:i.count,status:i.status==='COMPLETED'?'fulfilled':'pending',produced:(i.artifactIds||[]).map(id=>store.artifacts[id]).filter(a=>a?.type===i.output&&a.verification?.technical==='passed'&&a.verification?.semantic==='passed').length,scopeSource:'legacy_execution_projection'}));
 const byType={};
 for(const kind of ['text','image','video','audio']){
  const rs=requirements.filter(r=>r.type===kind);
  const actual=Object.values(store.artifacts||{}).filter(a=>a.taskId===task.id&&a.type===kind&&a.purpose==='deliverable'&&a.sourceExecutionId&&store.executions?.[a.sourceExecutionId]?.status==='succeeded');
  const accepted=rs.reduce((n,r)=>n+(r.produced||0),0),required=rs.reduce((n,r)=>n+r.count,0);
  byType[kind]={required,produced:kind==='text'?accepted:actual.length,fulfilled:accepted,remaining:Math.max(0,required-accepted)};
 }
 return {taskId:task.id,disposition:task.supersededBy?'superseded':task.cancelledByUser?'cancelled':'current',supersededBy:task.supersededBy||null,request:task.query,status:task.status,completionStatus:task.completionStatus||'unverified_legacy',requirements:structuredClone(requirements),byType,scopeSource:task.intentSnapshot?.origin||'legacy_accepted_contract',scopeVerified:task.intentSnapshot?.origin==='first_parsed_intent'};
}
