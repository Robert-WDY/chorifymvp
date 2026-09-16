import {resolveMessage} from './conversation-query.mjs';
import {sourceDigest} from './reference-catalog.mjs';
import {validationTrace} from './trace-context.mjs';
import {queryRegistry,querySchema,presentationSchema,assertQueryTopic,isPresentation} from './query-registry.mjs';

// A turn operates on persisted objects. Reading one never copies its execution obligations.
export const turnOperationSchema={type:'object',additionalProperties:false,required:['kind'],properties:{kind:{enum:['answer','summarize','explain','create','inspect','observe','present','retain','modify','translate','consume','resume','approve','cancel','revise_plan']},targetTaskId:{type:'string'},query:querySchema,answerContract:{type:'object',additionalProperties:false,properties:{questionDimensions:{type:'array',items:{type:'string'}},scope:{enum:['session','task','message']}}},presentation:presentationSchema}};
export const revisionDeltaSchema={type:'object',additionalProperties:false,required:['targetArtifactId','targetVersion','changes','preserve'],properties:{targetArtifactId:{type:'string',minLength:1},targetVersion:{type:'integer',minimum:1},changes:{type:'array',minItems:1,maxItems:1,items:{type:'object',additionalProperties:false,required:['field','from','to'],properties:{field:{const:'ratio'},from:{type:'string',minLength:1},to:{type:'string',minLength:1}}}},preserve:{type:'array',uniqueItems:true,minItems:3,maxItems:3,items:{enum:['duration','source','facts']}}}};
export function revisionTarget(snapshot){
 const node=snapshot?.executionPlan?.nodes?.find(n=>n.itemId===snapshot.approval?.payload?.itemId);
 const artifact=(snapshot?.artifacts||[]).find(a=>a.id===node?.skillArtifactId);
 if(!artifact)return null;
 return {targetArtifactId:artifact.id,targetVersion:artifact.version||1,sourceHash:sourceDigest(artifact),taskId:snapshot.id,taskRevision:snapshot.revision,planHash:snapshot.approval.planHash,changeOnly:['ratio'],parameters:structuredClone(snapshot.approval.payload.items)};
}

// Model-facing view of the existing operation. Compatibility fields are projections,
// never a second model decision or another independently writable task state.
export function operationInputSchema(semanticSchema){
 const schema=structuredClone(semanticSchema);
 // The model states only the delta. Persisted source identity and unchanged
 // values are bound below; supplied compatibility values are still checked.
 schema.properties.revisionDelta=structuredClone(revisionDeltaSchema);
 schema.properties.revisionDelta.required=['changes'];
 schema.properties.revisionDelta.properties.changes.items.required=['field','to'];
 for(const key of ['continuation','spec','requiredMethods','deferred','executionMode','reviewIntent'])delete schema.properties[key];
 schema.required=['summary','turnOperation','deliverables','safety','approval'];
 schema.allOf=[{if:{properties:{turnOperation:{properties:{kind:{const:'revise_plan'}},required:['kind']}},required:['turnOperation']},then:{required:['revisionDelta'],properties:{turnOperation:{required:['targetTaskId']},deliverables:{maxItems:0}}},else:{not:{required:['revisionDelta']}}}];
 const item=schema.properties.deliverables.items;
 for(const key of ['businessOperation','resultRelation','selectionRole','specOrigins','referenceBindings','supportingSourceBindings','coverage','runtimeQuery','countDeclared','evidenceSegments','preservedSpec','selectorBinding','executionShape'])delete item.properties[key];
 item.required=['description','kind','action'];
 const common=['description','kind','action','count','references','dependsOn','constraints','requestEvidence','requestEvidenceSpans','activation','selector'];
 const extra={text:['query','purpose','requiredEvidence','form','spec','requiredMethods','supportingSources','sourceSelection','artifactCount','contentCardinality','observationEvidence','changeContract'],image:['requiredMethods','spec','changeContract','supportingSources','sourceSelection'],video:['requiredMethods','spec','supportingSources','sourceSelection'],audio:['spec','supportingSources']};
 const imageDelta={type:'object',additionalProperties:false,required:['change','preserve'],properties:{change:{type:'array',minItems:1,items:{type:'string',minLength:1}},preserve:{type:'array',items:{type:'string'}}}};
 schema.properties.deliverables.items={oneOf:Object.entries(extra).map(([kind,keys])=>{
  const variant={type:'object',additionalProperties:false,required:[...item.required,...(kind==='text'?[]:['count'])],properties:Object.fromEntries([...common,...keys].map(k=>[k,k==='kind'?{const:kind}:item.properties[k]]))};
  if(kind!=='text'){
   variant.properties.action={enum:['create','modify','present','retain']};
   variant.properties.spec={...item.properties.spec,properties:Object.fromEntries(Object.entries(item.properties.spec.properties).filter(([key])=>(kind==='image'?['ratio','exactTexts']:['ratio','durationSeconds']).includes(key)))};
  }
  if(kind==='image')variant.allOf=[{if:{properties:{action:{const:'modify'}},required:['action']},then:{required:['changeContract'],properties:{changeContract:imageDelta}}}];
  return variant;
 })};
 return schema;
}

