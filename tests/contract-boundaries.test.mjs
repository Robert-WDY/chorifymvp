// Offline contract tests: synthetic model/verification responses, no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {understandGoal,semanticSchema} from '../server/intent.mjs';
import {operationInputSchema,revisionTarget} from '../server/turn-operation.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {ReferenceCatalog,sourceDigest} from '../server/reference-catalog.mjs';
import {sourceUnits,bindCoverage,requirementCoverage} from '../server/source-coverage.mjs';
import {resolveSources} from '../server/sources.mjs';
import {bindStageSources} from '../server/text-stage.mjs';
import {createTask,currentTask,addArtifact,taskSnapshot,reconcileTask,approveTask} from '../server/task-state.mjs';
import {acceptRevision,methodSatisfied} from '../server/task-contract.mjs';
import {Agent} from './runtime-model-fixture.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {TaskExecutor} from '../server/execution-engine.mjs';
import {runCompiled} from '../server/compiled-runtime.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=x=>[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(x)}]}];
const safety={disposition:'allow',untrustedInstructions:false,reason:''};
const candidate=(kind,deliverables=[],extra={})=>({summary:'合同测试',turnOperation:{kind},deliverables,safety,approval:{required:false,reason:''},...extra});
const image=(id,n)=>({id,type:'image',url:'https://test.invalid/'+id+'.png',version:1,purpose:'deliverable',publication:'current',verification:{technical:'passed',semantic:'passed'},content:n||id});
const document=(field='directions')=>({id:'doc',type:'text',version:2,purpose:'deliverable',publication:'current',verification:{technical:'passed',semantic:'passed'},content:'三个单元',metadata:{structure:{[field]:[1,2,3].map(n=>({id:'embedded-'+n,title:'方向'+n,content:'场景'+n}))}}});
const options=(assets)=>({assets,strictControl:true,auditContracts:true,sessionId:'test',runId:randomUUID()});
async function understand(query,value,context){let calls=0;const goal=await understandGoal({respond:async()=>{calls++;return reply(value);}},catalog,{query,...context},signal());return {goal,calls};}
const simple=(items)=>({summary:'合同',mode:'create',tasks:items.map(i=>({operation:'answer',output:'text',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none',spec:{},...i})),skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety,semantic:{deliverables:items.map(i=>({description:i.description||'合同',kind:i.output||'text',action:'create'})),facts:[],globalConstraints:[],approval:{required:false},continuation:{mode:'new',taskId:''}}});
const fresh=()=>({id:'test',messages:[],events:[]});
async function capture(name,state){if(!process.env.CHORIFY_CONTRACT_TRACE_DIR)return;await mkdir(process.env.CHORIFY_CONTRACT_TRACE_DIR,{recursive:true});await writeFile(join(process.env.CHORIFY_CONTRACT_TRACE_DIR,name+'.json'),JSON.stringify({mode:'offline_model_and_verifier_stubs',state},null,2));}

test('1 image ordinal never becomes direction selection before planning',async()=>{
 const raw=candidate('modify',[{kind:'image',action:'modify',description:'改背景',count:1,references:['cup'],spec:{ratio:'1:1',selectedDirectionIndex:1},changeContract:{change:['背景米白'],preserve:['杯子不动']},selector:{type:'artifact',ordinal:1,artifactId:'cup',version:1}}]);
 const {goal,calls}=await understand('改第一张图片背景',raw,options([image('cup'),image('bottle')]));
 assert.equal(calls,1);assert.equal(goal.tasks[0].operation,'edit_image');assert.equal(goal.tasks[0].spec.selectedDirectionIndex,undefined);assert.deepEqual(goal.tasks[0].requiredMethods,[]);assert.equal(goal.tasks[0].selectorBinding.type,'artifact');assert.equal(goal.tasks[0].selectorBinding.artifactId,'cup');
});
test('1 wrong typed image ordinal/version is rejected, not rebound by focus',async()=>{
 const raw=candidate('modify',[{kind:'image',action:'modify',description:'改背景',count:1,references:['cup'],changeContract:{change:['背景'],preserve:['主体']},selector:{type:'artifact',ordinal:2,artifactId:'cup',version:1}}]);
 await assert.rejects(understand('改第一张图片背景',raw,options([image('cup'),image('bottle')])),/序号/);
 raw.deliverables[0].selector.ordinal=1;raw.deliverables[0].selector.version=9;
 await assert.rejects(understand('改第一张图片背景',raw,options([image('cup')])),/版本/);
});
test('2 present preserves image output, uses three references and creates zero artifacts',async()=>{
 const state=fresh();state.assets=['a','b','c'].map(id=>({...image(id),assetId:id,kind:'image',source:'用户提供'}));
 const raw=candidate('present',[],{turnOperation:{kind:'present',presentation:{targets:['a','b','c'],order:'as_listed'}}});
 let calls=0,submissions=0;const brain={respond:async()=>{calls++;return reply(raw);}},runtime=new ToolRuntime({catalog,brain,media:{config:{},image:async()=>{submissions++;throw Error('media forbidden');}}});
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog}).run(state,'展示前三张已有图片',()=>{},signal());
 assert.equal(calls,1);assert.equal(submissions,0);assert.equal(state.turns[0].decision.semantic.turnOperation.kind,'present');assert.equal(Object.keys(state.taskStore.artifacts).length,0);assert.equal(Object.keys(state.taskStore.tasks).length,0);assert.equal(state.turns[0].queryReceipt.facts.artifacts.length,3);assert.equal(state.lastTurn.status,'completed');
 const {goal}=await understand('展示前三张已有图片',raw,options(state.assets));assert.equal(goal.tasks[0].operation,'present');assert.equal(goal.tasks[0].output,'image');assert.equal(goal.requestContract.newArtifacts,0);assert.equal(goal.requestContract.currentPermission.mediaSubmission,'denied');
 await capture('Test2-present',state);
});
test('2 retain is read only and present cannot authorize create',async()=>{
 const c=candidate('retain',[],{turnOperation:{kind:'retain',presentation:{targets:['cup'],order:'as_listed'}}});
 assert.equal((await understand('保留这张图',c,options([image('cup')]))).goal.readOnlyTurn,true);
 c.turnOperation.kind='present';c.deliverables=[{kind:'image',action:'create',description:'额外图',count:1}];
 await assert.rejects(understand('展示图',c,options([image('cup')])),/不能授权生产/);
});
test('catalog distinguishes missing, superseded, nonproduction and usable across consumers',()=>{
 const old={...image('old'),publication:'superseded'},bad={...image('bad'),verification:{technical:'passed',semantic:'failed'}},good=image('good');const c=new ReferenceCatalog([old,bad,good]);
 assert.equal(c.resolveReference('missing',{required:false}).status,'not_found');assert.equal(c.resolveReference('old',{purpose:'history'}).status,'superseded');assert.equal(c.resolveReference('old',{required:false}).usable,false);assert.equal(c.resolveReference('bad',{required:false}).status,'not_production_usable');assert.equal(c.resolveReference('good').status,'usable');assert.throws(()=>c.resolveReference('old'),/被替代/);
 const state={id:'test',taskStore:{activeTaskId:'unrelated',tasks:{unrelated:{}},artifacts:{good},inputs:{}}},binding=c.bind('good');assert.equal(resolveSources(state,{references:['good'],referenceBindings:[binding]})[0].id,'good');state.taskStore.activeTaskId='other';assert.equal(resolveSources(state,{references:['good'],referenceBindings:[binding]})[0].id,'good');good.version++;assert.throws(()=>resolveSources(state,{references:['good'],referenceBindings:[binding]}),/来源版本/);
});
test('catalog isolates explicit foreign sessions and unknown URLs',()=>{
 const c=new ReferenceCatalog([{...image('foreign'),sessionId:'other'},image('local')],{scope:'test'});assert.equal(c.resolveReference('foreign',{required:false}).status,'not_found');assert.throws(()=>c.resolveReference('https://test.invalid/unregistered.png'),/不存在/);
});
test('A2 invalid shot selection on an image cannot reach planner',async()=>{
 const raw=candidate('modify',[{kind:'image',action:'modify',description:'改背景',count:1,references:['cup'],changeContract:{change:['背景'],preserve:['主体']},sourceSelection:{source:'cup',unitType:'shots',mode:'selected',unitIds:['cup'],layout:'separate_images'}}]);
 await assert.rejects(understand('改第一张图片背景',raw,options([image('cup')])),/没有指定类型/);
});
for(const embedded of [false,true])test('A4 second direction is bound and input contains only it, embedded='+embedded,async()=>{
 const doc=document(),unit=sourceUnits(doc)[1];
 const raw=candidate('consume',[{kind:'text',action:'create',description:'第二方向写脚本',form:'script',count:1,references:['doc'],supportingSources:['doc'],spec:{durationSeconds:9,shotCount:3},sourceSelection:{source:'doc',unitType:'directions',mode:'selected',unitIds:[embedded?unit.value.id:unit.id],layout:'unspecified'}}]);
 const {goal}=await understand('用第二个方向写9秒3镜头脚本',raw,options([doc]));const state=fresh();state.taskStore={activeTaskId:null,tasks:{},artifacts:{doc},inputs:{},executions:{},toolCalls:{}};const task=createTask(state,goal,'第二方向');const sources=bindStageSources(state,task.items[0]);
 assert.equal(sources[0].selectedDirection.index,2);assert.equal(sources[0].selectedDirection.id,unit.id);assert.equal(sources[0].structure,undefined);assert.equal(sources[0].content,undefined);assert.equal(goal.tasks[0].selectorBinding.version,2);assert.equal(goal.requestContract.currentPermission.mediaSubmission,'denied');assert.equal(goal.tasks[0].supportingSources,undefined);
});
function savedPlan(){
 const state=fresh(),g=simple([{operation:'generate_video',output:'video',spec:{ratio:'16:9',durationSeconds:5}}]);g.semantic.deliverables=[{kind:'video',action:'create',description:'杯子16:9',count:1,references:[],dependsOn:[],constraints:['无人'],spec:{ratio:'16:9',durationSeconds:5},requiredMethods:[],requiredEvidence:'none',purpose:'general'}];g.semantic.approval.required=true;g.semantic.facts=['杯子'];g.semantic.globalConstraints=['无人'];
 const task=createTask(state,g,'视频待确认');const params={prompt:'杯子16:9',duration:5,ratio:'16:9',resolution:'720p'};const artifact=addArtifact(state,{itemId:task.items[0].id,type:'prompt',purpose:'support',content:'杯子16:9',metadata:{structure:{items:[params]}},verification:{technical:'passed',semantic:'passed'}});task.executionPlan={nodes:[{itemId:task.items[0].id,skillArtifactId:artifact.id}]};task.status='WAIT_CONFIRM';task.approval={required:true,status:'pending',planHash:'original-hash',payload:{itemId:task.items[0].id,items:[params]}};
 const snapshot=taskSnapshot(state),target=revisionTarget(snapshot),raw=candidate('revise_plan',[],{turnOperation:{kind:'revise_plan',targetTaskId:task.id},revisionDelta:{targetArtifactId:target.targetArtifactId,targetVersion:target.targetVersion,changes:[{field:'ratio',from:'16:9',to:'9:16'}],preserve:['duration','source','facts']}});return {state,task,snapshot,raw};
}
test('3 revise delta binds saved artifact; planner reuses video obligations and zero direction skills',async()=>{
 const f=savedPlan();const {goal,calls}=await understand('把已有视频改9:16',f.raw,{...options([]),taskSnapshot:f.snapshot,taskCandidates:[f.snapshot]});
 assert.equal(calls,1);assert.equal(goal.executionMode,'parameter_delta');assert.deepEqual(goal.revisionDelta.changes,[{field:'ratio',from:'16:9',to:'9:16'}]);assert.equal(goal.tasks.length,1);assert.equal(goal.tasks[0].spec.durationSeconds,5);assert.deepEqual(goal.tasks[0].requiredMethods,[]);assert.deepEqual(goal.semantic.facts,['杯子']);assert.equal(goal.semantic.approval.required,true);assert.equal(f.task.approval.payload.items[0].ratio,'16:9');
});
test('3 ratio delta goes through real compiler with no model call, persists 9:16 and invalidates old approval',async()=>{
 const f=savedPlan();let modelCalls=0,mediaCalls=0;
 const brain={respond:async()=>{modelCalls++;return reply(f.raw);}},runtime=new ToolRuntime({catalog,brain,media:{config:{videoModel:'offline-stub'},video:async()=>{mediaCalls++;throw Error('forbidden video');}}}),verifier={verifyPlan:async()=>({passed:true,issues:[]})};
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,verifier}).run(f.state,'把已有视频改9:16，先别生成',()=>{},signal());
 const task=currentTask(f.state);assert.equal(modelCalls,1);assert.equal(mediaCalls,0);assert.equal(task.status,'WAIT_CONFIRM',JSON.stringify({reason:task.reason,issues:task.items.map(i=>i.issues)}));assert.equal(task.approval.payload.items[0].ratio,'9:16');assert.equal(task.approval.payload.items[0].duration,5);assert.equal(task.approval.payload.items[0].resolution,'720p');assert.notEqual(task.approval.planHash,f.task.approval.planHash);assert.throws(()=>approveTask(f.state,task.id,f.task.approval.planHash));assert.equal(task.items[0].methods.some(m=>m.skillId.includes('direction')),false);
 const revisedArtifact=f.state.taskStore.artifacts[task.executionPlan.nodes[0].skillArtifactId];assert.equal(revisedArtifact.parentId,f.raw.revisionDelta.targetArtifactId);assert.equal(revisedArtifact.version,f.raw.revisionDelta.targetVersion+1);
 await capture('Test3-parameter-delta',f.state);
});
test('3 stale version/from and mixed creative delta cannot pass',async()=>{
 for(const mutate of [r=>r.revisionDelta.targetVersion++,r=>r.revisionDelta.changes[0].from='4:3',r=>r.revisionDelta.changes.push({field:'prompt',from:'a',to:'b'}),r=>r.deliverables.push({kind:'text',action:'modify',description:'rewrite'})]){const f=savedPlan();mutate(f.raw);await assert.rejects(understand('改9:16',f.raw,{...options([]),taskSnapshot:f.snapshot,taskCandidates:[f.snapshot]}));}
});
test('3 model-facing schema rejects text modify/empty delta for revise_plan',()=>{
 const validate=new Ajv({strict:false}).compile(operationInputSchema(semanticSchema));const f=savedPlan();assert.equal(validate(f.raw),true);delete f.raw.revisionDelta;assert.equal(validate(f.raw),false);f.raw.deliverables=[{kind:'text',action:'modify',description:'改ratio'}];assert.equal(validate(f.raw),false);
});
test('4 three-shot requirement survives misleading count=1; completion requires 3/3 verified units',()=>{
 const doc=document('shots'),catalog=new ReferenceCatalog([doc]);const d={kind:'image',action:'create',description:'逐镜出图',count:1,references:['doc'],dependsOn:[],sourceSelection:{source:'doc',unitType:'shots',mode:'all',layout:'separate_images'}};assert.equal(bindCoverage(d,catalog,'三个镜头分别生成图片',[d]),undefined);assert.equal(d.count,3);
 const state=fresh(),task=createTask(state,simple([{...d,output:'image',operation:'generate_image'}]),'三个镜头分别生成图片');acceptRevision(task,'r');task.validationPolicy='strict';const item=task.items[0];item.count=1;
 for(let n=0;n<3;n++){
  const unit=d.coverage.unitIds[n],a=addArtifact(state,{itemId:item.id,type:'image',url:'https://test.invalid/'+n+'.png',metadata:{coverage:{source:d.coverage.source,unitIds:[unit],layout:'separate_images'}},verification:{technical:'passed',semantic:'passed'}});a.publication='current';a.acceptance={quality:{coverage:{passed:true,unitIds:[unit]}}};reconcileTask(state);
  assert.equal(task.requirementCoverage.filter(r=>r.status==='completed').length,n+1);assert.equal(task.requirementCoverage.length,3);if(n<2)assert.notEqual(task.status,'COMPLETED');
 }
 assert.equal(task.status,'COMPLETED');
});
test('4 duplicate first-shot artifacts and unbound coverage never complete',()=>{
 const doc=document('shots'),d={kind:'image',action:'create',references:['doc'],count:1,sourceSelection:{source:'doc',unitType:'shots',mode:'all',layout:'separate_images'}};bindCoverage(d,new ReferenceCatalog([doc]),'三个镜头分别生成图片',[d]);const unit=d.coverage.unitIds[0];
 const artifacts=[1,2,3].map(n=>({...image('result-'+n),metadata:{coverage:{source:d.coverage.source,unitIds:[unit],layout:'separate_images'}},acceptance:{quality:{coverage:{passed:true,unitIds:[unit]}}}}));assert.equal(requirementCoverage({...d,id:'i'},artifacts).filter(r=>r.status==='completed').length,1);
 const state=fresh(),task=createTask(state,simple([{output:'image',operation:'generate_image',sourceSelection:d.sourceSelection}]),'未绑定');addArtifact(state,{itemId:task.items[0].id,type:'image',url:'https://test.invalid/a.png',verification:{technical:'passed',semantic:'passed'}});reconcileTask(state);assert.notEqual(task.status,'COMPLETED');
});
test('5 selected skill has actual traced execution and verified output linkage',async()=>{
 const raw=candidate('create',[{kind:'text',action:'create',description:'理解产品事实',count:1,requiredMethods:['product-understanding-zh-v1'],form:'analysis'}]);const state=fresh();let calls=0;
 const brain={respond:async input=>{calls++;if(input[0].content.includes('需求理解器'))return reply(raw);return reply({content:'白杯适用于桌面场景；容量未知。',structure:{facts:['白杯'],assumptions:['容量未知'],sellingPoints:['桌面场景']}});}},runtime=new ToolRuntime({catalog,brain,media:{config:{}}});
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,verifier:{verifyText:async()=>({passed:true,issues:[]})}}).run(state,'使用product-understanding skill，只分析白杯，不编容量',()=>{},signal());
 const task=currentTask(state);assert.equal(task.status,'COMPLETED',JSON.stringify({reason:task.reason,issues:task.items.map(i=>i.issues)}));assert.equal(calls,2);const m=task.items[0].methodExecution[0];assert.equal(m.skillId,'product-understanding-zh-v1');assert.equal(m.status,'verified');assert.ok(m.callId);assert.equal(m.outputArtifactIds.length,1);assert.ok(state.modelCalls.some(c=>c.id===m.callId&&c.status==='returned'));assert.equal(m.contentHash.length,64);
 await capture('Test5-skill',state);
});
test('5 selected/loaded skill or fabricated validated flag cannot complete an artifact',()=>{
 const state=fresh(),task=createTask(state,simple([{requiredMethods:['product-understanding-zh-v1']}]),'使用product-understanding skill'),item=task.items[0];const a=addArtifact(state,{itemId:item.id,type:'text',content:'正文',verification:{technical:'passed',semantic:'passed'}});
 for(const methods of [[],[{skillId:'product-understanding-zh-v1',status:'loaded'}],[{skillId:'product-understanding-zh-v1',status:'validated',contentHash:'hash',contractValidated:true,outputArtifactIds:[a.id]}]]){item.methods=methods;assert.equal(methodSatisfied(item,a),false);reconcileTask(state);assert.notEqual(task.status,'COMPLETED');}
});
test('URL aliases must check the same frozen version/hash as artifact IDs',()=>{
 const a=image('cup'),binding=new ReferenceCatalog([a]).bind(a.id),state={id:'test',taskStore:{artifacts:{cup:a},inputs:{},tasks:{}}};
 a.content='changed content';assert.throws(()=>resolveSources(state,{references:[a.url],referenceBindings:[binding]}),/来源版本或内容/);
});
test('mixed present and create compiles distinct effects without a presentation artifact',async()=>{
 const a=image('cup'),raw=candidate('create',[{description:'保留原图',kind:'image',action:'present',count:1,references:['cup']},{description:'写一句说明',kind:'text',action:'create',count:1,form:'answer'}]);
 const {goal}=await understand('展示原图，写一句说明',raw,options([a]));const state=fresh();state.assets=[a];const task=createTask(state,goal,'混合');acceptRevision(task,'r');
 const executor=new TaskExecutor({state,catalog,brain:{respond:async()=>reply({content:'白杯'})},runtime:{capabilities:()=>({})},save:async()=>{},verifier:{verifyText:async()=>({passed:true,issues:[]})}});
 await runCompiled(executor,signal(),async()=>{});assert.equal(task.status,'COMPLETED');assert.equal(task.items[0].output,'image');assert.equal(task.items[0].operation,'present');assert.equal(task.items[0].artifactIds.length,0);assert.equal(task.items[0].readReceipt.artifactReferences[0].id,'cup');assert.equal(task.contract.finalObligations.media.image,0);assert.equal(Object.values(state.taskStore.artifacts).length,1);
});
test('failed required Skill preserves loaded content and failed call evidence',async()=>{
 const state=fresh(),g=simple([{requiredMethods:['product-understanding-zh-v1']}]),brain={respond:async()=>{throw Object.assign(Error('offline transport failure'),{repairTarget:'transport'});}},runtime=new ToolRuntime({catalog,brain,media:{config:{}}});
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,intake:async()=>g,verifier:{verifyText:async()=>({passed:true,issues:[]})}}).run(state,'使用product-understanding skill',()=>{},signal());
 const task=currentTask(state),m=task.items[0].methodExecution[0];assert.notEqual(task.status,'COMPLETED');assert.equal(m.status,'failed');assert.equal(m.contentHash.length,64);assert.ok(m.callId);assert.equal(state.modelCalls.find(c=>c.id===m.callId).status,'failed');assert.equal(m.outputArtifactIds.length,0);
});
