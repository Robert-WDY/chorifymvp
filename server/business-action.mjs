import {actionRegistry,actionEnabled,actionTypes} from './action-registry.mjs';
const refs=a=>[...(a.target?[a.target]:[]),...(a.sources||[])];
const fail=(message,path)=>{throw Object.assign(new Error(message),{code:'business_action',issues:path?[{path}]:[]});};
export function actionOrder(actions){
 const byId=new Map();for(const [i,a] of actions.entries()){if(!a.id)fail('业务动作缺少id',`/businessActions/${i}/id`);if(byId.has(a.id))fail('业务动作id重复');byId.set(a.id,a);}
 const ordered=[],visiting=new Set(),done=new Set();
 const visit=a=>{if(done.has(a.id))return;if(visiting.has(a.id))fail('业务动作来源形成循环，不能丢弃依赖继续');visiting.add(a.id);
  for(const r of refs(a).filter(r=>r.type==='ACTION_OUTPUT')){const source=byId.get(r.actionId);if(!source)fail('动作来源不存在：'+r.actionId);visit(source);}
  visiting.delete(a.id);done.add(a.id);ordered.push(a);
 };actions.forEach(visit);return ordered;
}
// No lookup or model call here: this same projection feeds immutable intent and
// execution validation. Source identity/version validation is a separate step.
export function projectBusinessActions(request){
 const actions=actionOrder(request.businessActions),indices=new Map(actions.map((a,i)=>[a.id,i]));
 const approvals=actions.filter(a=>a.actionType==='CONFIRM_ARTIFACT');
 if(approvals.length&&(actions.length!==1))fail('批准必须单独绑定保存方案；包含修改或新增时不能复用旧批准');
 const deliverables=actions.filter(a=>a.actionType!=='CONFIRM_ARTIFACT').map(a=>{
  const def=actionRegistry[a.actionType];if(!def)fail('未注册的业务动作：'+a.actionType);
  const reference=r=>r.type==='ACTION_OUTPUT'?'task:'+indices.get(r.actionId):r.id;
  return {...(a.activation?{activation:a.activation}:{}),description:a.intent,kind:def.kind,action:def.action,count:a.expectedOutput?.count??1,
   references:[...new Set(refs(a).map(reference))],dependsOn:[...new Set(refs(a).filter(r=>r.type==='ACTION_OUTPUT').map(r=>indices.get(r.actionId)))],
   constraints:a.constraints||[],requestEvidence:a.requestEvidence||'',...(a.requestEvidenceSpans?{requestEvidenceSpans:a.requestEvidenceSpans}:{}),...(a.parameters?{spec:a.parameters}:{}),
   ...(a.actionType==='EDIT_IMAGE'?{changeContract:a.modification}:{}),
   ...(a.actionType==='ANALYZE_IMAGE'?{form:'analysis',requiredEvidence:'image'}:{})};
 });
 const confirm=approvals[0],readOnly=actions.length===1&&actions[0].actionType==='ANALYZE_IMAGE';
 return {...Object.fromEntries(['executionAuthorization','speakerRole','targetAudience'].filter(k=>request[k]!==undefined).map(k=>[k,structuredClone(request[k])])),summary:request.summary,turnOperation:confirm?{kind:'approve',targetTaskId:confirm.target?.taskId||''}:{kind:readOnly?'answer':actions.length===1&&actions[0].actionType==='EDIT_IMAGE'?'modify':'create'},deliverables,safety:request.safety,
  approval:{required:actions.some(a=>a.confirmation===true),reason:actions.filter(a=>a.confirmation).map(a=>a.confirmationEvidence||'').join('\n')},
  gaps:(request.gaps||[]).map(g=>({...g,...(g.affectedDeliverables?{affectedDeliverables:g.affectedDeliverables.map(index=>{const action=request.businessActions[index];if(!action||!indices.has(action.id))fail('局部缺口引用了不存在的业务动作');return indices.get(action.id);})}:{})})),facts:request.facts||[],globalConstraints:request.globalConstraints||[],assumptions:request.assumptions||[]};
}
export function validateBusinessActions(request,{references,taskCandidates,query,mode}){
 const actions=actionOrder(request.businessActions);
 for(const [i,a] of request.businessActions.entries()){
  for(const r of refs(a))if(r.type==='CANDIDATE'){const resolved=references.resolveReference(r.handle,{purpose:'history'});Object.assign(r,{type:resolved.entry.type.toUpperCase(),id:resolved.artifactId,version:resolved.version});delete r.handle;}
  const path='/businessActions/'+i,def=actionRegistry[a.actionType];
  if(!actionEnabled(a.actionType,mode))fail('当前迁移阶段尚未启用该动作：'+a.actionType);
  if(a.expectedOutput?.type&&a.expectedOutput.type!==def.output)fail('交付类型与业务动作不一致',path+'/expectedOutput/type');
  if(a.confirmation&&!a.confirmationEvidence)fail('等待确认必须有本轮用户依据',path+'/confirmationEvidence');
  if(a.confirmationEvidence&&!query.includes(a.confirmationEvidence))fail('确认要求依据不是本轮用户原文');
  if(a.requestEvidence&&!query.includes(a.requestEvidence))fail('业务动作依据不是本轮用户原文');
  if(a.actionType==='EDIT_IMAGE'&&!a.modification)fail('图片编辑必须保留修改与保持内容',path+'/modification');
  if(a.actionType==='ANALYZE_IMAGE'&&(a.expectedOutput?.count??1)!==1)fail('多个独立分析报告必须分别保留为业务动作，不能将多个交付合并为一次回答');
  if(a.actionType!=='EDIT_IMAGE'&&a.modification)fail('修改增量只能用于编辑动作');
  if(def.target&&!a.target)fail('业务动作缺少目标',path+'/target');
  if(a.actionType==='CONFIRM_ARTIFACT'){
   const t=a.target,task=taskCandidates.find(task=>task.id===t.taskId);
   const node=task?.executionPlan?.nodes?.find(n=>n.itemId===task.approval?.payload?.itemId),artifact=task?.artifacts?.find(x=>x.id===node?.skillArtifactId);
   if(t.type!=='PROPOSAL'||!task||task.status!=='WAIT_CONFIRM'||task.revision!==t.taskRevision||task.approval?.status!=='pending'||task.approval.planHash!==t.planHash||artifact?.id!==t.id||artifact?.version!==t.version)fail('批准对象或版本已变化；不能批准过期方案');
   if(a.confirmation||a.parameters||a.sources?.length||a.modification||a.constraints?.length||a.expectedOutput?.count)fail('批准不能夹带修改、生成参数或新增义务');
   continue;
  }
  if(a.parameters?.durationSeconds!==undefined&&a.actionType!=='CREATE_VIDEO')fail('时长参数只适用于视频创建');
  for(const r of refs(a)){
   let kind;
   if(r.type==='ACTION_OUTPUT'){const source=actions.find(x=>x.id===r.actionId);kind=actionRegistry[source.actionType]?.kind?.toUpperCase();if(r===a.target&&def.target&&(source.expectedOutput?.count??1)!==1)fail('前序动作产生多个候选，尚未唯一确定本轮目标');}
   else {const resolved=references.resolveReference(r.id,{purpose:'history'});kind=resolved.entry.type.toUpperCase();if(kind!==r.type||resolved.version!==r.version)fail('业务动作目标类型或版本不匹配');}
   if(r===a.target&&def.target&&kind!==def.target)fail('业务动作目标类型不匹配：'+def.target);
  }
 }
 return request;
}
// Valid business meaning is immutable during schema repair, including object
// references which the historical IntentSnapshot does not itself retain.
export function assertBusinessPreserved(before,after){
 if(!before)return;
 if(before.businessActions.length!==after.businessActions?.length)fail('字段修复不能改变业务动作数量');
 for(const [i,a] of before.businessActions.entries()){
  const b=after.businessActions[i];
  for(const key of ['id','intent','target','sources','constraints','modification','confirmation','parameters','requestEvidence','activation'])if(a[key]!==undefined){
   const unchanged=(old,value)=>old&&typeof old==='object'?Object.keys(old).every(k=>unchanged(old[k],value?.[k])):old===value;
   if(!unchanged(a[key],b[key]))fail('字段修复改变了业务动作：'+i+'/'+key);
  }
  if(actionTypes.includes(a.actionType)&&a.actionType!==b.actionType)fail('字段修复不能重新选择业务动作');
  if(Number.isInteger(a.expectedOutput?.count)&&a.expectedOutput.count>0&&a.expectedOutput.count!==b.expectedOutput?.count)fail('字段修复不能改变交付数量');
 }
}
export function actionReceipt(goal,request,mode){
 const native=!!request,ordered=native?actionOrder(request.businessActions):[];
 const shadow=(goal.resumeTaskId?[]:(goal.turnSemantic||goal.semantic)?.deliverables||[]).map((d,i)=>({id:'legacy_'+i,actionType:d.kind==='image'?(d.action==='modify'?'EDIT_IMAGE':d.action==='create'?'CREATE_IMAGE':null):d.kind==='video'&&d.action==='create'?'CREATE_VIDEO':d.kind==='text'&&d.requiredEvidence==='image'?'ANALYZE_IMAGE':null,intent:d.description,expectedOutput:{count:d.count},references:d.references}));
 const selected=native?ordered:shadow;
 return {version:1,mode:native?'action_compiled':'shadow',configuredMode:mode,actions:structuredClone(selected),
  bindings:structuredClone(goal.semantic?.readSourceBindings||(goal.tasks||[]).flatMap(t=>t.referenceBindings||[])),
  mappings:selected.map((a,i)=>{const def=actionRegistry[a.actionType];return{actionId:a.id,actionType:a.actionType,migrated:native,deliverableIndex:a.actionType==='CONFIRM_ARTIFACT'?null:i,derived:def?{operation:def.operation,requiredEvidence:def.evidence,relation:def.relation,steps:def.steps}:null,actual:goal.tasks?.[i]?{operation:goal.tasks[i].operation,requiredEvidence:goal.tasks[i].requiredEvidence,dependsOn:goal.tasks[i].dependsOn}:null};}),
  unsupported:shadow.filter(a=>!a.actionType).map(a=>a.id),source:'action_registry',executor:'existing_runtime'};
}
