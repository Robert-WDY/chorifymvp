import {selectIntakeDocuments,assertIntakePointers} from './intake-context.mjs';
import {renderStage} from './text-stage.mjs';
import {repairInput,skillDirectoryEntry} from './model-context.mjs';
import {intakeCore,fieldRepairPrompt,referenceRepairPrompt,formatRepairPrompt} from './prompt-text.mjs';
import {readFileSync} from 'node:fs';
import {revisionDeltaSchema,revisionTarget,discardImageDirectionSelector,applyPlanDelta,operationInputSchema,projectOperationCandidate,turnOperationSchema,normalizeTurnOperation,inspectionGoal,scopedSpecification,normalizeConsumedStages} from './turn-operation.mjs';
import {expandChangeSets,relatedCurrentDocuments} from './change-set.mjs';
import {isPresentation,querySchema} from './query-registry.mjs';
import {selectorSchema,ReferenceCatalog,referenceInventory} from './reference-catalog.mjs';
import {sourceUnits,coverageSelectionSchema,bindCoverage} from './source-coverage.mjs';
import {conversationContext,resolveMessage} from './conversation-query.mjs';
import {resolvePresentationReference} from './presentation-reference.mjs';
import {assertMaterialReferenceTypes} from './material-reference-contract.mjs';
import {normalizeMethodPlan,planSpecs,ensureMethodDefaults,inheritMediaObligations,discardInheritanceForNewTask} from './planning-boundary.mjs';
import {normalizeSemanticMetadata} from './structured-codec.mjs';
import {missingFieldPlan,applyMissingFields,semanticFieldPlan,repairComparisonDraft} from './structured-repair.mjs';
import {intentSnapshot,assertIntentPreserved} from './intent-snapshot.mjs';
import {captureIntentSnapshot} from './trace-context.mjs';
import {validationTrace} from './trace-context.mjs';
import {normalizeSchemaKeys,parseStructured,relevantSchemaErrors,isSchemaEcho} from './structured-codec.mjs';
import {canonicalReferences,usableReferences,resolveTaskReferenceAliases} from './sources.mjs';
import {reconcileFixedSpec} from './fixed-spec.mjs';
import {reconcileContinuation} from './task-control.mjs';
import {compactIntakePayload,intakeSnapshot,videoDefaults} from './model-context.mjs';
import {evidenceSpansSchema,bindRequestEvidence,requestMessageId} from './request-input.mjs';
import {activationSchema,authorizationSchema,applyStages,isDeferred,globalBlockingGaps} from './stage-contract.mjs';
import Ajv from 'ajv';
import {compactPromptSchema} from './prompt-schema.mjs';
import {actionModes,actionInstructions,actionEnabled,businessRequestSchema} from './action-registry.mjs';
import {projectBusinessActions,validateBusinessActions,assertBusinessPreserved,actionReceipt} from './business-action.mjs';
import {buildActionContext} from './action-context.mjs';
const text={type:'string',maxLength:1600};
const strings={type:'array',items:text,maxItems:20};
const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,required,properties});
const safety=object({disposition:{enum:['allow','refuse','partial']},untrustedInstructions:{type:'boolean'},reason:{...text,default:''}});
const evidence={enum:['none','image','video','web','task','runtime']};
export const semanticSchema=object({summary:{...text,minLength:1},deliverables:{type:'array',maxItems:12,items:object({
 description:{...text,minLength:1},kind:{enum:['text','image','video','audio']},count:{type:'integer',minimum:1,maximum:1000},action:{enum:['create','modify','inspect','respond','query','present','retain']},purpose:{enum:['general','marketing','prompt','storyboard','risk_review']},requiredEvidence:evidence,references:strings,dependsOn:{type:'array',items:{type:'integer',minimum:0}},constraints:strings,requestEvidence:text
})},gaps:{type:'array',maxItems:12,items:object({description:text,level:{enum:['blocking','preference','factual']},resolution:text})},assumptions:strings,deferred:strings,safety});

semanticSchema.properties.turnOperation=turnOperationSchema;
semanticSchema.properties.executionAuthorization=authorizationSchema;
semanticSchema.properties.reviewIntent={type:'object'};
semanticSchema.properties.speakerRole={type:'string'};
semanticSchema.properties.targetAudience={type:'string'};
semanticSchema.properties.deliverables.items.properties.activation=activationSchema;
semanticSchema.properties.deliverables.items.properties.countDeclared={type:'boolean'};
semanticSchema.properties.gaps.items.properties.scope={enum:['global','deliverables']};
semanticSchema.properties.gaps.items.properties.affectedDeliverables={type:'array',minItems:1,uniqueItems:true,items:{type:'integer',minimum:0}};
semanticSchema.properties.revisionDelta=revisionDeltaSchema;
semanticSchema.properties.executionMode={enum:['parameter_delta','creative_revision']};
semanticSchema.properties.deliverables.items.properties.selector=selectorSchema;
semanticSchema.properties.deliverables.items.properties.requestEvidenceSpans=evidenceSpansSchema;
semanticSchema.properties.deliverables.items.properties.evidenceSegments={type:'array',items:{type:'object'}};
Object.assign(semanticSchema.properties.deliverables.items.properties,{businessOperation:{enum:['modify','translate','create']},resultRelation:{enum:['revision_of','derived_from']},changeContract:{type:'object'},selectionRole:{enum:['consumer','producer','upstream']},supportingSources:strings});
Object.assign(semanticSchema.properties.deliverables.items.properties,{query:querySchema,runtimeQuery:{type:'object'},preservedSpec:{type:'object'},selectorBinding:{type:'object'}});
const specification=object({directionCount:{type:'integer',minimum:1},shotCount:{type:'integer',minimum:1},secondsPerShot:{type:'number',minimum:0},selectedDirectionIndex:{type:'integer',minimum:1},durationSeconds:{type:'number',minimum:1},ratio:{type:'string'},exactTexts:strings},[]);
semanticSchema.properties.deliverables.items.properties.spec=specification;
semanticSchema.properties.deliverables.items.properties.form={enum:['answer','copy','title','prompt','script','directions','analysis','review','composite']};
semanticSchema.properties.deliverables.items.properties.executionShape={enum:['direct','workflow']};
semanticSchema.properties.deliverables.items.properties.observationEvidence=text;
semanticSchema.properties.deliverables.items.properties.optionalEvidence=evidence;
semanticSchema.properties.deliverables.items.properties.specOrigins={type:'object',additionalProperties:{type:'object'}};