export function applyPlanDelta(semantic,snapshot,query){
 if(semantic.turnOperation?.kind!=='revise_plan')return semantic;
 if(!snapshot?.id||snapshot.id!==semantic.continuation.taskId||!snapshot.approval?.payload?.items?.length)throw new Error('方案修订必须绑定实际保存的待确认参数');
 let patches=semantic.deliverables||[];const pending=(snapshot.goal?.semantic?.deliverables||[]).filter(d=>d.kind==='video');
 if(semantic.revisionDelta){
  const delta=semantic.revisionDelta,target=revisionTarget(snapshot),change=delta.changes?.[0];
  if(target){
   delta.targetArtifactId??=target.targetArtifactId;delta.targetVersion??=target.targetVersion;
   delta.preserve??=['duration','source','facts'];
   const ratios=[...new Set(target.parameters.map(p=>p.ratio))];
   if(change&&ratios.length===1)change.from??=ratios[0];
  }
  if(patches.length||pending.length!==1||!target||delta.targetArtifactId!==target.targetArtifactId||delta.targetVersion!==target.targetVersion)throw new Error('方案增量必须唯一绑定已保存方案产物及版本');
  if(snapshot.approval.status!=='pending'||snapshot.status!=='WAIT_CONFIRM')throw new Error('参数增量只能修改待确认方案');
  if(delta.changes.length!==1||change.field!=='ratio'||target.parameters.some(p=>p.ratio!==change.from)||pending[0].spec?.ratio!==change.from)throw new Error('方案参数来源值已变化或增量字段不受支持');
  if(!['duration','source','facts'].every(k=>delta.preserve.includes(k)))throw new Error('参数增量必须保留时长、来源和事实');
  semantic.executionMode='parameter_delta';
  patches=[{kind:'video',count:pending[0].count,spec:{ratio:change.to},requestEvidence:query}];
 }
 if(patches.length!==1||pending.length!==1||patches[0].kind!=='video')throw new Error('方案增量必须唯一绑定原视频方案；复杂增删须明确逐项范围');
 const delta=patches[0],original=structuredClone(pending[0]);
 if(!delta.spec||!Object.keys(delta.spec).length||Object.keys(delta.spec).some(k=>!['ratio'].includes(k)))throw new Error('方案参数增量短路径仅支持明确的画幅；内容修改须使用完整修订');
 if(delta.count!==original.count)throw new Error('参数修订不能改变媒体数量，新增目标须单独声明');
 original.references=(original.references||[]).map(ref=>{
  if(!/^task:\d+$/.test(ref))return ref;
  const index=Number(ref.slice(5)),owner=snapshot.items?.[index];
  const accepted=(snapshot.artifacts||[]).filter(a=>a.itemId===owner?.id&&a.purpose==='deliverable'&&a.verification?.semantic==='passed'&&a.publication!=='superseded');
  if(accepted.length!==1)throw new Error('旧方案上游没有唯一合格产物，不能删掉依赖继续');
  return accepted[0].id;
 });
 original.dependsOn=[];original.spec={...original.spec,...delta.spec};
 const oldRatio=pending[0].spec?.ratio;
 original.constraints=(original.constraints||[]).map(c=>oldRatio&&delta.spec?.ratio?c.replaceAll(oldRatio,delta.spec.ratio):c);
 semantic.facts=[...new Set([...(snapshot.goal.semantic.facts||[]),...(semantic.facts||[])])];
 semantic.globalConstraints=[...new Set([...(snapshot.goal.semantic.globalConstraints||[]).map(c=>oldRatio?c.replaceAll(oldRatio,delta.spec.ratio):c),...(semantic.globalConstraints||[])])];
 // The original professional output is reused through the revision-bound plan.
 // A ratio-only delta has no new creative-method execution obligation.
 original.requiredMethods=[];
 original.description=(oldRatio?original.description.replaceAll(oldRatio,delta.spec.ratio):original.description)+'\n本轮方案增量：'+query;
 original.requestEvidence=delta.requestEvidence||query;
 semantic.deliverables=[original];semantic.approval={required:true,reason:'已保存方案修订后需重新确认'};
 return semantic;
}

