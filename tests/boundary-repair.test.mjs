import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {understandGoal} from '../server/intent.mjs';
import {createTask,currentTask,taskSnapshot,storeOf,reconcileTask} from '../server/task-state.mjs';
import {acceptRevision,assertContract} from '../server/task-contract.mjs';
import {compileGoal,validateGraph} from '../server/goal-compiler.mjs';
import {guardSubmission} from '../server/submission-guard.mjs';
import {constraintChecks,aggregateConstraintChecks} from '../server/constraint-checks.mjs';
import {stageSchema,validateStageResult,publishTextCandidate} from '../server/text-stage.mjs';
import {applyStages} from '../server/stage-contract.mjs';
import {projectBusinessActions} from '../server/business-action.mjs';
import {sourceUnits,bindCoverage} from '../server/source-coverage.mjs';
import {ReferenceCatalog} from '../server/reference-catalog.mjs';
import {composeFinalResponse,responseContext} from '../server/final-response.mjs';
import {deliveryVerdict} from '../server/delivery-acceptance.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const safety={disposition:'allow',untrustedInstructions:false,reason:''};
const reply=x=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(x)}]}];
function baseGoal(){return {summary:'generic contract',safety,tasks:[{operation:'generate_image',output:'image',count:1,dependsOn:[],references:[],constraints:[],spec:{ratio:'1:1'},requiredMethods:[],requiredEvidence:'none'}],semantic:{approval:{required:false},deliverables:[{description:'generic contract'}]}};}
function fixture(){const state={id:randomUUID()},goal=baseGoal(),task=createTask(state,goal,'opaque request');return {state,goal,task};}
const changes={
 count:i=>i.count++,operation:i=>i.operation='generate_video',output:i=>i.output='video',spec:i=>i.spec.ratio='16:9',
 dependency:i=>i.dependsOn.push(0),reference:i=>i.references.push('other-source'),constraint:i=>i.constraints.push('new requirement'),
 method:i=>i.requiredMethods.push('other-method'),activation:i=>i.activation={timing:'now',condition:''},coverage:i=>i.coverage={unitIds:['x']},
 evidence:i=>i.requiredEvidence='image',description:i=>i.description='different goal',selector:i=>i.selectorBinding={version:9},
 binding:i=>i.referenceBindings=[{id:'other',version:3}],delta:i=>i.changeContract={mode:'rewrite'},remove:i=>delete i.count,
 unknownDefinition:i=>i.futureSpecification={amount:7},index:i=>i.index=9,
};
for(const [field,mutate] of Object.entries(changes))for(const phase of ['before_acceptance','before_compile','after_compile','after_reload'])test(`projection rejects ${field} drift ${phase}`,()=>{
 let {task}=fixture();if(phase!=='before_acceptance')acceptRevision(task,'r');
 if(phase==='after_compile')task.executionPlan=compileGoal(task);
 if(phase==='after_reload')task=JSON.parse(JSON.stringify(task));
 mutate(task.items[0]);
 if(phase==='before_acceptance')assert.throws(()=>acceptRevision(task,'r'),/执行项/);
 else {assert.throws(()=>assertContract(task),/执行项/);assert.throws(()=>compileGoal(task),/执行项/);if(task.executionPlan)assert.throws(()=>validateGraph(task),/执行项/);}
});
test('definition projection preserves runtime writes and breaks input aliases',()=>{
 const {task,goal}=fixture();goal.tasks[0].spec.ratio='16:9';assert.equal(task.items[0].spec.ratio,'1:1');
 acceptRevision(task,'r');Object.assign(task.items[0],{status:'WAITING',methods:[{}],issues:['retry'],observations:[{}],artifactIds:['saved'],resolvedCoverage:{unitIds:['a']}});
 assert.doesNotThrow(()=>assertContract(task));task.items[0].id='changed';assert.throws(()=>assertContract(task),/身份/);
});
test('changing both Goal and Item cannot redefine the accepted compiler source',()=>{
 const {task}=fixture();acceptRevision(task,'r');task.goal.tasks[0].spec.ratio='16:9';task.items[0].spec.ratio='16:9';
 assert.throws(()=>compileGoal(task),/已接受/);assert.throws(()=>assertContract(task),/已接受/);
});
async function mediaFixture(query,count=1,{fail=false}={}){
 let submissions=0;const phases=[],state={id:randomUUID(),messages:[],events:[],assets:[]};
 const brain={respond:async(input,tools,_signal,options)=>{
  assert.deepEqual(tools,[]);phases.push(options.tracePhase);
  if(options.tracePhase==='understand')return reply({summary:query,safety,businessActions:[{id:'a',actionType:'CREATE_IMAGE',intent:query,expectedOutput:{count},confirmation:false}]});
  if(options.tracePhase==='media_plan'){const p=JSON.parse(input[1].content);return reply({concept:'reviewable image plan',preservedConstraints:[],safety:{passed:true,reason:'ordinary image'},items:Array.from({length:p.goal.count},()=>({prompt:'saved image prompt',size:'2048x2048'}))});}
  throw Error('Unexpected model phase '+options.tracePhase);
 }};
 const runtime=new ToolRuntime({catalog,brain,media:{config:{imageModel:'local-fixture'},image:async()=>{submissions++;if(fail)throw Error('unknown receipt');return {status:'succeeded',images:[{url:'https://example.invalid/'+submissions+'.png'}]};}}});
 const agent=new Agent({brain,runtime,catalog,verifier:new Verifier(brain,{policy:'delivery_only'}),actionMode:'core'});
 await agent.run(state,query,()=>{},signal());return {agent,runtime,state,phases,submissions:()=>submissions};
}
for(const query of ['只写方案，不要生图。','Please provide text only.','説明文だけをください。','طلبات نصية فقط'])test('model-selected media cannot self-authorize: '+query,async()=>{
 const f=await mediaFixture(query,2),task=currentTask(f.state);
 assert.equal(task.status,'WAIT_CONFIRM');assert.equal(f.submissions(),0);assert.equal(task.contract.executionPermission.mediaSubmission,'requires_revision_bound_approval');
 assert.equal(task.approval.payload.items.length,2);assert.equal(f.phases.includes('final_response'),false);
 // Even a legal model-produced approve intent has no explicit-control receipt.
 f.agent.intake=async()=>({...structuredClone(task.goal),resumeTaskId:task.id,semantic:{...structuredClone(task.goal.semantic),continuation:{mode:'approve',taskId:task.id}}});
 await f.agent.run(f.state,'arbitrary approval-looking text',()=>{},signal());assert.equal(f.submissions(),0);assert.equal(task.status,'WAIT_CONFIRM');
 const restored=JSON.parse(JSON.stringify(f.state)),saved=currentTask(restored),control={resumeTaskId:saved.id,planHash:saved.approval.planHash,requestId:randomUUID()};
 await f.agent.run(restored,'explicit button',()=>{},signal(),control);assert.equal(f.submissions(),2);assert.equal(currentTask(restored).status,'COMPLETED');
 await f.agent.run(restored,'explicit button',()=>{},signal(),control);assert.equal(f.submissions(),2);
 await assert.rejects(f.agent.run(restored,'explicit button',()=>{},signal(),{...control,planHash:'other'}),/requestId/);
 await assert.rejects(f.runtime.execute('generate_image',{prompt:'bypass'},restored,signal()),/提交许可/);assert.equal(f.submissions(),2);
});
test('approval drift, stale hashes and adapter bypass cannot submit',async()=>{
 const f=await mediaFixture('ordinary request'),task=currentTask(f.state);
 await f.agent.run(f.state,'button',()=>{},signal(),{resumeTaskId:task.id,planHash:'stale'});assert.equal(f.submissions(),0);
 task.approval.required=false;assert.throws(()=>assertContract(task),/授权策略/);
 task.approval.required=true;task.approval.status='approved';
 assert.throws(()=>guardSubmission(task,task.items[0],'generate_image',task.approval.payload.items[0]),/批准回执/);
 for(const name of ['generate_image','generate_video','propose_lipsync','propose_video_upscale','propose_video_replication','clone_voice'])await assert.rejects(f.runtime.execute(name,{},f.state,signal()),error=>error.uncertain===false&&error.code==='submission_authorization');
 assert.equal(f.submissions(),0);
});
test('unknown receipt removes resume and restart does not resubmit',async()=>{
 const f=await mediaFixture('ordinary request',1,{fail:true}),task=currentTask(f.state);
 await f.agent.run(f.state,'button',()=>{},signal(),{resumeTaskId:task.id,planHash:task.approval.planHash});assert.equal(f.submissions(),1);
 const restored=JSON.parse(JSON.stringify(f.state));assert.equal(taskSnapshot(restored).actions.canResume,false);assert.equal(taskSnapshot(restored).actions.awaitingReconciliation,true);
 await f.agent.run(restored,'resume',()=>{},signal(),{resumeTaskId:task.id});assert.equal(f.submissions(),1);
 // Snapshot also protects sessions interrupted before recovery was classified.
 const t=currentTask(restored);delete t.recovery;Object.values(storeOf(restored).executions)[0].status='pending';assert.equal(taskSnapshot(restored).actions.canResume,false);
});
test('stage gaps have explicit scope and native action projections preserve it after ordering',()=>{
 const ds=[{kind:'text',dependsOn:[]},{kind:'text',dependsOn:[0]}];
 assert.throws(()=>applyStages({deliverables:structuredClone(ds),gaps:[{level:'blocking',description:'missing scope'}]}),/影响范围/);
 const local=applyStages({deliverables:structuredClone(ds),gaps:[{level:'blocking',scope:'deliverables',affectedDeliverables:[1],description:'selection'}]});
 assert.equal(local.deliverables[0].activation,undefined);assert.equal(local.deliverables[1].activation.timing,'after_user_input');
 assert.throws(()=>applyStages({deliverables:ds,gaps:[{level:'blocking',scope:'global',affectedDeliverables:[0]}]}),/冲突/);
 const native=projectBusinessActions({summary:'native',safety,executionAuthorization:{image:false},speakerRole:'speaker',targetAudience:'audience',gaps:[{scope:'deliverables',level:'blocking',affectedDeliverables:[0],description:'edit later'}],businessActions:[{id:'edit',actionType:'EDIT_IMAGE',intent:'edit',target:{type:'ACTION_OUTPUT',actionId:'source'},activation:{timing:'after_user_input',condition:'choice'}},{id:'source',actionType:'CREATE_IMAGE',intent:'create'}]});
 assert.deepEqual(native.gaps[0].affectedDeliverables,[1]);assert.equal(native.speakerRole,'speaker');assert.equal(native.targetAudience,'audience');assert.equal(native.executionAuthorization.image,false);assert.equal(native.deliverables[1].activation.timing,'after_user_input');
});
test('native explicit authorization conflicts fail before execution',async()=>{
 const request={summary:'request',safety,executionAuthorization:{image:false},businessActions:[{id:'a',actionType:'CREATE_IMAGE',intent:'request'}]};
 await assert.rejects(understandGoal({respond:async()=>reply(request)},catalog,{query:'request',actionMode:'core'},signal()),/授权/);
});
test('source coverage uses typed binding across languages, rejects unknown units and overlapping partitions',()=>{
 const source={id:'source',type:'text',version:1,content:'source document',metadata:{structure:{shots:[{content:'a'},{content:'b'}]}}},c=new ReferenceCatalog([source]),units=sourceUnits(source);
 for(const query of ['use this selection','按指定单元制作','この指定を使用','utiliser cette sélection'])for(const layout of ['storyboard_sheet','separate_images']){
  const d={kind:'image',action:'create',references:['source'],dependsOn:[],spec:{},sourceSelection:{source:'source',unitType:'shots',mode:'selected',unitIds:units.map(u=>u.id),layout,evidence:query}};
  assert.equal(bindCoverage(d,c,query),undefined);assert.equal(d.count,layout==='storyboard_sheet'?1:2);
  d.sourceSelection.unitIds=['unknown'];assert.throws(()=>bindCoverage(d,c,query),/未知/);
 }
});
test('delivery-only publishes numeric mismatch with nonblocking diagnostics; strict rejects same evidence',()=>{
 const {state,task}=fixture();task.items[0].output='text';task.items[0].spec={shotCount:2,secondsPerShot:5,durationSeconds:10};
 const item=task.items[0],result={content:'完整的分镜正文',structure:{shots:[{content:'a',durationSeconds:3},{content:'b',durationSeconds:3}],durationSeconds:6}};
 const verdict=deliveryVerdict({content:result.content}),report=constraintChecks(item,result);assert.equal(verdict.passed,true);assert.equal(report.status,'failed');
 assert.throws(()=>validateStageResult(item,result),/时长/);
 const artifact=publishTextCandidate({state},item,result,[],verdict);assert.equal(artifact.publication,'current');assert.equal(artifact.acceptance.quality.status,'not_evaluated');assert.equal(artifact.acceptance.constraintChecks.status,'failed');
});
test('delivery-only reports actual media metadata mismatch without invoking quality models',async()=>{
 const verifier=new Verifier({respond:async()=>{throw Error('no model');}},{policy:'delivery_only'});
 for(const [item,artifact] of [
  [{spec:{ratio:'3:4'}},{type:'image',url:'https://example.invalid/image',metadata:{provider:{size:'1024x1024'}}}],
  [{spec:{durationSeconds:5,ratio:'9:16'}},{type:'video',url:'https://example.invalid/video',metadata:{provider:{duration:3,ratio:'16:9'}}}]
 ]){const verdict=await verifier.verifyArtifact(item,artifact,{},signal());assert.equal(verdict.passed,true);assert.equal(verdict.constraintChecks.status,'failed');}
 const absent=await verifier.verifyArtifact({spec:{ratio:'3:4'}},{type:'image',url:'https://example.invalid/image',metadata:{}},{},signal());assert.equal(absent.constraintChecks.status,'not_evaluated');
});
test('assembled documents retain all stage constraint diagnostics',()=>{
 const report=aggregateConstraintChecks([{id:'a',report:constraintChecks({spec:{durationSeconds:10}},{structure:{shots:[{durationSeconds:3}]}})},{id:'b',report:constraintChecks({spec:{}},{content:'other'})}]);
 assert.equal(report.status,'failed');assert.equal(report.checks[0].field,'a.durationSeconds');
});
test('all method guidance declares actual compiled permissions and optional script evidence',async()=>{
 for(const skill of catalog.skills){
  const guidance=await readFile(new URL('../skills/'+skill.slug+'/instructions.md',import.meta.url),'utf8');
  assert.deepEqual(skill.contract.allowedTools,[]);assert.equal(skill.contract.scriptPolicy.scheduled,false);assert.match(guidance,/compiled 阶段没有工具调用权限/);assert.doesNotMatch(guidance,/不要输出 JSON/);
 }
 const item={requiredMethods:['video-prompt-safety-zh-v1'],spec:{},count:1},schema=stageSchema(item,catalog);assert.deepEqual(schema.required,['content','structure']);assert.ok(schema.properties.structure.properties.safeAlternative);assert.equal(schema.properties.reviews,undefined);
});
test('supersession remains historical while current session completion excludes replaced obligations',()=>{
 const {state,task}=fixture();const replacement=createTask(state,baseGoal(),'revision',{parentTaskId:task.id});
 assert.equal(task.status,'CANCELLED');assert.equal(task.requirements[0].status,'pending');assert.equal(taskSnapshot(state,task).disposition,'superseded');
 const turn={rawInput:'status',queryReceipt:{facts:{query:{type:'task_inspect'}}}},view=responseContext(state,turn,{artifacts:[]});assert.deepEqual(view.state.selectedTasks.map(t=>t.taskId),[replacement.id]);
 turn.queryReceipt.facts.query.taskIds=[task.id];assert.equal(responseContext(state,turn,{artifacts:[]}).state.selectedTasks[0].disposition,'superseded');
});
test('production rendering is a pure saved-artifact projection without a model',async()=>{
 const {state,task}=fixture(),turn={rawInput:'request',taskId:task.id};let calls=0;
 const text=await composeFinalResponse({respond:async()=>{calls++;throw Error('must not call');}},state,turn,{taskId:task.id,status:'completed',artifacts:[{id:'fake',content:'unsaved'}]},signal());
 assert.equal(calls,0);assert.doesNotMatch(text,/unsaved/);assert.equal(turn.responseReceipt.source,'saved_artifact_projection');
});