semanticSchema.properties.deliverables.items.properties.sourceSelection=coverageSelectionSchema;
for(const k of ['referenceBindings','supportingSourceBindings','coverage'])semanticSchema.properties.deliverables.items.properties[k]=k==='coverage'?{type:'object'}:{type:'array',items:{type:'object'}};
semanticSchema.properties.spec=specification;
semanticSchema.properties.gaps.items.properties.kind={enum:['user_input','capability','runtime_fact','product_fact','preference']};
semanticSchema.properties.deliverables.items.properties.requiredMethods=strings;
semanticSchema.properties.deliverables.items.properties.queryTaskIds=strings;
semanticSchema.properties.facts=strings;
semanticSchema.properties.requiredMethods=strings;
semanticSchema.properties.globalConstraints=strings;
semanticSchema.properties.deliverables.items.properties.artifactCount={type:'integer',minimum:1};
semanticSchema.properties.deliverables.items.properties.contentCardinality={type:'integer',minimum:1};
semanticSchema.properties.approval=object({required:{type:'boolean'},reason:text});
semanticSchema.properties.continuation=object({mode:{enum:['new','continue','approve','revise','clarify','cancel']},taskId:text});
// Metadata checks the model-selected plan; no matching of user-query words occurs here.
export const capabilities={
 present:{output:'reference',evidence:'runtime',description:'展示或保留已有对象，只产生读取回执，不创建产物'},
 inspect_runtime:{output:'text',evidence:'none',description:'一次只读回答需要组合多个系统事实：工具、参数、Skill、报价、任务记录；不提交生成'},
 inspect_capabilities:{output:'text',evidence:'none',description:'只读查询当前工具、Skill、参数Schema与能力边界，依据运行时注册表'},
 inspect_quote:{output:'text',evidence:'none',description:'只读查询实际报价及收费授权，依据报价来源；缺失时如实说明'},
 answer:{output:'text',evidence:'none',description:'不依赖外部材料观察的普通解释、闲聊或回答'},
 rewrite:{output:'text',evidence:'none',description:'撰写/改写提示词、润色、翻译、压缩已有文字'},
 marketing_script:{output:'text',evidence:'none',description:'创作广告文案、品牌故事、标题或口播稿'},
 storyboard:{output:'text',evidence:'none',description:'交付镜头脚本/分镜表文字'},
 review_content:{output:'text',evidence:'none',description:'检查给定内容的风险、合规性或攻击性并解释结论'},
 generate_image:{output:'image',evidence:'none',description:'生成实际图片/海报/漫画，包括整版多格画面'},
 edit_image:{output:'image',evidence:'none',description:'以现有图片为输入修改画面'},
 generate_video:{output:'video',evidence:'none',description:'生成实际视频/动画，支持参考图'},
 edit_video:{output:'video',evidence:'none',description:'修改已有视频；具体编辑功能可用性由执行器确认'},
 analyze_image:{output:'text',evidence:'image',description:'实际读取图片后描述/分析画面'},
 read_video:{output:'text',evidence:'video',description:'实际读取视频并给内容摘要或文字结构拆解'},
 analyze_video:{output:'text',evidence:'video',description:'专业广告视频营销结构、镜头、表现力分析'},
 voiceover:{output:'audio',evidence:'none',description:'把文本合成为默认或指定音色的配音成品'},
 clone_voice:{output:'audio',evidence:'none',description:'参考音频音色朗读新文字，直接输出音频，不需要再配音'},
 lipsync:{output:'video',evidence:'none',description:'将已有音频与人物视频做口型同步'},
 slice_video:{output:'video',evidence:'none',description:'按场景切割实际视频文件，返回视频片段'},
 upscale_video:{output:'video',evidence:'none',description:'提升视频清晰度'},
 replicate_video:{output:'video',evidence:'none',description:'用参考视频和产品图片制作产品复刻广告'},
 merge_videos:{output:'video',evidence:'none',description:'按指定顺序合并多段视频'},
 search_web:{output:'text',evidence:'web',description:'实时联网检索并给可核验来源'},
 query_task:{output:'text',evidence:'task',description:'查询已提交的生成/处理任务状态，不重新生成'}
};
export const operations=Object.keys(capabilities);
export const intentSchema=object({summary:{...text,minLength:1},mode:{enum:['answer','create','edit','analyze','review','rewrite','continue','mixed']},tasks:{type:'array',maxItems:12,items:object({operation:{enum:operations},output:{enum:['text','image','video','audio']},count:{type:'integer',minimum:1,maximum:1000},dependsOn:{type:'array',items:{type:'integer',minimum:0}},references:strings,constraints:strings,requiredEvidence:evidence},['operation','output','count','dependsOn','references','constraints'])},skills:strings,assumptions:strings,missingInputs:strings,needsClarification:{type:'boolean'},safety});
intentSchema.properties.tasks.items.properties.spec=specification;
for(const k of ['activation','requestEvidenceSpans','evidenceSegments','form','executionShape','specOrigins','sourceSelection','referenceBindings','supportingSourceBindings','coverage','businessOperation','resultRelation','changeContract','selectionRole','supportingSources','runtimeQuery','preservedSpec','selectorBinding','selector'])intentSchema.properties.tasks.items.properties[k]=semanticSchema.properties.deliverables.items.properties[k];
intentSchema.properties.tasks.items.properties.requiredMethods=strings;
intentSchema.properties.tasks.items.properties.queryTaskIds=strings;
intentSchema.properties.tasks.items.properties.artifactCount={type:'integer',minimum:1};
intentSchema.properties.tasks.items.properties.contentCardinality={type:'integer',minimum:1};
const planSchema=object({routes:{type:'array',maxItems:12,items:object({deliverableIndex:{type:'integer',minimum:0},operation:{enum:operations},skills:strings})}});
// An omitted explanatory string is not a missing safety decision. Never default disposition or gaps.
const ajv=new Ajv({strict:false,useDefaults:true});
const validators=new Map([semanticSchema,intentSchema,planSchema].map(s=>[s,ajv.compile(s)]));
function check(schema,value){if(schema.properties?.deliverables)normalizeSemanticMetadata(value);const changes=normalizeSchemaKeys(value,schema);if(changes.length)validationTrace({normalizations:changes});const validate=validators.get(schema)||ajv.compile(schema);if(!validate(value))throw Object.assign(new Error('结构化格式错误：'+relevantSchemaErrors(schema,value,validate.errors).map(e=>(e.instancePath||'/')+' '+e.message+' '+JSON.stringify(e.params)).join('; ')),{code:validate.errors.every(e=>e.keyword==='required')?'missing_fields':'invalid_schema'});return value;}

const suppliedExamples=JSON.parse(readFileSync(new URL('./intake-examples.json',import.meta.url),'utf8'));
export function intakeInstructions({nativeMode=false,actionMode='shadow'}={}){
 const paths=nativeMode?{references:'relevantEvidence.references',task:'activeTaskState',conversation:'relevantEvidence.conversation'}:{references:'referenceCatalog.entries',task:'taskSnapshot',conversation:'conversation'};
 return [intakeCore,
 '输入路径：候选在'+paths.references+'；选定方案读取'+paths.task+'.revisionTarget；消息证据在'+paths.conversation+'。执行焦点不是用户选定对象。',
 '请求合同：turnOperation是唯一操作选择，不填写continuation/businessOperation/resultRelation。answer/summarize/explain/inspect/present为读取；纯present可只有presentation.targets与空deliverables，消息目标为{type:"message",messageId}，产物目标为{type:"artifact",artifactId,version}。纯approve/resume/cancel及revise_plan的deliverables为空。revise_plan只填写目标任务和revisionDelta.changes的field/to，旧版本、from与未改参数由程序读取；modify须有changeContract.change/preserve，scope仅在用户要求相关文档同步时为related_current。query与answerContract按当前Schema填写，数量问题区分task/session范围。内容选择用sourceSelection或selector中的一种；不要重复填写selectedDirectionIndex。图片编辑目标在references，选定方向/镜头可以来自supportingSources，不能把文字来源当图片。已有来源的sourceSelection绑定真实unitIds和layout。本轮未来来源使用source:"task:N"并声明同一上游的references及dependsOn；选择具体方向/镜头/产品用unitType与从1开始的unitIndexes，mode:"selected"；不要填写未来unitIds、产物版本或再次生产上游。媒体layout仍明确出图形式。媒体参考不另建观察义务，requiredEvidence仅表达文字所需观察。',
 '以下仅为格式示例，不是当前事实、来源或授权：',JSON.stringify(intakeExamples({nativeMode,actionMode}))].join('\n\n');
}
export function intakeExamples({nativeMode=false,actionMode='shadow'}={}){
 return structuredClone(suppliedExamples);
}
export function intentPrompt({wireSchema=operationInputSchema(semanticSchema),nativeMode=false,actionMode='shadow'}={}){return intakeInstructions({nativeMode,actionMode})+'\n只返回JSON，当前wire Schema：'+JSON.stringify(compactPromptSchema(wireSchema));}