export function projectOperationCandidate(s,catalog){
 const legacy=Object.hasOwn(s,'continuation');
 s.gaps??=[];s.assumptions??=[];s.deferred??=[];s.facts??=[];s.globalConstraints??=[];
 if(!legacy){
  const op=s.turnOperation||{},kind=op.kind,target=op.targetTaskId||'';
  s.continuation={mode:({resume:'continue',approve:'approve',cancel:'cancel',revise_plan:'revise'})[kind]||(kind==='modify'&&target?'revise':'new'),taskId:target};
  if(s.continuation.mode==='new')s.continuation.taskId='';
 }
 for(const d of s.deliverables||[]){
  d.purpose??='general';d.requiredEvidence??='none';d.references??=[];d.dependsOn??=[];d.constraints??=[];
  d.countDeclared??=Object.hasOwn(d,'count');
  if(!legacy&&d.kind==='text')d.count??=1;
  d.requestEvidence??='';
 }
 const identity=x=>x.normalize('NFKC').replace(/\s+/g,'').replace(/skill$/i,'').toLowerCase();
 const canonical=name=>{const exact=catalog.skills.find(m=>m.slug===name);if(exact)return exact.slug;const candidates=catalog.skills.filter(m=>[m.name,...(m.aliases||[])].some(a=>identity(a)===identity(name)));return candidates.length===1?candidates[0].slug:name;};
 for(const d of s.deliverables||[])d.requiredMethods=[...new Set((d.requiredMethods||[]).map(canonical))];
 s.requiredMethods=[...new Set((s.requiredMethods||[]).map(canonical))];
 if(s.deliverables?.length>1&&s.requiredMethods.some(m=>!s.deliverables.some(d=>d.requiredMethods.includes(m))))throw new Error('全局方法没有目标归属，请只补齐各项requiredMethods，不增加交付');
 if(s.deliverables?.length===1)s.deliverables[0].requiredMethods=[...new Set([...s.deliverables[0].requiredMethods,...s.requiredMethods])];
 return s;
}
export function readOperation(query,semantic){
 const supplied=semantic?.turnOperation;
 if(['answer','summarize','explain'].includes(supplied?.kind)){
  if(semantic.deliverables?.some(d=>d.kind!=='text'||!['respond','query','inspect'].includes(d.action)||d.requiredMethods?.length||!['none','runtime','image','video',undefined].includes(d.requiredEvidence)))throw new Error('非生产回答不能承载媒体生成或专业Skill执行；请保留生产义务');
  if(supplied.query&&semantic.deliverables?.some(d=>['image','video'].includes(d.requiredEvidence)))throw Object.assign(new Error('记录查询与实际媒体观察不能互相替代，请保留所需证据并修正查询字段'),{issues:[{path:'/turnOperation/query',removeOnly:true}]});
  if(supplied.query)assertQueryTopic(query,supplied);
  return supplied;
 }
 if(['present','retain'].includes(supplied?.kind)){
  if(semantic.deliverables?.some(d=>!['respond','query','present','retain'].includes(d.action)))throw new Error('呈现操作不能授权生产；混合请求保留各项动作');
  if(!supplied.presentation?.targets?.length)throw new Error('呈现已有成果必须绑定已有对象及版本，不能伪造新增交付');
  return supplied;
 }
 if(supplied?.kind==='inspect'&&supplied.query){
  assertQueryTopic(query,supplied);
  if(semantic.deliverables?.some(isPresentation))throw Object.assign(new Error('呈现已有正文或媒体与元数据查询合同不一致，请选择 present 并保留原对象和顺序'),{code:'operation_selection',issues:[{path:'/turnOperation/kind'},{path:'/turnOperation/presentation'}]});
  if(semantic.deliverables?.some(d=>['image','video','web'].includes(d.requiredEvidence)||d.requiredMethods?.length))throw Object.assign(new Error('元数据查询不能满足素材观察或专业内容执行合同。保留交付、来源和 requiredEvidence，重新选择完整操作；observe 用于观察素材后回答。'),{code:'operation_selection',issues:[{path:'/turnOperation/kind'}]});
  if(!semantic.deliverables?.every(d=>['respond','query','inspect','present'].includes(d.action)))throw new Error('只读操作与生产交付冲突，必须分别保留查询与生产范围');
  return supplied;
 }
 return null;
}
export function normalizeTurnOperation(semantic,query){
 // A typed conversational response is not an artifact-producing operation.
 if(['create','observe'].includes(semantic.turnOperation?.kind)&&semantic.deliverables?.length&&semantic.deliverables.every(d=>d.kind==='text'&&d.action==='respond'&&d.form==='answer'&&!d.requiredMethods?.length&&['none','runtime',undefined].includes(d.requiredEvidence)&&!d.dependsOn?.length)){
  semantic.turnOperation={...semantic.turnOperation,kind:'answer'};
 }
 const read=readOperation(query,semantic);
 if(read){
  const old=semantic.continuation?.taskId;
  semantic.turnOperation={...read,targetTaskId:read.targetTaskId||old||''};
  semantic.continuation={mode:'new',taskId:''};semantic.approval={required:false,reason:'本轮只读；原任务义务和批准保持不变'};
  semantic.deferred=[];return semantic;
 }
 const translation=semantic.turnOperation?.kind==='translate';
 for(const d of semantic.deliverables||[]){
  if(d.kind!=='text')continue;
  if(translation){d.businessOperation='translate';d.resultRelation='derived_from';d.action='create';}
  else if(d.action==='modify'&&(d.references?.length||d.dependsOn?.length)){d.businessOperation='modify';d.resultRelation='revision_of';
   // The original delta, not a regenerated summary, is the authority for an edit.
   d.changeContract={kind:'document_change',request:query,...(d.changeContract?.scope?{scope:d.changeContract.scope}:{})};
   const previous=d.description;d.description=query;
   if(previous!==query)validationTrace({phase:'bind_edit_delta',discardedDescription:previous,request:query});
  }
 }
 if(translation){semantic.turnOperation={kind:'translate',targetTaskId:semantic.continuation?.taskId||''};semantic.continuation={mode:'new',taskId:''};semantic.approval={required:false,reason:'派生文字翻译不复用原执行批准'};}
 return semantic;
}

