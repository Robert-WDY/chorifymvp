import {textInstructions} from './prompt-text.mjs';
import {textUnitsSchema,renderTextUnits,hardTextChecks} from './hard-requirements.mjs';
import {constraintChecks,aggregateConstraintChecks} from './constraint-checks.mjs';
import {imageObservationInputs} from './observation-contract.mjs';
import {sourceUnits,resolveDeferredSelection} from './source-coverage.mjs';
import {verifyReferenceBinding} from './reference-catalog.mjs';
import {revisionSchema,revisionInstructions,applyRevision} from './document-revision.mjs';
import {assertDeltaCurrent,recordChange} from './change-set.mjs';
import {bindDelta,applyTextDelta,deltaSchema,projectStructuredDelta} from './text-delta.mjs';
import {validateSkillInput} from './skill-contracts.mjs';
import {canonicalDocument,representationFor,acceptanceRecord} from './document-contract.mjs';
import {workflowStages} from './workflow-contract.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {readSkill,findSkill} from './catalog.mjs';
import {structuredOutput,textSchema} from './goal-compiler.mjs';
import {withNode} from './trace-context.mjs';
import {currentTask,addArtifact} from './task-state.mjs';
import {resolveSources,resolveSupportingSources} from './sources.mjs';
import {itemContext,evidenceContext,projectModelInput,renderMethod,viewHash,modelViewVersion} from './model-context.mjs';
export function stageSchema(item,catalog,{checkContentConstraints=true}={}){
 const selected=(item.requiredMethods||[]).map(slug=>findSkill(catalog,slug));
 const numericScript=!['producer','upstream'].includes(item.selectionRole)&&(item.form==='script'||item.operation==='storyboard')&&item.spec?.shotCount;
 if(!selected.length&&!item.spec?.bodyLength&&!numericScript)return textSchema;
 if(selected.length>1)throw new Error('多个方法必须编译为独立阶段，禁止合并Schema冒充顺序执行');
 // Each required method contributes its own schema; incompatible writes fail validation.
 const structure={type:'object',additionalProperties:false,required:[],properties:{}};
 for(const s of selected){const schema=s.contract.outputSchema.properties.structure;structure.required=[...new Set([...structure.required,...schema.required])];Object.assign(structure.properties,schema.properties);}
 if(numericScript&&!structure.properties.shots){structure.properties.shots={type:'array'};structure.required.push('shots');}
 if(structure.properties.directions){const n=item.spec.directionCount||item.contentCardinality||item.count;structure.properties.directions={type:'array',minItems:n,maxItems:n,items:{type:'object',additionalProperties:false,required:['title','content'],properties:{title:{type:'string'},content:{type:'string',minLength:1}}}};}
 if(structure.properties.shots&&item.spec.shotCount)structure.properties.shots={type:'array',minItems:item.spec.shotCount,maxItems:item.spec.shotCount,items:{type:'object',additionalProperties:false,required:['content','durationSeconds'],properties:{content:{type:'string',minLength:1},durationSeconds:{type:'number',...(checkContentConstraints&&item.spec.secondsPerShot?{const:item.spec.secondsPerShot}:{minimum:0})}}}};
 if(item.spec?.bodyLength)structure.properties.textUnits={...textUnitsSchema,minItems:item.contentCardinality||item.count||1,maxItems:item.contentCardinality||item.count||1};
 if(item.spec?.bodyLength)structure.required.push('textUnits');
 const representation=item.spec?.bodyLength?'structured':representationFor(Object.keys(structure.properties));
 if(representation==='structured')structure.properties.sections={type:'array',items:{type:'object',additionalProperties:false,required:['content'],properties:{title:{type:'string'},content:{type:'string',minLength:1}}}};
 return {type:'object',additionalProperties:false,required:representation==='structured'?['structure']:['content','structure'],properties:{...(representation==='content'?{content:{type:'string',minLength:1}}:{}),structure}};
}
export function bindStageSources(state,item){
 const sources=resolveSources(state,item),binding=resolveDeferredSelection(item,sources);if(binding)item.resolvedSelectorBinding=binding;
 return selectStageSources(sources,item);
}
export function selectStageSources(sources,item){
 if(/^task:\d+$/.test(item.sourceSelection?.source||'')&&!item.resolvedSelectorBinding&&sources.length)throw new Error('未来来源尚未绑定真实单元，禁止把全部方向作为替代输入');
 return sources.map(s=>{
  const binding=item.resolvedSelectorBinding||item.selectorBinding;
  const supplements=s.structure?.sections?.length?{sourceSections:structuredClone(s.structure.sections)}:{};
  if(s.structure&&s.content&&s.content!==renderStage(s.structure))supplements.sourceSupplement=s.content;
  if(binding?.unitIds&&s.id===binding.sourceId){
   verifyReferenceBinding(s,binding);
   const selected=sourceUnits(s).filter(u=>binding.unitIds.includes(u.id));
   if(selected.length!==binding.unitIds.length)throw new Error('已绑定来源单元不存在');
   if(binding.type==='direction'&&selected.length===1)return {...s,...supplements,content:undefined,structure:undefined,relation:'selected_direction',selectedDirection:{...selected[0].value,id:selected[0].id,artifactId:s.id,version:s.version,index:selected[0].index}};
   return {...s,...supplements,content:undefined,structure:{[selected[0].type]:selected.map(u=>u.value)},relation:'selected_units',selectedUnits:binding.unitIds};
  }
  if(item.selectionRole!=='producer'&&item.selectionRole!=='upstream'&&item.spec.selectedDirectionIndex&&s.structure?.directions){const index=item.spec.selectedDirectionIndex-1,d=s.structure.directions[index];if(!d)throw new Error('指定方向不存在');return {...s,...supplements,content:undefined,structure:undefined,relation:'selected_direction',selectedDirection:{...d,id:d.id,artifactId:s.id,version:s.version,index:index+1}};}
  return s;
 });
}
export function validateStageResult(item,result){
 const report=constraintChecks(item,result);if(report.status==='failed')throw new Error('镜头时长或数量与阶段合同不一致：'+JSON.stringify(report.checks.filter(c=>c.status==='failed')));
}
export function renderStage(structure){
 if(structure.textUnits)return renderTextUnits(structure.textUnits);
 const labels={facts:'商品事实',assumptions:'未知项与假设',sellingPoints:'卖点',audience:'目标受众',hook:'开场',brief:'营销 Brief',directions:'创意方向',recommendation:'推荐依据',shots:'镜头',durationSeconds:'总时长（秒）',body:'正文',cta:'收尾',prompt:'提示词',preservedConstraints:'保留约束'};
 const nestedLabels={content:'画面',durationSeconds:'时长（秒）',title:'标题',description:'说明',camera:'镜头',lighting:'光线'};
 const value=v=>typeof v==='string'?v:typeof v==='number'?String(v):Array.isArray(v)?v.map((a,n)=>(n+1)+'. '+value(a)).join('\n'):Object.entries(v).filter(([k])=>!['id','version'].includes(k)).map(([k,x])=>(nestedLabels[k]||k)+'：'+value(x)).join('\n');
 return Object.entries(structure).map(([k,v])=>k==='sections'?v.map(s=>(s.title?'### '+s.title+'\n':'')+s.content).join('\n\n'):'### '+(labels[k]||k)+'\n'+value(v)).join('\n\n');
}
async function executeSingleStage(executor,item,signal,feedback,boundSources){
 const fields=(item.requiredMethods||[]).flatMap(slug=>Object.keys(findSkill(executor.catalog,slug).contract.outputSchema.properties.structure.properties));
 item={...item,selectionRole:item.selectionRole||(fields.includes('directions')?'producer':fields.some(f=>['facts','brief'].includes(f))&&!fields.some(f=>['body','shots','prompt'].includes(f))?'upstream':'consumer')};
 const consumesSelection=item.selectionRole?item.selectionRole==='consumer':!fields.some(f=>['facts','brief','directions'].includes(f));
 const {state,catalog,brain}=executor,task=currentTask(state),sources=boundSources||bindStageSources(state,item),methods=[];
 for(const slug of item.requiredMethods||[]){let offset=0,content='';do{const part=await readSkill(catalog,slug,undefined,offset);content+=part.content;offset=part.nextOffset;}while(offset!==null);methods.push({slug,content,contract:findSkill(catalog,slug).contract,contentHash:createHash('sha256').update(content).digest('hex')});}
 if(consumesSelection&&item.spec.selectedDirectionIndex&&!sources.some(s=>s.selectedDirection))throw new Error('指定方向缺少已绑定的真实产物，不能仅凭描述声称基于该方向');
 const schema=stageSchema(item,catalog,{checkContentConstraints:executor.verifier?.policy!=='delivery_only'}),input={item:itemContext(item),deliveryContract:{description:item.deliveryDescription||item.description,output:item.output},facts:task.contract?.facts||[],globalConstraints:task.contract?.globalConstraints||[],sources,supportingSources:selectStageSources(resolveSupportingSources(state,item),item),evidenceContext:evidenceContext(state,item,sources),observations:imageObservationInputs(task.items.find(i=>i.id===item.id)||item,[...resolveSources(state,item),...resolveSupportingSources(state,item)],state),feedback,methods:methods.map(m=>({slug:m.slug,contract:m.contract,content:m.content}))};
 const delta=bindDelta(item,sources);if(delta)input.changeContract=delta;
 for(const method of methods)validateSkillInput(method.contract,input);
 if(item.stageId)input.evidenceContext.role='provenance_only';
 // The raw request remains in the turn ledger. It is not replayed as a command at every stage.
 const before=state.modelCalls?.length||0;
 const methodRecords=methods.map(m=>({id:randomUUID(),skillId:m.slug,contractVersion:m.contract.version,contentHash:m.contentHash,renderedContentHash:renderMethod(m).renderedContentHash,removedRanges:renderMethod(m).removedRanges,modelViewVersion,nodeId:item.stageId||item.id,input:structuredClone(input),inputArtifacts:sources.map(s=>({id:s.id,version:s.version,relation:s.relation,selectedDirection:s.selectedDirection})),modelCallIds:[],validationScope:'schema_and_lineage',scriptChecks:{status:'not_run',required:false},contractValidated:false,status:'loaded',outputArtifactIds:[]}));
 const owner=task.items.find(i=>i.id===item.id);if(owner)(owner.methods??=[]).push(...methodRecords);
 await executor.save?.(state);
 let result;
 try {
 if(delta&&!methods.length){
  const source=sources.find(s=>s.id===delta.source.id);
  const proposal=await withNode(item.stageId||item.id,'document_revision',()=>structuredOutput(brain,revisionInstructions,
   projectModelInput({...input,changeContract:delta,sourceDocument:source,previousCandidate:feedback?.content||null},renderStage),revisionSchema(source),signal,r=>applyRevision(source,delta,r,renderStage)));
  result=applyRevision(source,delta,proposal,renderStage);
 }else result=await withNode(item.stageId||item.id,methods.map(m=>m.slug).join(','),()=>structuredOutput(brain,textInstructions(schema),projectModelInput(input,renderStage),schema,signal,r=>executor.verifier?.policy==='delivery_only'?undefined:validateStageResult(item,r)));
 const deltaMetadata={deltaEvidence:result.deltaEvidence,noChange:result.noChange};const structuredDelta=!!result.deltaEvidence&&!!result.structure;if(structuredDelta)delete result.content;result=canonicalDocument(result,structuredDelta||!schema.properties.content?'structured':'content',renderStage);Object.assign(result,deltaMetadata);
 for(const record of methodRecords)Object.assign(record,{modelCallIds:(state.modelCalls||[]).slice(before).filter(c=>c.status==='returned').map(c=>c.id),contractValidated:true,status:'validated'});
 result.factBoundary=input.evidenceContext.factBoundary;
 result.verificationSources=[...sources,...input.supportingSources];
 return {result,methodRecords,sources};
 }catch(error){for(const record of methodRecords)Object.assign(record,{status:'failed',error:error.message,modelCallIds:(state.modelCalls||[]).slice(before).map(c=>c.id)});await executor.save?.(state);throw error;}
}
export function publishTextCandidate(executor,item,result,methodRecords,verdict,parentId){
 if(item.changeContract?.source)parentId=item.changeContract.source.id;
 if(item.changeContract?.source)assertDeltaCurrent(executor.state,item.changeContract);
 if(result.noChange&&verdict.passed){recordChange(executor.state.taskStore.tasks[executor.state.taskStore.activeTaskId],item,{status:'no_change',artifactId:item.changeContract.source.id,verification:verdict});item.noChangeReceipt={source:item.changeContract.source,verification:verdict};return executor.state.taskStore.artifacts[item.changeContract.source.id];}
 const artifact=addArtifact(executor.state,{itemId:item.id,type:'text',content:result.content,metadata:{constraintChecks:result.stages?.length?aggregateConstraintChecks(result.stages.map(s=>({id:s.stageId,report:executor.state.taskStore.artifacts[s.artifactId]?.metadata?.constraintChecks}))):constraintChecks(item,result),deltaEvidence:result.deltaEvidence,stages:result.stages,deliverySlot:item.deliverySlot,unitCount:item.contentCardinality||item.count,structure:result.structure,document:result.document,conversion:result.conversion},parentId,verification:{technical:'passed',semantic:verdict.passed?'passed':verdict.uncertain?'unverified':'failed',issues:verdict.issues}});
 const selection=item.resolvedSelectorBinding||item.selectorBinding;if(selection)artifact.metadata.sourceSelectionBinding=structuredClone(selection);
 if(result.factBoundary)artifact.metadata.factBoundary=structuredClone(result.factBoundary);
 if(artifact.metadata.structure?.directions)artifact.metadata.structure.directions=artifact.metadata.structure.directions.map((d,n)=>({...d,id:result.deltaEvidence&&d.id?d.id:artifact.id+':direction:'+(n+1),version:artifact.version}));
 for(const record of methodRecords){record.outputArtifactIds=[artifact.id];if(!item.methods.some(m=>m.id===record.id))item.methods.push(record);}
 artifact.acceptance={constraintChecks:artifact.metadata.constraintChecks,procedure:{passed:methodRecords.length===(item.requiredMethods||[]).length},...acceptanceRecord(verdict,result.content)};artifact.publication=verdict.passed?'current':'audit';
 recordChange(executor.state.taskStore.tasks[executor.state.taskStore.activeTaskId],item,{status:verdict.passed?'published':'failed',candidateId:artifact.id,verification:verdict});
 if(verdict.passed&&parentId){const parent=executor.state.taskStore.artifacts[parentId];if(parent)parent.publication='superseded';}
 return artifact;
}
export async function executeTextStage(executor,item,signal,feedback){
 const binding=resolveDeferredSelection(item,resolveSources(executor.state,item));
 if(binding){item.resolvedSelectorBinding=binding;const owner=currentTask(executor.state)?.items.find(i=>i.id===item.id);if(owner)owner.resolvedSelectorBinding=structuredClone(binding);}
 const stages=workflowStages(item);
 if(!stages.length)return executeSingleStage(executor,item,signal,feedback);
 const {state,catalog}=executor,task=currentTask(state),methodRecords=[],outputs=[];
 const external=resolveSources(state,item);
 for(const stage of stages){
  const contract=findSkill(catalog,stage.skillId)?.contract;
  if(!contract)throw new Error('阶段方法不存在：'+stage.skillId);
  const fields=contract.outputSchema.properties.structure.properties;
  if(fields.directions&&!item.spec.directionCount)throw new Error('合并文档缺少独立方向数量合同');
  const spec={...item.spec};if(!fields.directions)delete spec.directionCount;
  if(!Object.keys(fields).some(f=>['body','prompt'].includes(f)))delete spec.bodyLength;
  // Selection is consumed after the direction producer, never by that producer.
  const selectionRole=fields.directions?'producer':Object.keys(fields).some(f=>['body','shots','prompt'].includes(f))?'consumer':'upstream';
  const stageItem={...item,stageId:stage.id,deliveryDescription:item.description,description:contract.role+'；本阶段只交付字段：'+Object.keys(fields).join('、'),requiredMethods:[stage.skillId],selectionRole,spec,count:fields.directions?spec.directionCount:1,contentCardinality:fields.directions?spec.directionCount:1,artifactCount:1};
  const sources=selectStageSources([...external,...outputs.map(a=>({id:a.id,version:a.version,type:'text',content:a.content,structure:a.metadata.document?.kind==='content'?undefined:a.metadata.structure,factBoundary:a.metadata.factBoundary,provenance:{origin:'model_artifact',factualSupport:'not_checked'},relation:'workflow_stage'}))],stageItem);
  const {result,methodRecords:records}=await executeSingleStage(executor,stageItem,signal,feedback,sources);
  const a=addArtifact(state,{itemId:item.id,type:'text',purpose:'support',content:result.content,metadata:{constraintChecks:constraintChecks(stageItem,result),stageId:stage.id,deliverySlot:(item.deliverySlot??0)+':'+stage.id,structure:result.structure,document:result.document,conversion:result.conversion},verification:{technical:'passed',semantic:'passed'}});
  if(a.metadata.structure?.directions)a.metadata.structure.directions=a.metadata.structure.directions.map((d,n)=>({...d,id:a.id+':direction:'+(n+1),version:a.version}));
  a.publication='internal';a.acceptance={constraintChecks:a.metadata.constraintChecks,procedure:{passed:true},quality:{status:'not_evaluated'}};
  a.metadata.factBoundary=structuredClone(result.factBoundary);
  outputs.push(a);
  for(const record of records){record.stageIndex=stage.index;record.supportOutputArtifactIds=[a.id];methodRecords.push(record);}
  const node=task.executionPlan?.nodes.find(n=>n.itemId===item.id);
  if(node){node.stageExecutions??=[];node.stageExecutions.push({stageId:stage.id,status:'completed',inputArtifacts:records[0].inputArtifacts,outputArtifactId:a.id,methodRecords:structuredClone(records)});}
  await executor.record('run_skill_stage',{slug:stage.skillId,nodeId:stage.id,inputArtifactIds:sources.map(s=>s.id)},{artifactId:a.id,contractValidated:true});
  await executor.save(state);
 }
 // Assembly is deterministic: one file, ordered stage sections, no new model call.
 const result=canonicalDocument({content:outputs.map((a,n)=>'## '+(n+1)+'. '+findSkill(catalog,stages[n].skillId).contract.role+'\n\n'+a.content).join('\n\n'),stages:outputs.map((a,n)=>({stageId:stages[n].id,skillId:stages[n].skillId,artifactId:a.id,version:a.version}))},'content',renderStage);
 result.stageChecks=outputs.flatMap(a=>{
  const structure=a.metadata.structure,spec={...item.spec};
  if(!structure?.shots)for(const k of ['shotCount','secondsPerShot','durationSeconds'])delete spec[k];
  if(!structure?.directions)delete spec.directionCount;
  if(!structure?.textUnits)delete spec.bodyLength;
  delete spec.exactTexts; // Exact strings are checked against the assembled delivery.
  return hardTextChecks({...item,spec},{content:a.content,structure}).checks.map(c=>({...c,stageArtifactId:a.id,stageVersion:a.version}));
 });
 result.factBoundary=evidenceContext(state,item,[...external,...outputs.map(a=>({id:a.id,version:a.version,content:a.content,structure:a.metadata.structure,factBoundary:a.metadata.factBoundary,provenance:{origin:'model_artifact'}}))]).factBoundary;
 result.verificationSources=selectStageSources(external,item);
 return {result,methodRecords,sources:external};
}