export function validateIntent(value,catalog){check(intentSchema,value);if(value.skills.some(s=>!catalog.skills.some(x=>x.slug===s)))throw new Error('目标引用不存在的技能');value.tasks.forEach((t,i)=>{if(t.dependsOn.some(d=>d>=i))throw new Error('任务依赖必须指向前序任务');});if(value.safety.disposition==='refuse'&&value.tasks.length)throw new Error('拒绝目标不能带执行任务');if(value.needsClarification&&!value.missingInputs.length)throw new Error('澄清缺少问题');if(!value.tasks.length&&value.safety.disposition!=='refuse'&&!value.needsClarification)throw new Error('缺少用户任务');return value;}
function resumesExisting(value,snapshot){return !!snapshot?.id&&snapshot.status!=='NEEDS_INPUT'&&value.continuation?.taskId===snapshot.id&&['continue','approve'].includes(value.continuation.mode)&&value.safety.disposition==='allow'&&!value.gaps.some(g=>g.level==='blocking');}
export function validateSemantic(value,{taskSnapshot}={}){check(semanticSchema,value);value.deliverables.forEach((d,i)=>{if(d.kind!=='text'&&d.requiredEvidence!=='none')throw Object.assign(new Error('媒体交付的requiredEvidence必须为none；图片/视频参考素材保留在references，由媒体执行器处理，不另建文字观察义务'),{issues:[{path:'/deliverables/'+i+'/requiredEvidence'}]});if(d.dependsOn.some(n=>n>=i))throw new Error('依赖必须指向前序交付');for(const ref of [...(d.references||[]),...(d.supportingSources||[])])if(/^task:\d+$/.test(ref)&&!d.dependsOn.includes(Number(ref.slice(5))))throw Object.assign(new Error('task:N使用从0开始的前序交付索引，必须声明相同dependsOn；不能引用自身或将第三项写成task:3'),{discardDraft:true});});if(value.safety.disposition==='refuse'&&value.deliverables.length)throw new Error('拒绝请求不能含可执行交付');if(value.turnOperation?.kind==='consume'&&!value.deliverables.length)throw Object.assign(new Error('消费没有新生产目标：若仅保留并展示已有成果，用present和presentation.targets绑定待展示对象，不新增交付'),{code:'operation_selection',issues:[{path:'/turnOperation/kind'},{path:'/turnOperation/presentation'}]});if(value.safety.disposition!=='refuse'&&!['answer','summarize','explain','inspect','present','retain'].includes(value.turnOperation?.kind)&&!value.deliverables.length&&!value.gaps.some(g=>g.level==='blocking')&&!['continue','approve','cancel'].includes(value.continuation?.mode))throw new Error('缺少交付目标或必要澄清');for(const [i,d] of value.deliverables.entries()){
 if(!['image','video','audio'].includes(d.kind)||!['create','modify'].includes(d.action))continue;
 const duplicate=value.deliverables.slice(0,i).find(p=>p.kind===d.kind&&p.action===d.action&&p.description===d.description&&p.requestEvidence&&p.requestEvidence===d.requestEvidence&&JSON.stringify(p.references)===JSON.stringify(d.references)&&JSON.stringify(p.spec||{})===JSON.stringify(d.spec||{}));
 if(duplicate)throw Object.assign(new Error('多个生产项使用同一目标、来源、规格和原文依据，无法证明是独立新增义务；局部修复重复项或给出各项独立依据，不能把方案当作另一件媒体'),{code:'conflicting_effects'});
}return value;}
export function validatePlan(plan,semantic,catalog){
 check(planSchema,plan);
 // Multiple read-only observations can support one text slot. Coalesce their
 // sources rather than expanding the delivery or dropping a requested fact.
 const groups=new Map();for(const r of plan.routes){const group=groups.get(r.deliverableIndex)||[];group.push(r);groups.set(r.deliverableIndex,group);}
 plan={routes:[...groups.values()].flatMap(group=>group.length>1&&group.every(r=>['inspect_runtime','inspect_capabilities','inspect_quote','query_task'].includes(r.operation)&&!r.skills.length)?[{deliverableIndex:group[0].deliverableIndex,operation:'inspect_runtime',skills:[]}]:group)};
 if(plan.routes.length!==semantic.deliverables.length)throw new Error('能力选择必须覆盖全部交付且不得增加交付');
 plan.routes=plan.routes.map(r=>semantic.deliverables[r.deliverableIndex]?.runtimeQuery?.type==='presentation'?{...r,operation:'present',skills:[]}:r);
 plan.routes=plan.routes.map(r=>semantic.deliverables[r.deliverableIndex]?normalizeMethodPlan(r,{...semantic.deliverables[r.deliverableIndex],requiredMethods:[...new Set([...(semantic.deliverables[r.deliverableIndex].requiredMethods||[]),...(semantic.requiredMethods||[]).filter(slug=>r.skills.includes(slug))])]},catalog):r);
 const ids=new Set();
 for(const r of plan.routes){
  const d=semantic.deliverables[r.deliverableIndex],c=capabilities[r.operation];
  if(!d||ids.has(r.deliverableIndex))throw new Error('交付索引重复或无效');
  ids.add(r.deliverableIndex);
  if(d.kind==='text'&&['create','modify'].includes(d.action)&&['script','copy','title','prompt','composite'].includes(d.form)&&['search_web','analyze_image','read_video'].includes(r.operation))throw new Error('素材观察只能作为前置节点，不能取代用户要求的文字创作交付');
  if(d.kind==='text'&&d.action==='modify'&&r.operation==='marketing_script')throw new Error('文字修改动作必须保留为rewrite');
  if(c.output!==d.kind&&!(r.operation==='present'&&d.runtimeQuery?.type==='presentation'))throw new Error('能力改变了用户的交付媒介');
  if(d.kind==='image'&&d.action==='modify'&&r.operation!=='edit_image')throw new Error('图片修改动作必须保留为edit_image');
  // A media processor observes its own input; it does not need a separate analysis call.
  if(d.kind==='text'&&d.requiredEvidence!=='none'&&c.evidence!==d.requiredEvidence&&!professionalOperations.has(r.operation)&&!(['present','inspect_runtime','inspect_capabilities','inspect_quote','query_task'].includes(r.operation)&&['runtime','task'].includes(d.requiredEvidence)))throw new Error('能力不能提供所需素材观察证据');
  if(d.purpose==='risk_review'&&d.requiredEvidence==='none'&&r.operation==='answer')throw new Error('风险检查不能降成普通回答');
  if((d.requiredMethods||[]).some(slug=>!r.skills.includes(slug)))throw new Error('能力路由丢失本节点必需方法');
  if(r.skills.some(s=>!catalog.skills.some(x=>x.slug===s)))throw new Error('Skill不存在');
 }
 return plan;
}
async function structured(brain,prompt,payload,validate,signal,trace,phase,repairSchema,boundary={}){
 const input=[{role:'system',content:prompt},{role:'user',content:JSON.stringify(payload)}];let patchPlan=null,lockedDraft=null,referenceRepair=null,snapshot=null,initialFailure=null,lastFailure=null;
 const preserve=phase==='understand'||phase==='repair_goal_contract'||phase==='repair_turn_operation';
 for(let attempt=0;attempt<3;attempt++){
  const started=Date.now(),sentRequest=JSON.stringify(input);let raw,parsed,received;
  try{
   const output=await brain.respond(input,[],signal,{json:true,tracePhase:phase,traceAttempt:attempt});
   raw=output.filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n');
   parsed=parseStructured(raw,referenceRepair?.schema||patchPlan?.schema||repairSchema);received=structuredClone(parsed);if(referenceRepair){const valid=ajv.compile(referenceRepair.schema);if(!valid(parsed))throw new Error('引用修复只能返回指定字段的候选句柄');const patch=parsed;parsed=structuredClone(lockedDraft);for(const index of referenceRepair.indices)parsed.deliverables[index][referenceRepair.field||'references']=patch[String(index)];validationTrace({phase:'repair_references',patch,lockedFieldsPreserved:true});}if(patchPlan){const patch=parsed;parsed=applyMissingFields(lockedDraft,patch,patchPlan);validationTrace({phase:'fill_missing_fields',patch,paths:patchPlan.paths,merged:parsed});}
   // Field repair is narrow, but an unaccepted interpretation is not a contract.
   if(preserve&&patchPlan){
    const comparison=repairComparisonDraft(lockedDraft,parsed,patchPlan);
    if(Array.isArray(comparison?.businessActions))assertBusinessPreserved(comparison,parsed);
    let previous;try{previous=boundary.project?boundary.project(comparison):comparison;}catch{}
    if(previous?.deliverables)assertIntentPreserved(intentSnapshot(payload.query,previous),boundary.project?boundary.project(parsed):parsed);
   }
   if(preserve){
    let diagnostic;try{diagnostic=boundary.project?boundary.project(parsed):parsed;}catch{}
    if(diagnostic?.deliverables){snapshot=intentSnapshot(payload.query,diagnostic,{origin:'unaccepted_draft'});await captureIntentSnapshot(snapshot);}
   }
   lockedDraft=structuredClone(parsed);patchPlan=null;referenceRepair=null;
   boundary.shape?.(structuredClone(parsed));
   const result=validate(structuredClone(parsed));boundary.preflight?.(structuredClone(result));
   if(preserve)trace.acceptedSemantic=structuredClone(result);if(Array.isArray(parsed?.businessActions))trace.businessActionRequest=structuredClone(parsed);
   validationTrace({phase,attempt,parsed:result,accepted:true,acceptanceScope:preserve?(boundary.preflight?'candidate_preflight':'draft_validation'):'phase_validation'});trace.push({phase,attempt,durationMs:Date.now()-started,ok:true});return result;
  }catch(error){
   error.intakeStage??=!parsed||['invalid_schema','missing_fields'].includes(error.code)?'structure':['reference_selection','reference_unavailable','reference_type','material_reference_type','reference_contract','source_changed','evidence_binding'].includes(error.code)?'reference':error.code==='stage_contract'?'stage':error.code==='authorization_conflict'?'authorization':'understanding';
   validationTrace({phase,attempt,parsed,rejectedDraft:raw,accepted:false,failureStage:error.intakeStage,error:error.message});trace.push({phase,attempt,durationMs:Date.now()-started,ok:false,failureStage:error.intakeStage,error:error.message});
   if(isSchemaEcho(parsed)){parsed=null;lockedDraft=null;}else lockedDraft??=parsed;initialFailure??=error.message;const stop=()=>{if(initialFailure!==error.message)error.message='原始校验失败：'+initialFailure+'；最后补丁错误：'+error.message;error.intakeTrace=trace;error.intentSnapshot=snapshot;error.partialSemantic=lockedDraft||undefined;throw error;};
   if(attempt===2||signal.aborted||error.repairTarget==='transport')stop();
   const failure=JSON.stringify([received??raw,error.code,error.message]);const retry=()=>{if(boundary.stopOnNoProgress!==false&&lastFailure===failure&&sentRequest===JSON.stringify(input)){error.repairStopReason='no_progress';validationTrace({phase:'repair_no_progress',accepted:false,error:error.message});stop();}lastFailure=failure;};
   // Invalid patches stay patches: never reinterpret their object as a new plan.
   if(patchPlan||referenceRepair){const view=JSON.parse(input[1].content);view.error=error.message;view.rejectedPatch=received??raw;input[1].content=JSON.stringify(view);input.splice(2);retry();continue;}
   if(error.code==='reference_selection'&&error.repair&&Array.isArray(parsed?.deliverables)){
    lockedDraft=structuredClone(parsed);referenceRepair=error.repair;input.splice(0,input.length,{role:'system',content:referenceRepairPrompt+'\n辅助来源只引用实际资料ID，本轮补充事实不冒充资料ID。\nSchema：'+JSON.stringify(referenceRepair.schema)},{role:'user',content:JSON.stringify(repairInput(boundary.repairPayload?.()||payload,lockedDraft,referenceRepair,{reference:true,error:error.message}))});retry();continue;
   }
   const activeSchema=boundary.schemaFor?.(lockedDraft)||repairSchema;
   if(preserve&&(patchPlan=missingFieldPlan(lockedDraft,activeSchema)||(error.code!=='business_action'?semanticFieldPlan(lockedDraft,activeSchema,error.repairIssues||error.issues):null))){
    input.splice(0,input.length,{role:'system',content:fieldRepairPrompt+'\nremovePaths中的字段返回null。输出Schema：'+JSON.stringify(patchPlan.schema)},{role:'user',content:JSON.stringify(repairInput(boundary.repairPayload?.()||payload,lockedDraft,patchPlan,{error:error.message}))});
    retry();continue;
   }
   if(preserve&&(lockedDraft?.deliverables||lockedDraft?.businessActions)){
    validationTrace({phase:'draft_reinterpretation',accepted:false,attempt,error:error.message,originalQuery:payload.query,reason:'未接受草稿允许纠正语义；原始用户证据不变'});
    input.splice(0,input.length,{role:'system',content:prompt+'\n上一草稿尚未接受。根据原始需求和实际候选纠正动作、对象、来源或阶段；不能把系统错误归因用户素材失效。保持用户全部真实义务，缺少必要信息时只声明对应缺口。反馈：'+error.message},{role:'user',content:JSON.stringify({...payload,rejectedDraft:lockedDraft})});
    lockedDraft=null;retry();continue;
   }
   const keepDraft=parsed&&!error.discardDraft&&!isSchemaEcho(parsed);
   input.splice(0,input.length,{role:'system',content:prompt},{role:'system',content:formatRepairPrompt+'\n反馈：'+error.message},...(keepDraft?[{role:'assistant',content:raw}]:[]),{role:'user',content:JSON.stringify(payload)});retry();
  }
 }
}
function bindReadSources(semantic,references,messages){
 const messageIds=new Set(messages.map(m=>m.messageId));
 const sourceRefs=[...new Set(semantic.deliverables.flatMap(d=>[...(d.references||[]),...(d.supportingSources||[])]))];
 semantic.readMessageBindings=sourceRefs.filter(ref=>messageIds.has(ref)).map(ref=>resolveMessage(messages,{messageId:ref}));
 for(const [index,d] of semantic.deliverables.entries())for(const field of ['references','supportingSources']){
  for(const ref of references.expand(d[field]||[])){if(messageIds.has(ref))continue;try{references.bind(ref,{purpose:'history'});}catch(error){
   if(error.code==='reference_selection'){
    const candidates=references.view('history');if(candidates.length||field==='supportingSources')error.repair={indices:[index],field,candidates,schema:{type:'object',additionalProperties:false,required:[String(index)],properties:{[String(index)]:{type:'array',items:candidates.length?{enum:candidates.map(e=>e.handle)}:{not:{}},minItems:field==='supportingSources'?0:1,maxItems:20}}}};
   }throw error;
  }}
 }
 semantic.readSourceBindings=references.expand(sourceRefs.filter(ref=>!messageIds.has(ref))).map(ref=>({...references.bind(ref,{purpose:'history'}),handle:ref}));
}
export async function understandGoal(brain,catalog,options,signal){
 const mode=options.actionMode||'shadow';if(!actionModes.includes(mode))throw new Error('未知 Business Action 迁移模式');
 const goal=await understandContractGoal(brain,catalog,options,signal);
 if(!goal.resumeTaskId&&!goal.cancelTaskId){goal.intentSnapshot=intentSnapshot(options.query,goal.intakeTrace?.acceptedSemantic||goal.semantic);await captureIntentSnapshot(goal.intentSnapshot);}
 if(goal.intakeTrace)delete goal.intakeTrace.acceptedSemantic;
 goal.businessAction=actionReceipt(goal,goal.intakeTrace?.businessActionRequest,mode);if(goal.intakeTrace)delete goal.intakeTrace.businessActionRequest;
 validationTrace({phase:'business_action_compilation',accepted:true,receipt:goal.businessAction});return goal;
}
async function understandContractGoal(brain,catalog,{query,history=[],assets=[],taskSnapshot=null,strictControl=false,auditContracts=false,runtimeFacts=null,taskCandidates=[],sessionId='',runId='',messages=[],replyTo=null,recentTurns=[],legacyReplay=false,actionMode='shadow',userMemory=[],currentMessage=null},signal){
 currentMessage??={messageId:requestMessageId(query,sessionId,runId),role:'user',content:query};
 const references=new ReferenceCatalog(referenceInventory({taskCandidates,taskSnapshot,assets}),{scope:sessionId,epoch:runId});
 const trace=[],payload={query,currentMessageId:currentMessage.messageId,conversation:conversationContext(messages.length?messages:history,recentTurns,{replyTo,query}),replyTo,assets,referenceCatalog:{version:references.version,views:{imageTargets:references.view('image_target'),production:references.view('production'),readableSupport:references.view('history').filter(e=>!e.productionUsable)},entries:references.entries.filter(e=>e.readable).map(e=>({...e,units:sourceUnits(references.select(e.id,{purpose:'history'}).source)}))},sourceDocuments:references.entries.filter(e=>e.readable&&e.purpose!=='request'&&['text','prompt'].includes(e.type)&&references.select(e.id,{purpose:'history'}).source.publication!=='superseded').map(e=>{const a=references.select(e.id,{purpose:'history'}).source;return {id:e.handle,artifactId:e.id,version:e.version,content:a.content,structure:a.metadata?.structure||a.structure};}),skillDirectory:catalog.skills.map(skillDirectoryEntry),taskIndex:taskCandidates.map(t=>({id:t.id,revision:t.revision,status:t.status,revisionTarget:revisionTarget(t),facts:t.goal?.semantic?.facts||[],globalConstraints:t.goal?.semantic?.globalConstraints||[],originalQuery:t.query,completionStatus:t.completionStatus,requirements:t.requirements,summary:t.goal?.summary,artifacts:(t.artifacts||[]).filter(a=>a.purpose==='deliverable'&&['passed','simulated_passed'].includes(a.verification?.semantic)).map(a=>({id:a.id,type:a.type,version:a.version,excerpt:a.content?.slice(0,120)}))})),taskSnapshot:intakeSnapshot(taskSnapshot),executionDefaults:{video:videoDefaults}};
 const viewPayload=structuredClone(payload);viewPayload.sourceDocuments=selectIntakeDocuments(viewPayload);compactIntakePayload(viewPayload,renderStage);
 const actionSchema=businessRequestSchema(semanticSchema.properties.safety,semanticSchema.properties.gaps),nativeMode=actionMode!=='shadow'&&!legacyReplay;
 const legacyInput=operationInputSchema(semanticSchema),wireSchema=legacyInput; // One model-visible protocol; historical action responses retain their explicit compatibility validator.
 const prompt=intentPrompt({wireSchema,nativeMode,actionMode});
 const inputPayload=assertIntakePointers(nativeMode?buildActionContext(viewPayload,{userMemory}):viewPayload);
 let gateDecision=null,acceptedActionRequest=null;
 const validateEntry=s=>{
  if(Array.isArray(s?.businessActions)){
   if(!nativeMode)throw new Error('当前为影子迁移，仍执行兼容合同');
   check(actionSchema,s);validateBusinessActions(s,{references,taskCandidates,query,mode:actionMode});
   acceptedActionRequest=structuredClone(s);s=projectBusinessActions(s);
  }
  // Discard only a typed-inapplicable legacy selector, never infer a direction from image ordinal.
  for(const d of s.deliverables||[])if(d.kind==='image'&&d.action==='modify'&&d.spec?.selectedDirectionIndex!==undefined&&d.references?.length){
   const targets=d.references.map(r=>references.resolveReference(r,{purpose:'history',required:false}));
   if(targets.every(r=>r.entry?.type==='image'))discardImageDirectionSelector(d);
  }
  if(!legacyReplay)check(operationInputSchema(semanticSchema),s);
  s=projectOperationCandidate(structuredClone(s),catalog);
  for(const gap of s.gaps)if(gap.kind==='preference'&&gap.level==='blocking'){
   gap.level='preference';validationTrace({phase:'nonblocking_preference',description:gap.description,reason:'偏好不是执行前提；必要对象与权限校验仍保留'});
  }
  assertMaterialReferenceTypes(s,references,catalog);
  normalizeTurnOperation(s,query);
  if(!legacyReplay&&actionMode!=='shadow')bindRequestEvidence(s,{query,currentMessage,messages,previous:taskSnapshot});
  if(legacyReplay)for(const gap of s.gaps||[])if(gap.level==='blocking'&&!gap.scope&&!gap.affectedDeliverables?.length)gap.scope='global';
  applyStages(s);
  if(s.executionShape&&s.deliverables?.length===1&&!s.deliverables[0].executionShape){s.deliverables[0].executionShape=s.executionShape;validationTrace({phase:'relocate_representation',from:'/executionShape',to:'/deliverables/0/executionShape',value:s.executionShape});delete s.executionShape;}
  if(typeof s.globalConstraintsNote==='string'){s.globalConstraints=[...(s.globalConstraints||[]),s.globalConstraintsNote];validationTrace({phase:'relocate_representation',from:'/globalConstraintsNote',to:'/globalConstraints',value:s.globalConstraintsNote});delete s.globalConstraintsNote;}
  if(s.continuation?.mode&&!semanticSchema.properties.continuation.properties.mode.enum.includes(s.continuation.mode))check(repairSchema,s);
  if(strictControl&&(!s.approval||!s.continuation))throw Object.assign(new Error('必须输出approval与continuation，缺少主题不代表免除确认义务'),{code:'missing_fields'});
  if(s.continuation?.taskId&&s.continuation.mode!=='new'){const selected=taskCandidates.find(t=>t.id===s.continuation.taskId);if(selected){taskSnapshot=selected;payload.taskSnapshot=intakeSnapshot(selected);}}
  applyPlanDelta(s,taskSnapshot,query);
  if(strictControl&&!taskSnapshot?.id&&s.continuation?.mode==='clarify'&&!s.continuation.taskId&&s.gaps?.some(g=>g.level==='blocking'))s.continuation={mode:'new',taskId:''};
  if(strictControl&&s.continuation?.mode!=='new'&&(!taskSnapshot?.id||!s.continuation?.taskId))throw new Error('没有真实目标任务，不能接受续跑、修订、批准或取消；独立需求使用new，续接对象不明用new和blocking缺口');
  if(strictControl&&taskSnapshot?.id&&s.continuation?.mode!=='new'&&s.continuation?.taskId!==taskSnapshot.id)throw Object.assign(new Error('续接任务引用无效，必须逐字使用当前持久Task ID：'+taskSnapshot.id+'；不能截断、改写或自创ID'),{issues:[{path:legacyReplay?'/continuation/taskId':'/turnOperation/targetTaskId'}]});
  check(repairSchema,s);s=validateSemantic(s);if(['answer','summarize','explain','inspect','present','retain'].includes(s.turnOperation?.kind)){if(['present','retain'].includes(s.turnOperation.kind)){const p=s.turnOperation.presentation;p.bindings=p.targets.map(r=>resolvePresentationReference(r,{references,messages,sessionId}).binding);p.targets=p.bindings.map(b=>b.id);}return s;}if(auditContracts){for(const g of s.gaps){if(['capability','runtime_fact'].includes(g.kind)&&g.level==='blocking')g.level='factual';}}
  if(s.spec)reconcileFixedSpec({spec:s.spec});
  for(const d of s.deliverables){if(d.query){if(d.kind!=='text'||!['query','inspect'].includes(d.action))throw new Error('查询主题只适用于文字查询项');d.runtimeQuery=inspectionGoal(query,{...s,turnOperation:{kind:'inspect',query:d.query},deliverables:[]},taskCandidates,messages).tasks[0].runtimeQuery;d.requiredEvidence='runtime';}if(d.spec)reconcileFixedSpec(d);if(s.spec){const applicableSpec=scopedSpecification(s.spec,d,s.deliverables,catalog);for(const [key,value] of Object.entries(applicableSpec))if(d.spec?.[key]!==undefined&&JSON.stringify(value)!==JSON.stringify(d.spec[key]))throw new Error('全局规格与单项规格冲突：'+key);d.spec={...applicableSpec,...d.spec};}if(d.action==='query'){const taskRefs=d.references.filter(r=>taskCandidates.some(t=>t.id===r||'task:'+t.id===r));d.queryTaskIds=[...new Set([...(d.queryTaskIds||[]),...taskRefs.map(r=>r.replace(/^task:/,''))])];d.references=d.references.filter(r=>!taskRefs.includes(r));if(d.queryTaskIds.some(id=>!taskCandidates.some(t=>t.id===id)))throw new Error('查询目标任务不存在');}planSpecs(d,{query,previous:['revise','clarify'].includes(s.continuation?.mode)?taskSnapshot?.goal?.semantic?.deliverables?.find(p=>p.kind===d.kind&&p.action===d.action):null});reconcileFixedSpec(d);const purpose=d.kind==='text'&&['respond','query','inspect'].includes(d.action)?'history':s.continuation?.mode==='new'?'production':'history';
   try{d.references=references.expand(d.references);d.supportingSources=references.expand(d.supportingSources||[]).map(r=>{if(/^task:\d+$/.test(r))return r;try{return references.select(r,{purpose:'history'}).entry.id;}catch(error){error.referenceField='supportingSources';throw error;}});
    if(d.kind==='image'&&d.action==='modify')d.references=d.references.filter(r=>{if(/^task:\d+$/.test(r))return true;const {entry,source}=references.select(r,{purpose:'history'});if(source.purpose==='support'&&['text','prompt'].includes(entry.type)){d.supportingSources.push(entry.id);return false;}if(entry.type!=='image')throw Object.assign(new Error('图片编辑目标必须为图片，辅助文字放supportingSources'),{code:'reference_selection'});return true;});
    if(d.kind==='text'&&d.action==='modify'&&d.references.some(r=>!/^task:\d+$/.test(r)&&references.select(r,{purpose:'history'}).source.type==='text'))d.references=d.references.filter(r=>{if(/^task:\d+$/.test(r))return true;const {source}=references.select(r,{purpose:'history'});if(source.purpose==='support'&&source.type==='prompt'){d.supportingSources??=[];d.supportingSources.push(source.id);return false;}return true;});
    if(!d.supportingSources?.length)delete d.supportingSources;d.referenceBindings=[];d.references=resolveTaskReferenceAliases(d.references,taskSnapshot).map(ref=>{if(/^task:\d+$/.test(ref))return ref;const binding=references.bind(ref,{purpose});d.referenceBindings.push(binding);return binding.id;});if(!d.referenceBindings.length)delete d.referenceBindings;if(d.supportingSources){d.supportingSources=d.supportingSources.filter(id=>!d.references.includes(id));if(!d.supportingSources.length)delete d.supportingSources;}}
   catch(error){if(error.code==='reference_selection'){const index=s.deliverables.indexOf(d),candidates=references.view(error.referenceField==='supportingSources'?'history':purpose);error.repair={indices:[index],field:error.referenceField||'references',candidates,schema:{type:'object',additionalProperties:false,required:[String(index)],properties:{[String(index)]:{type:'array',items:candidates.length?{enum:candidates.map(e=>e.handle)}:{not:{}},minItems:error.referenceField==='supportingSources'?0:d.references.length?1:0,maxItems:20}}}};}throw error;}
   if(d.supportingSources?.length)d.supportingSourceBindings=d.supportingSources.filter(ref=>!/^task:\d+$/.test(ref)).map(ref=>references.bind(ref,{purpose:'history'}));else delete d.supportingSourceBindings;
   normalizeConsumedStages(d,query,catalog,d.references.filter(r=>!/^task:\d+$/.test(r)).map(r=>references.select(r,{purpose:'history'}).source));
   const gap=bindCoverage(d,references,query,s.deliverables);if(gap&&!s.gaps.some(g=>g.description===gap))s.gaps.push({scope:'deliverables',affectedDeliverables:[s.deliverables.indexOf(d)],description:gap,level:'blocking',kind:'user_input',resolution:'选择出图形式和来源范围后执行'});}
  if(s.deliverables.length&&s.deliverables.every(d=>d.selectionRole==='consumer'&&d.action==='create')){const selected=s.continuation;s.turnOperation={kind:'consume',targetTaskId:selected?.taskId||''};s.continuation=selected?.mode==='revise'?selected:{mode:'new',taskId:''};s.approval={required:false,reason:'消费已有成果创建新文字交付'};}
  if(strictControl)s=reconcileContinuation(s,taskSnapshot);
  if(['revise','clarify'].includes(s.continuation?.mode)&&taskSnapshot?.approval?.required&&s.deliverables.some(d=>d.kind!=='text'))s.approval.required=true;
  if(gateDecision)s.approval.required=gateDecision.required;
  if(strictControl&&taskSnapshot?.status==='NEEDS_INPUT'&&['continue','approve'].includes(s.continuation?.mode))throw new Error('当前任务仍缺输入，不能直接续跑或批准旧的空执行图。补充材料必须使用clarify并重建含原约束和新素材的完整目标。');
  inheritMediaObligations(s,taskSnapshot);
  if(auditContracts&&s.safety.disposition!=='refuse'){if(s.deferred.length)throw new Error('deferred不能承担用户要求。未来交付必须保留在deliverables，不能实现则列明gaps；未请求的建议不纳入任务');if(s.approval.required&&!s.deliverables.some(d=>d.kind!=='text')&&!s.gaps.some(g=>g.level==='blocking'))throw new Error('确认后的媒体义务缺失：保留未来媒体及依赖，不能只完成文字方案');}
  applyStages(s);return validateSemantic(s,{taskSnapshot});
 };
 // kind is optional descriptive metadata, exactly as advertised to the model.
 // Missing preferences never acquire a hidden blocking requirement here.
 const repairSchema=structuredClone(semanticSchema);if(strictControl)repairSchema.required.push('approval','continuation');if(auditContracts){repairSchema.required.push('facts','globalConstraints');}
 const structuredRefs=references.entries.filter(e=>e.readable&&sourceUnits(references.select(e.id,{purpose:'history'}).source).length).flatMap(e=>[e.id,e.handle]);
 if(structuredRefs.length)repairSchema.properties.deliverables.items.allOf=[{if:{properties:{kind:{const:'image'},action:{const:'create'},references:{contains:{enum:structuredRefs}}},required:['kind','action','references']},then:{required:['sourceSelection']}}];
 const preflight=s=>{
  if(['answer','summarize','explain','inspect','present','retain'].includes(s.turnOperation?.kind)){
   bindReadSources(s,references,messages);inspectionGoal(query,s,taskCandidates,messages);return;
  }
  if(s.continuation?.mode==='cancel'||resumesExisting(s,taskSnapshot)||globalBlockingGaps(s).length)return;
  const methods=[...(s.requiredMethods||[]),...s.deliverables.flatMap(d=>d.requiredMethods||[])];
  if(methods.some(slug=>!catalog.skills.some(m=>m.slug===slug)))return;
  for(const d of s.deliverables)if(d.kind==='text'&&d.businessOperation==='modify'&&d.changeContract?.scope==='related_current'){
   d.references=relatedCurrentDocuments(references,d.references).map(a=>a.id);d.referenceBindings=d.references.map(id=>references.bind(id,{purpose:'history'}));
  }
  expandChangeSets(s,references);
  const plan=validatePlan({routes:s.deliverables.map((d,deliverableIndex)=>({deliverableIndex,operation:routeOperation(d),skills:d.requiredMethods||[]}))},s,catalog);
  for(const route of plan.routes)ensureMethodDefaults(s.deliverables[route.deliverableIndex],route.skills,catalog);
 };
 let semantic=await structured(brain,prompt,inputPayload,validateEntry,signal,trace,'understand',legacyReplay?repairSchema:wireSchema,{preflight,stopOnNoProgress:!legacyReplay,repairPayload:()=>compactIntakePayload(structuredClone(payload),renderStage),shape:s=>{if(Array.isArray(s?.businessActions))check(actionSchema,s);},project:s=>Array.isArray(s?.businessActions)?projectBusinessActions(s):s,schemaFor:s=>Array.isArray(s?.businessActions)?actionSchema:legacyReplay?repairSchema:legacyInput});
 if(['answer','summarize','explain','inspect','present','retain'].includes(semantic.turnOperation?.kind)){
  // Read-only sources use the same catalog and version bindings as execution.
  bindReadSources(semantic,references,messages);
  return {...inspectionGoal(query,semantic,taskCandidates,messages),intentSnapshot:trace.intentSnapshot,intakeTrace:trace};
 }
 // Extra semantic checks are reserved for resuming side effects or an approval
 // proposal with no attributable user evidence; ordinary operations never enter here.
 if(strictControl&&resumesExisting(semantic,taskSnapshot)){
  const control=await structured(brain,'独立核对本轮任务操作，依据本轮query、完整近期问答和所选旧任务合同；不得从更短摘要覆盖对话中已明确的补充关系。返回JSON {"operation":"resume|approve|revise|new|inspect|cancel","evidence":"本轮原文依据"}。resume仅用于没有增删改内容的原目标续跑；approve仅用于明确批准已展示方案且没有修改；提出新产品/新目标用new；查询工具、价格、进度用inspect，不得续跑生成。改变数量/内容/流程用revise；仅撤销整项任务且无新交付用cancel，取消某个流程再继续产出属于revise。不得重新生成旧Goal。',{query,conversation:payload.conversation,previous:{originalQuery:taskSnapshot.query,taskId:taskSnapshot.id,summary:taskSnapshot.goal?.summary,status:taskSnapshot.status}},v=>{if(!['resume','approve','revise','new','inspect','cancel'].includes(v.operation))throw new Error('本轮operation必须为resume/approve/revise/new/inspect/cancel');return {...v,modelExplanation:v.evidence,evidence:query};},signal,trace,'verify_turn_operation');
  // A version-bound proposal proves which object is selected, not that the
  // current natural-language request authorizes it. Keep the existing guard.
  if(acceptedActionRequest?.businessActions?.some(a=>a.actionType==='CONFIRM_ARTIFACT')&&control.operation!=='approve')throw new Error('本轮请求未通过已有批准意图核对；保存方案保持待确认，未提交媒体');
  if(control.operation==='cancel'){semantic.continuation={mode:'cancel',taskId:taskSnapshot.id};semantic.deliverables=[];}
  else if(['new','inspect','revise'].includes(control.operation)&&semantic.deliverables.length){semantic.continuation={mode:control.operation==='revise'?'revise':'new',taskId:control.operation==='revise'?taskSnapshot.id:''};}
  else if(['new','inspect','revise'].includes(control.operation))semantic=await structured(brain,prompt+'\n本轮操作独立核对结果：'+JSON.stringify(control)+'。重新提取本轮目标；查询独立建只读目标。',payload,s=>{const v=validateEntry(s);if(v.continuation.mode!==(control.operation==='revise'?'revise':'new'))throw new Error('不得用旧任务覆盖本轮目标');return v;},signal,trace,'repair_turn_operation',legacyReplay?repairSchema:operationInputSchema(semanticSchema));
  else semantic.continuation.mode=control.operation==='resume'?'continue':'approve';
 }
 discardInheritanceForNewTask(semantic);
 if(strictControl&&semantic.approval.required&&(!semantic.approval.reason||!query.includes(semantic.approval.reason))&&semantic.safety.disposition!=='refuse'&&!resumesExisting(semantic,taskSnapshot)&&!(taskSnapshot?.approval?.required&&['clarify','revise'].includes(semantic.continuation?.mode))){
  gateDecision=await structured(brain,'你是独立确认义务判定器。只根据用户原始要求判断是否明确要求暂停并等待用户审核/确认/同意后再生成。执行顺序或依赖（先写脚本再生成）不等于人工审批；不能按最佳实践自行增加确认。只返回JSON {"required":boolean,"evidence":string}。required=true时evidence必须逐字引用原始要求中表达人工确认的原句；没有则false且evidence为空。不要读取或猜测其他模型的计划。',{query},v=>{if(typeof v.required!=='boolean'||typeof v.evidence!=='string'||v.required&&(!v.evidence.trim()||!query.includes(v.evidence)))throw new Error('确认义务缺少原始用户证据');return v;},signal,trace,'extract_confirmation_gate');
  semantic.approval={required:gateDecision.required,reason:gateDecision.required?gateDecision.evidence:'用户未要求人工确认，顺序由依赖图处理'};
 }
 if(semantic.continuation?.mode==='cancel'){if(!taskSnapshot?.id||semantic.continuation.taskId!==taskSnapshot.id)throw new Error('取消对象不存在');return {...structuredClone(taskSnapshot.goal),semantic:{...taskSnapshot.goal.semantic,continuation:semantic.continuation},turnSemantic:semantic,intakeTrace:trace,cancelTaskId:taskSnapshot.id};}
 if(resumesExisting(semantic,taskSnapshot)){return {...structuredClone(taskSnapshot.goal),semantic:{...taskSnapshot.goal.semantic,continuation:semantic.continuation},intakeTrace:trace,turnSemantic:structuredClone(semantic),resumeTaskId:taskSnapshot.id};}
 if(globalBlockingGaps(semantic).length)return {summary:semantic.summary,mode:'answer',tasks:[],skills:[],assumptions:semantic.assumptions,missingInputs:semantic.gaps.filter(g=>g.level==='blocking').map(g=>g.description),needsClarification:true,safety:semantic.safety,semantic,intentSnapshot:trace.intentSnapshot,intakeTrace:trace,planningDeferred:true};
 const unavailable=[...new Set([...(semantic.requiredMethods||[]),...semantic.deliverables.flatMap(d=>d.requiredMethods||[])])].filter(slug=>!catalog.skills.some(s=>s.slug===slug));
 if(unavailable.length)return {summary:semantic.summary,mode:'answer',tasks:[],skills:[],assumptions:semantic.assumptions,missingInputs:[],needsClarification:false,safety:semantic.safety,semantic,intakeTrace:trace,capabilityGap:{kind:'unsupported',methods:unavailable,reason:'指定Skill当前不可用：'+unavailable.join('、')}};
 // Scope and permissions are projections of accepted effects, not another LLM vote.
 const media={image:0,video:0,audio:0};
 for(const d of semantic.deliverables)if(d.kind!=='text'&&!isPresentation(d))media[d.kind]+=d.artifactCount??d.count;
 const activeMedia={image:0,video:0,audio:0};for(const d of semantic.deliverables)if(d.kind!=='text'&&!isPresentation(d)&&!isDeferred(d))activeMedia[d.kind]+=d.artifactCount??d.count;
 const requestContract={currentDeliveries:semantic.deliverables.map((d,i)=>!isDeferred(d)?i:null).filter(i=>i!==null),conditionalDeliveries:semantic.deliverables.flatMap((d,i)=>isDeferred(d)?[{index:i,...d.activation}]:[]),media,finalObligations:{media:{...media}},currentPermission:{mediaBudget:activeMedia,mediaSubmission:!Object.values(activeMedia).some(n=>n>0)?'denied':semantic.approval?.required?'requires_revision_bound_approval':'allowed'},requiredMethods:[...new Set(semantic.deliverables.flatMap(d=>d.requiredMethods||[]))],systemFacts:[...new Set([...(semantic.turnOperation?.kind==='revise_plan'?taskSnapshot?.goal?.requestContract?.systemFacts||[]:[]),...semantic.deliverables.flatMap(d=>d.runtimeQuery?.type==='quote'?['quote']:d.runtimeQuery?.includeQuote?['quote']:[])])],readOnly:semantic.deliverables.every(d=>isPresentation(d)||!!d.runtimeQuery),evidence:query,source:'accepted_turn_operation'};
 // Related documents have already been made available to the understanding node.
 // Expand only an explicitly selected scope; per-document no_change is decided by the delta executor.
 for(const d of semantic.deliverables)if(d.kind==='text'&&d.businessOperation==='modify'&&d.changeContract?.scope==='related_current'){
  d.references=relatedCurrentDocuments(references,d.references).map(a=>a.id);
  d.referenceBindings=d.references.map(id=>references.bind(id,{purpose:'history'}));
 }
 const requirementBindings=new Map();expandChangeSets(semantic,references,requirementBindings);
 for(const d of semantic.deliverables){if(isPresentation(d)){d.runtimeQuery={type:'presentation',targets:d.references,bindings:d.referenceBindings,order:'as_listed'};d.count=d.references.length;d.artifactCount=d.count;d.contentCardinality=d.count;d.requiredEvidence='runtime';d.requiredMethods=[];}}
 const methodsFor=(d,r)=>{const explicit=[...new Set([...(d.requiredMethods||[]),...(semantic.requiredMethods||[]).filter(slug=>r.skills.includes(slug))])];return [...new Set([...r.skills,...explicit])].filter(slug=>explicit.includes(slug)||catalog.skills.find(s=>s.slug===slug).contract.operations.includes(r.operation));};
 const plan=validatePlan({routes:semantic.deliverables.map((d,deliverableIndex)=>({deliverableIndex,operation:routeOperation(d),skills:d.requiredMethods||[]}))},semantic,catalog);
 for(const d of semantic.deliverables){const r=plan.routes.find(r=>r.deliverableIndex===semantic.deliverables.indexOf(d));ensureMethodDefaults(d,methodsFor(d,r),catalog);}
 const goal={summary:semantic.summary,mode:semantic.deliverables.length>1?'mixed':({create:'create',modify:'edit',inspect:'analyze',respond:'answer',query:'continue'}[semantic.deliverables[0]?.action]||'answer'),tasks:semantic.deliverables.map((d,i)=>({operation:plan.routes.find(r=>r.deliverableIndex===i).operation,output:d.kind,count:d.count,dependsOn:d.dependsOn,references:d.references,constraints:d.constraints,requiredEvidence:d.requiredEvidence,activation:d.activation,requestEvidenceSpans:d.requestEvidenceSpans,evidenceSegments:d.evidenceSegments,queryTaskIds:d.queryTaskIds||[],requiredMethods:methodsFor(d,plan.routes.find(r=>r.deliverableIndex===i)),artifactCount:d.artifactCount??(d.kind==='text'?1:d.count),contentCardinality:d.contentCardinality??(d.kind==='text'?d.count:1),...(d.spec?{spec:d.spec,specOrigins:d.specOrigins}:{}),form:d.form,executionShape:d.executionShape,referenceBindings:d.referenceBindings,supportingSourceBindings:d.supportingSourceBindings,coverage:d.coverage,sourceSelection:d.sourceSelection,businessOperation:d.businessOperation,resultRelation:d.resultRelation,changeContract:d.changeContract,selectionRole:d.selectionRole,supportingSources:d.supportingSources,runtimeQuery:d.runtimeQuery,preservedSpec:d.preservedSpec,selectorBinding:d.selectorBinding,selector:d.selector})),skills:[...new Set(plan.routes.flatMap(r=>r.skills))],assumptions:[...new Set([...semantic.assumptions,...semantic.gaps.filter(g=>g.level!=='blocking').map(g=>g.description+'：'+g.resolution)])],missingInputs:globalBlockingGaps(semantic).map(g=>g.description),needsClarification:globalBlockingGaps(semantic).length>0,safety:semantic.safety};validateIntent(goal,catalog);goal.intentSnapshot=trace.intentSnapshot;goal.requirementBindings=Object.fromEntries(requirementBindings);return {...goal,executionMode:semantic.executionMode||(semantic.deliverables.some(d=>d.action==='modify')?'creative_revision':undefined),revisionDelta:semantic.revisionDelta,semantic,intakeTrace:trace,requestContract,capabilityRoutes:plan.routes,...(semantic.turnOperation?.kind==='revise_plan'?{planRevision:{sourceTaskId:taskSnapshot.id,sourceRevision:taskSnapshot.revision,sourcePlanHash:taskSnapshot.approval.planHash,sourceArtifact:revisionTarget(taskSnapshot),parameters:structuredClone(taskSnapshot.approval.payload.items),specDelta:structuredClone(semantic.deliverables[0].spec)}}:{})};}