export function scopedSpecification(spec,d,peers,catalog){
 const fields=Object.fromEntries(Object.entries(spec||{}).filter(([key])=>{
  if(d.kind==='image'&&['shotCount','secondsPerShot','durationSeconds'].includes(key))return false;
  if(key!=='directionCount')return true;
  const ownsDirection=x=>x.form==='directions'||(x.requiredMethods||[]).some(slug=>catalog.skills.find(s=>s.slug===slug)?.contract.outputSchema?.properties?.structure?.properties?.directions);
  return ownsDirection(d)||peers.length===1;
 }));return fields;
}

export function normalizeConsumedStages(d,query,catalog,sources){
 if(!sources.length)return;
 if(d.kind==='image'&&d.action==='modify'&&sources.every(s=>(s.type||s.kind)==='image')){
  discardImageDirectionSelector(d);
  if(sources.length===1)d.selectorBinding={type:'artifact',artifactId:sources[0].id||sources[0].assetId,version:sources[0].version||1,sourceHash:sourceDigest(sources[0]),...(d.selector?.ordinal?{ordinal:d.selector.ordinal}:{})};
 }
 const directionSource=sources.some(s=>s.metadata?.structure?.directions||s.structure?.directions);
 const methodRequested=slug=>{const s=catalog.skills.find(s=>s.slug===slug);return query.includes(slug)||!!s?.name&&query.includes(s.name);};
 if(d.spec?.selectedDirectionIndex&&directionSource&&d.form!=='directions'){
  d.selectionRole='consumer';
  delete d.spec.directionCount;if(d.specOrigins)delete d.specOrigins.directionCount;
 }
 if(d.kind==='text'&&['modify','translate'].includes(d.businessOperation)){
  d.preservedSpec={...d.preservedSpec,...Object.fromEntries(['directionCount','selectedDirectionIndex'].filter(k=>d.spec?.[k]!==undefined).map(k=>[k,d.spec[k]]))};
  for(const k of ['selectedDirectionIndex','directionCount']){if(d.spec)delete d.spec[k];if(d.specOrigins)delete d.specOrigins[k];}
 }
 if(d.spec?.selectedDirectionIndex&&directionSource){
  const matches=sources.filter(s=>(s.metadata?.structure||s.structure)?.directions?.[d.spec.selectedDirectionIndex-1]);
  if(matches.length!==1)throw new Error('方向选择必须绑定唯一来源集合');
  const source=matches[0],unit=(source.metadata?.structure||source.structure).directions[d.spec.selectedDirectionIndex-1];
  d.selectorBinding={type:'direction',sourceId:source.id,version:source.version||1,unitId:unit.id||source.id+':direction:'+d.spec.selectedDirectionIndex,index:d.spec.selectedDirectionIndex};
 }
 if(d.spec?.selectedDirectionIndex&&!directionSource&&sources.every(s=>(s.type||s.kind)!=='text')&&d.action==='modify'){
  // The image target is already bound. Reject only the redundant untyped selector.
  validationTrace({phase:'discard_unbound_selector',field:'selectedDirectionIndex',value:d.spec.selectedDirectionIndex,targets:d.references,reason:'绑定集合不含 directions，图片序号已解析为目标ID'});
  delete d.spec.selectedDirectionIndex;if(d.specOrigins)delete d.specOrigins.selectedDirectionIndex;
 }
 const producesDirections=slug=>!!catalog.skills.find(s=>s.slug===slug)?.contract.outputSchema?.properties?.structure?.properties?.directions;
 if(d.selectionRole==='consumer'||d.businessOperation==='modify'||d.businessOperation==='translate')d.requiredMethods=(d.requiredMethods||[]).filter(slug=>!producesDirections(slug)||methodRequested(slug));
}

