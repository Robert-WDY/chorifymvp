// Stages scope execution permissions; no keyword matching or extra planner.
export const activationSchema={type:'object',additionalProperties:false,required:['timing','condition'],properties:{timing:{enum:['now','after_user_input']},condition:{type:'string'}}};
export const authorizationSchema={type:'object',additionalProperties:false,properties:Object.fromEntries(['image','video','audio'].map(k=>[k,{type:'boolean'}]))};
export const isDeferred=item=>item.activation?.timing==='after_user_input';
export function applyStages(semantic){
 const ds=semantic.deliverables||[];
 for(const gap of semantic.gaps||[])if(gap.level==='blocking'){
  if(!gap.scope&&gap.affectedDeliverables?.length)gap.scope='deliverables';
  if(!gap.scope)throw Object.assign(new Error('阻塞缺口必须声明影响范围：global或deliverables'),{code:'stage_contract',issues:[{path:'/gaps'}]});
  if(gap.scope==='global'&&gap.affectedDeliverables?.length||gap.scope==='deliverables'&&!gap.affectedDeliverables?.length)throw Object.assign(new Error('缺口范围与交付索引冲突'),{code:'stage_contract'});
 }
 for(const gap of semantic.gaps||[])if(gap.level==='blocking'&&gap.affectedDeliverables?.length){
  for(const index of gap.affectedDeliverables){
   if(!Number.isInteger(index)||!ds[index])throw Object.assign(new Error('局部缺口引用了不存在的交付'),{code:'stage_contract'});
   const d=ds[index];d.activation={timing:'after_user_input',condition:gap.description};
  }
 }
 for(const [index,d] of ds.entries()){
  if(isDeferred(d)&&!d.activation.condition.trim())throw Object.assign(new Error('后续阶段必须声明真实等待条件'),{code:'stage_contract'});
  const gated=(d.dependsOn||[]).filter(i=>i<index).map(i=>ds[i]).find(isDeferred);
  if(gated&&!isDeferred(d))d.activation={timing:'after_user_input',condition:'等待前序条件：'+gated.activation.condition};
  if(!isDeferred(d)&&semantic.executionAuthorization?.[d.kind]===false&&!['present','retain'].includes(d.action))throw Object.assign(new Error('当前交付与媒体授权范围冲突；应保留未授权阶段，不能提交媒体'),{code:'authorization_conflict'});
 }
 // approval is the saved media submission gate, not a requirement to invent media.
 if(semantic.approval?.required&&!ds.some(d=>d.kind!=='text')){
  semantic.reviewIntent={required:true,reason:semantic.approval.reason};
  semantic.approval={required:false,reason:'当前仅交付文字；媒体操作未授权'};
 }
 return semantic;
}
export const globalBlockingGaps=semantic=>(semantic.gaps||[]).filter(g=>g.level==='blocking'&&g.scope==='global');
export function stageSummary(task){
 return {current:task.items.filter(i=>!isDeferred(i)).map(i=>({itemId:i.id,status:i.status})),conditional:task.items.filter(isDeferred).map(i=>({itemId:i.id,condition:i.activation.condition,status:i.status})),authorization:task.contract?.executionPermission||task.goal.requestContract?.currentPermission};
}