// The medium/action/form have already been accepted. Select its implementation
// without sending the target, quantity and permissions to a second interpreter.
function routeOperation(d){
 if(d.runtimeQuery)return d.runtimeQuery.type==='presentation'?'present':'inspect_runtime';
 if(d.kind==='image')return d.action==='modify'?'edit_image':'generate_image';
 if(d.kind==='video')return d.action==='modify'?'edit_video':'generate_video';
 if(d.kind==='audio')return 'voiceover';
 if(d.businessOperation==='modify'||d.businessOperation==='translate'||d.action==='modify')return 'rewrite';
 if(['runtime','task'].includes(d.requiredEvidence))return 'inspect_runtime';
 if(d.purpose==='risk_review'||d.form==='review')return 'review_content';
 if(d.form==='script'||d.purpose==='storyboard')return 'storyboard';
 if(d.form==='prompt')return 'rewrite';
 if(['copy','title','directions','composite'].includes(d.form)||d.purpose==='marketing')return 'marketing_script';
 if(d.requiredEvidence==='image')return 'analyze_image';
 if(d.requiredEvidence==='video')return 'read_video';
 if(d.requiredEvidence==='web')return 'search_web';
 return 'answer';
}
export const professionalOperations=new Set(['rewrite','marketing_script','storyboard','review_content']);