export function discardImageDirectionSelector(d){
 if(!((d.kind==='image'&&d.action==='modify')||d.operation==='edit_image'))return;
 if(d.spec?.selectedDirectionIndex===undefined)return;
 validationTrace({phase:'selector_type_warning',warning:'image selector cannot map to direction selector',field:'selectedDirectionIndex',before:d.spec.selectedDirectionIndex});
 delete d.spec.selectedDirectionIndex;if(d.specOrigins)delete d.specOrigins.selectedDirectionIndex;
}

export function inspectionGoal(query,semantic,candidates,messages){
 const op=semantic.turnOperation,selection=['present','retain'].includes(op.kind)?{type:'presentation',targets:op.presentation.targets,bindings:op.presentation.bindings,format:op.presentation.format,order:'as_listed'}:op.query?{type:queryRegistry[op.query.kind],targets:op.query.targets,includeQuote:!!op.query.includeQuote,topicMatched:true}:{type:'conversation',topicMatched:true};
 const ids=op.query?.taskIds?.length?op.query.taskIds:op.targetTaskId?[op.targetTaskId]:[];
 selection.sourceBindings=semantic.readSourceBindings||[];
 selection.messages=semantic.readMessageBindings||[];
 // Evidence reads are independent of the answer's output medium. Metadata queries
 // and presentation never acquire observation obligations from nearby images.
 selection.observations=!op.query&&!['present','retain'].includes(op.kind)?(semantic.deliverables||[]).flatMap(d=>{
  const visual=['image','video'].includes(d.requiredEvidence);
  if(!visual&&!['analysis','review'].includes(d.form))return [];
  const selected=selection.sourceBindings.filter(b=>(d.references||[]).some(ref=>ref===b.id||ref===b.handle)&&['image','video'].includes(b.type));
  if(visual&&!selected.some(b=>b.type===d.requiredEvidence))throw new Error('媒体观察缺少对应类型的已绑定来源');
  return selected.map(b=>({sourceId:b.id,kind:b.type,question:d.description}));
 }):[];
 if(ids.some(id=>!candidates.some(t=>t.id===id)))throw new Error('只读查询的目标任务不存在');selection.taskIds=ids;
 if(selection.type==='history'){
  selection.message=resolveMessage(messages,op.query);selection.requestedAnchor=op.query.messageId||null;
 }
 const dimensions=op.answerContract?.questionDimensions?.length?op.answerContract.questionDimensions:(semantic.deliverables||[]).map(d=>d.description).filter(Boolean);
 selection.answerContract={operation:op.kind,questionDimensions:dimensions.length?dimensions:[query],scope:op.answerContract?.scope||(ids.length?'task':'session'),taskIds:ids};
 const bindings=op.presentation?.bindings||[],messageIds=bindings.filter(b=>b.referenceType==='message').map(b=>b.id);
 const output=selection.type==='presentation'?(bindings.find(b=>b.referenceType!=='message')?.type||'text'):'text';
 return {summary:query,mode:'answer',tasks:[{operation:selection.type==='presentation'?'present':'inspect_runtime',output,count:1,artifactCount:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'runtime',requiredMethods:[],spec:{},form:'answer',executionShape:'direct',runtimeQuery:selection}],skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:semantic.safety,semantic,requestContract:{readOnly:true,newArtifacts:0,artifactReferences:(selection.targets||[]).filter(id=>!messageIds.includes(id)),messageReferences:messageIds,currentPermission:{mediaSubmission:'denied'},media:{image:0,video:0,audio:0},systemFacts:[],query:selection,requiredMethods:[]},readOnlyTurn:true};
}
