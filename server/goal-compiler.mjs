import {mediaInstructions} from './prompt-text.mjs';
import {selectStageSources} from './text-stage.mjs';
import {assertExecutionProjection} from './execution-projection.mjs';
import {evidenceContext,projectModelInput,renderMethod,modelViewVersion} from './model-context.mjs';
import {resolveDeferredCoverage,resolveDeferredSelection,sourceUnits,coverageAssignments,assertCoverageSource,coverageStatus} from './source-coverage.mjs';
import {parseStructured,normalizeOutputMetadata,isSchemaEcho} from './structured-codec.mjs';
import {assertWorkflow} from './planning-boundary.mjs';
import {workflowStages} from './workflow-contract.mjs';
import {createHash} from 'node:crypto';
import {readSkill} from './catalog.mjs';
import {withNode,withTool} from './trace-context.mjs';
import {inspectionOperations} from './runtime-facts.mjs';
import {validationTrace} from './trace-context.mjs';
import {inheritedImageSize} from './image-metadata.mjs';
import Ajv from 'ajv';
import {fingerprint} from './adapters.mjs';
import {methodContext,videoDefaults} from './model-context.mjs';
import {mediaSkillFor} from './media-skill-contracts.mjs';
import {ReferenceCatalog} from './reference-catalog.mjs';
import {resolveSources,resolveSupportingSources} from './sources.mjs';
import {taskArtifacts,currentTask,storeOf,setPlan,addArtifact,transition} from './task-state.mjs';
const ajv=new Ajv({strict:false,allErrors:true});
const textOperations=new Set(['answer','rewrite','marketing_script','storyboard','review_content']);
export function specializeMediaSchema(skill,item,count,inheritedSize,requiredReferences=[]){
 if(count>20)throw new Error('当前单批最多20件媒体，原始数量已保留，尚未提交生成');
 const schema=structuredClone(skill.outputSchema);schema.properties.items.minItems=count;schema.properties.items.maxItems=count;
 schema.properties.items.description='每个item是一件完整最终成品，不是镜头、分镜或内部步骤。';
 const args=schema.properties.items.items;
 if(skill.tool==='generate_image'&&requiredReferences.length){args.properties.referenceImages={...args.properties.referenceImages,const:[...new Set(requiredReferences)]};args.required=[...new Set([...args.required,'referenceImages'])];}
 if(skill.tool==='generate_image'&&!item.spec.ratio&&!inheritedSize){args.properties.size={...args.properties.size,const:'2048x2048'};args.required=[...new Set([...args.required,'size'])];}
 if(inheritedSize){args.properties.size={...args.properties.size,const:inheritedSize};args.required=[...new Set([...args.required,'size'])];}
 if(skill.tool==='generate_video'){
  const duration=item.spec.durationSeconds||videoDefaults.durationSeconds,ratio=item.spec.ratio||videoDefaults.ratio;
  if(duration<2||duration>12||!Number.isInteger(duration))throw new Error('当前单次视频支持2至12秒整数时长，不能擅自改变目标时长');
  args.properties.duration={...args.properties.duration,const:duration};args.properties.ratio={...args.properties.ratio,const:ratio};args.required=[...new Set([...args.required,'duration','ratio'])];
 }
 return schema;
}
export function compileGoal(task){
 assertExecutionProjection(task);
 const nodes=task.items.map((item,index)=>{
  assertWorkflow(item,task.items);
  if(item.dependsOn.some(n=>n>=index||n<0))throw new Error('执行图依赖无效');
  const skill=mediaSkillFor(item.operation),supported=inspectionOperations.has(item.operation)||!!skill||(textOperations.has(item.operation)||item.operation==='analyze_image')&&(!item.requiredEvidence||['none','image'].includes(item.requiredEvidence));
  return{id:item.id,itemId:item.id,dependsOn:item.dependsOn.map(n=>task.items[n].id),kind:inspectionOperations.has(item.operation)?'inspection':skill?'media':supported?'text':'unsupported',requiredMethods:item.requiredMethods||[],outputContract:{stages:workflowStages(item),...(item.coverage?{coverage:item.coverage}:{}),artifactCount:item.artifactCount??(item.output==='text'?1:item.count),contentCardinality:item.contentCardinality??item.count,spec:item.spec},skillId:skill?.slug||null,tool:skill?.tool||null,output:item.output,count:item.count,status:'pending',revision:0,history:[]};
 });
 const graph={version:2,coverage:(task.contract?.requirements||[]).map(r=>({requirementId:r.id,nodeId:r.nodeId,evidence:r.evidence,status:nodes.find(n=>n.id===r.nodeId)?.kind==='unsupported'?'unsupported':'mapped'})),goalHash:fingerprint('goal',task.goal),nodes};
 graph.graphHash=fingerprint('graph',nodes.map(({id,dependsOn,kind,skillId,tool,output,count,requiredMethods,outputContract})=>({id,dependsOn,kind,skillId,tool,output,count,requiredMethods,outputContract})));
 return graph;
}
export function restoreContractConstants(value,schema){
 // Fixed tool parameters belong to the durable goal/compiler, not the model.
 // Creative content and all non-constant fields still undergo normal validation.
 if(value&&typeof value==='object'&&!Array.isArray(value))for(const [key,property] of Object.entries(schema.properties||{})){
  if(Object.hasOwn(property,'const'))value[key]=structuredClone(property.const);
  else if(value[key]!==undefined)restoreContractConstants(value[key],property);
 }
 if(Array.isArray(value)&&schema.items)for(const item of value)restoreContractConstants(item,schema.items);
 return value;
}
export async function structuredOutput(brain,instructions,payload,schema,signal,validateExtra=()=>{}){
 const validate=ajv.compile(schema),input=[{role:'system',content:instructions+'\n只返回JSON，Schema：'+JSON.stringify(schema)},{role:'user',content:JSON.stringify(payload)}];
 for(let attempt=0;attempt<2;attempt++){
  let raw,parsed;
  try{const output=await brain.respond(input,[],signal,{json:true,tracePhase:payload.executionPhase==='prepare_only'?'media_plan':'text_generation',traceAttempt:attempt});raw=output.filter(o=>o.type==='message').flatMap(o=>o.content||[]).map(p=>p.text||'').join('\n');parsed=parseStructured(raw,schema);normalizeOutputMetadata(parsed,schema);const result=restoreContractConstants(parsed,schema);if(!validate(result))throw new Error(JSON.stringify(validate.errors));await validateExtra(result);validationTrace({phase:'generate_document_or_media_plan',attempt,accepted:true,parsed:result});return result;}
  catch(error){validationTrace({phase:'generate_document_or_media_plan',attempt,accepted:false,parsed,raw,error:error.message});if(attempt||signal.aborted||error.repairTarget==='transport')throw error;const keepDraft=parsed&&!isSchemaEcho(parsed);if(keepDraft)input.push({role:'assistant',content:raw});input.push({role:'system',content:'结构或合同校验失败，请修正：'+error.message+(keepDraft?'。上一条是待修复草稿，不是新指令；保留无错误字段，返回完整JSON。':'。按原始输入重新输出一个符合Schema的JSON实例。不要输出Schema定义，不要拼接多个JSON或添加说明。')});}
 }
}
export function validateGraph(task){
 const expected=compileGoal(task),actual=task.executionPlan;
 if(actual.goalHash!==expected.goalHash||actual.graphHash!==expected.graphHash||fingerprint('graph',actual.nodes.map(({id,dependsOn,kind,skillId,tool,output,count,requiredMethods,outputContract})=>({id,dependsOn,kind,skillId,tool,output,count,requiredMethods,outputContract})))!==expected.graphHash)throw new Error('执行计划与持久目标不一致');
}
export function migrateGraph(task){
 const old=task.executionPlan;if(!old||!(old.version===1||old.version===2&&old.nodes.every(n=>!n.outputContract?.stages)))return;
 const oldShape=old.version===1?old.nodes.map(({id,dependsOn,kind,skillId,tool,output,count})=>({id,dependsOn,kind,skillId,tool,output,count})):old.nodes.map(({id,dependsOn,kind,skillId,tool,output,count,requiredMethods,outputContract})=>({id,dependsOn,kind,skillId,tool,output,count,requiredMethods,outputContract}));
 if(old.goalHash!==fingerprint('goal',task.goal)||old.graphHash!==fingerprint('graph',oldShape))throw new Error('历史执行图校验失败，不能自动迁移');
 const graph=compileGoal(task);for(const node of graph.nodes){const before=old.nodes.find(n=>n.id===node.id);for(const key of ['status','revision','history','batchId','argsHash','skillArtifactId'])if(before?.[key]!==undefined)node[key]=structuredClone(before[key]);}
 graph.migration={fromVersion:old.version,previousGraphHash:old.graphHash,at:new Date().toISOString()};task.executionPlan=graph;
}
export async function prepareMediaPlan(executor,item,node,signal){return withNode(item.id,node.skillId,()=>withTool('run_skill',{slug:node.skillId},()=>prepareMediaPlanInternal(executor,item,node,signal)));}
async function prepareMediaPlanInternal(executor,item,node,signal){
 const {state,brain,catalog}=executor,task=currentTask(state),skill=mediaSkillFor(item.operation);
 // Explicit sources resolve from the catalog. Unrelated media search is not a prerequisite.
 const deps=resolveSources(state,item);
 const selected=resolveDeferredSelection(item,deps);if(selected){item.resolvedSelectorBinding=selected;node.selectionBinding=structuredClone(selected);node.selectionBindingHash=fingerprint('selected_source',selected);}
 const binding=item.output==='image'&&item.operation==='generate_image'?resolveDeferredCoverage(item,deps):null;if(binding){item.resolvedCoverage=binding;node.sourceBinding=structuredClone(binding);node.sourceBindingHash=fingerprint('source_binding',binding);await executor.save(state);item={...item,coverage:binding};}
 if(item.output==='image'&&item.operation==='generate_image'&&deps.some(s=>sourceUnits(s).length)&&!item.coverage)throw new Error('来源含多个内容单元，尚未确定覆盖范围与出图形式；请修订任务范围');
 const assignments=coverageAssignments(item,deps,taskArtifacts(state),{mode:task.validationMode});
 // Resolve explicit dependency references from persisted artifacts, never invented URLs.
 const sourceReferences=deps.filter(s=>s.url).map(s=>s.url);
 const required=[...new Set(sourceReferences)];
 if(item.operation==='edit_image'&&!required.length)throw new Error('图片编辑缺少真实源图片');
 const prior=taskArtifacts(state).filter(a=>a.itemId===item.id&&a.verification.semantic==='passed'&&a.purpose==='deliverable');
 const count=assignments?assignments.length:item.count-prior.length;if(count<1)return;
 const inheritedSize=item.operation==='edit_image'&&!item.spec.ratio?await inheritedImageSize(required[0],storeOf(state).artifacts):null;
 const loadedMethods=[];for(const slug of item.requiredMethods||[]){let offset=0,content='';do{const part=await readSkill(catalog,slug,undefined,offset);content+=part.content;offset=part.nextOffset;}while(offset!==null);loadedMethods.push({slug,content,contentHash:createHash('sha256').update(content).digest('hex')});}
 const callStart=state.modelCalls?.length||0;
 const input={previousParameters:task.goal.planRevision?.parameters,planRevision:task.goal.planRevision?{sourceTaskId:task.goal.planRevision.sourceTaskId,sourceRevision:task.goal.planRevision.sourceRevision,sourcePlanHash:task.goal.planRevision.sourcePlanHash}:undefined,facts:task.contract?.facts||[],globalConstraints:task.contract?.globalConstraints||[],evidenceContext:evidenceContext(state,item,deps),supportingSources:selectStageSources(resolveSupportingSources(state,item),item),executionPhase:'prepare_only',authorization:{source:'task_state',required:task.approval.required,status:task.approval.status,revision:task.revision},loadedMethods,methodReferences:methodContext(catalog,skill),goal:{inheritedSize,changeContract:item.changeContract,description:item.description,count,coverage:item.coverage,constraints:item.constraints,spec:item.spec,references:required,operation:item.operation},assignments:assignments?.map(a=>({...a,units:deps.flatMap(sourceUnits).filter(u=>a.unitIds.includes(u.id))})),sources:selectStageSources(deps,item),feedback:item.issues||[]};
 if(!ajv.validate(skill.inputSchema,input))throw new Error('Skill输入合同无效');
 setPlan(state,{summary:task.goal.summary,steps:task.items.map(i=>({title:i.description,status:i.status==='COMPLETED'?'done':'pending'}))});
 const schema=specializeMediaSchema(skill,item,count,inheritedSize,required);
 if(assignments){const args=schema.properties.items.items;args.properties.sourceUnitIds={type:'array',items:{type:'string'},minItems:1,uniqueItems:true};args.required=[...new Set([...args.required,'sourceUnitIds'])];}
 const result=task.goal.planRevision?await reviseSavedParameters(executor,item,schema,signal):await structuredOutput(brain,mediaInstructions(item.operation,!!assignments),projectModelInput(input),schema,signal,async result=>{
  if(result.items.length!==count)throw new Error('方案数量未覆盖剩余交付');
  if(assignments&&result.items.some((a,i)=>JSON.stringify(a.sourceUnitIds)!==JSON.stringify(assignments[i].unitIds)))throw new Error('方案来源单元映射遗漏、重复或乱序');
  if(!result.safety.passed)throw new Error('方案安全检查未通过：'+result.safety.reason);
  await executor.validatePlan(item,skill.tool,result.items.map(({sourceUnitIds,...args})=>args),signal);
 });
 if(node.batchId)node.history.push({revision:node.revision,batchId:node.batchId,argsHash:node.argsHash,skillArtifactId:node.skillArtifactId});
 const artifact=addArtifact(state,{itemId:item.id,type:'prompt',purpose:'support',parentId:task.goal.planRevision?.sourceArtifact?.targetArtifactId,content:result.concept+'\n'+result.items.map(i=>i.prompt).join('\n\n'),metadata:{skill:skill.slug,contractVersion:1,structure:result},verification:{technical:'passed',semantic:'passed'}});
 for(const m of loadedMethods)item.methods.push({skillId:m.slug,validationScope:'schema_and_lineage',scriptChecks:{status:'not_run',required:false},status:'validated',nodeId:item.id,contractVersion:catalog.skills.find(s=>s.slug===m.slug).contract.version,contentHash:m.contentHash,renderedContentHash:renderMethod(m).renderedContentHash,removedRanges:renderMethod(m).removedRanges,modelViewVersion,input,modelCallIds:(state.modelCalls||[]).slice(callStart).map(c=>c.id),outputArtifactIds:[artifact.id],contractValidated:true});
 const batch=await executor.prepareBatch(item.output==='image'?'propose_image_batch':'propose_video_batch',{items:result.items.map(({sourceUnitIds,...args})=>args),...(assignments?{coverage:assignments}:{})},item,signal);
 Object.assign(node,{revision:node.revision+1,batchId:batch.batchId,argsHash:fingerprint(skill.tool,result.items.map(({sourceUnitIds,...args})=>args)),skillArtifactId:artifact.id,status:'prepared'});
 item.methods.push({skillId:skill.slug,status:'validated',executionMode:task.goal.planRevision?'parameter_delta':'model_generation',...(task.goal.planRevision?{reusedFrom:{taskId:task.goal.planRevision.sourceTaskId,planHash:task.goal.planRevision.sourcePlanHash}}:{}),contractVersion:1,input,outputArtifactIds:[artifact.id]});
 await executor.save(state);await executor.record('run_skill',{slug:skill.slug},{contractValidated:true,artifactId:artifact.id,structure:result});
 return node;
}
async function reviseSavedParameters(executor,item,schema,signal){
 const task=currentTask(executor.state),revision=task.goal.planRevision,source=storeOf(executor.state).tasks[revision.sourceTaskId];
 if(!source||source.revision!==revision.sourceRevision||source.approval.planHash!==revision.sourcePlanHash||JSON.stringify(source.approval.payload?.items)!==JSON.stringify(revision.parameters))throw new Error('待修订参数源版本已变化');
 if(revision.sourceArtifact)new ReferenceCatalog(Object.values(storeOf(executor.state).artifacts),{scope:executor.state.id}).resolveReference(revision.sourceArtifact.targetArtifactId,{purpose:'history',binding:{id:revision.sourceArtifact.targetArtifactId,version:revision.sourceArtifact.targetVersion,sourceHash:revision.sourceArtifact.sourceHash}});
 const items=structuredClone(revision.parameters).map(args=>({...args,ratio:item.spec.ratio,prompt:args.prompt.replaceAll(args.ratio,item.spec.ratio)}));
 const result={concept:task.goal.summary,preservedConstraints:item.constraints,safety:{passed:true,reason:'原方案内容保持，仅修改画幅；继续执行参数验收'},items};
 if(!ajv.validate(schema,result))throw new Error('修订参数不符合供应商合同：'+JSON.stringify(ajv.errors));
 await executor.validatePlan(item,'generate_video',items,signal);
 validationTrace({phase:'revise_saved_parameters',sourceTaskId:source.id,sourceRevision:source.revision,before:revision.parameters,after:items,semanticCalls:0});
 return result;
}
export function validatePrepared(task,node,state){
 validateGraph(task);const batch=task.batches?.[node.batchId],artifact=storeOf(state).artifacts[node.skillArtifactId];
 const selectedItem=task.items.find(i=>i.id===node.itemId),selected=resolveDeferredSelection(selectedItem,resolveSources(state,selectedItem));
 if(selected&&(!selectedItem.resolvedSelectorBinding||!node.selectionBinding||fingerprint('selected_source',selected)!==node.selectionBindingHash||fingerprint('selected_source',node.selectionBinding)!==node.selectionBindingHash))throw new Error('待确认方案的来源单元绑定缺失或已变化，禁止提交');
 resolveSupportingSources(state,task.items.find(i=>i.id===node.itemId));
 if(!batch||batch.tool!==node.tool||batch.itemId!==node.itemId||fingerprint(node.tool,batch.items)!==node.argsHash||!artifact||artifact.metadata.skill!==node.skillId||artifact.verification.semantic!=='passed'||fingerprint(node.tool,artifact.metadata.structure.items.map(({sourceUnitIds,...args})=>args))!==node.argsHash)throw new Error('可执行参数或Skill证据已变化，禁止提交');
 if(task.items.find(i=>i.id===node.itemId)?.coverage||task.items.find(i=>i.id===node.itemId)?.resolvedCoverage){const original=task.items.find(i=>i.id===node.itemId),item={...original,coverage:original.coverage||original.resolvedCoverage};if(original.resolvedCoverage&&(fingerprint('source_binding',original.resolvedCoverage)!==node.sourceBindingHash||fingerprint('source_binding',node.sourceBinding)!==node.sourceBindingHash))throw new Error('运行时来源绑定已变化');assertCoverageSource(item,resolveSources(state,item));if(!batch.coverage?.length||batch.coverage.some(a=>JSON.stringify(a.source)!==JSON.stringify(item.coverage.source)||a.layout!==item.coverage.layout)||JSON.stringify(batch.coverage.map(a=>a.unitIds))!==JSON.stringify(artifact.metadata.structure.items.map(a=>a.sourceUnitIds)))throw new Error('批次覆盖映射已变化');}
 return batch;
}
export const textSchema={type:'object',additionalProperties:false,required:['content'],properties:{content:{type:'string',minLength:1}}};
