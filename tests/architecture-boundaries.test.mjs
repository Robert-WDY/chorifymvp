import {fieldPatchFor} from './runtime-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {loadCatalog} from '../server/catalog.mjs';
import {Agent} from './runtime-model-fixture.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {createTask,currentTask,addArtifact,reconcileTask,taskSnapshot,clientStatus,requireApproval,approveTask,taskActions} from '../server/task-state.mjs';
import {acceptRevision,assertContract} from '../server/task-contract.mjs';
import {compileGoal,validateGraph,migrateGraph} from '../server/goal-compiler.mjs';
import {stageSchema,bindStageSources,validateStageResult,renderStage} from '../server/text-stage.mjs';
import {resolveSources} from '../server/sources.mjs';
import {immutableEvent,withTrace,tracedBrain,redact} from '../server/trace-context.mjs';
import {understandGoal} from './intake-compat.mjs';
import {DeepSeek} from '../server/adapters.mjs';
import {guardSubmission} from '../server/submission-guard.mjs';
import {validatePlan} from '../server/intent.mjs';
import {fingerprint} from '../server/adapters.mjs';
import {normalizeSchemaKeys} from '../server/structured-codec.mjs';
import {methodSatisfied,acceptDecision} from '../server/task-contract.mjs';
const catalog=await loadCatalog(),sig=()=>new AbortController().signal,pass={passed:true,issues:[]};
const reply=v=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(v)}]}];
const goal=(items)=>({summary:'independent requirement',mode:'answer',tasks:items.map(i=>({operation:'answer',output:'text',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none',spec:{},...i})),skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow'},semantic:{deliverables:items.map(i=>({description:i.description||'current stage'})),facts:['USB供电','容量未知'],globalConstraints:['禁止生成媒体'],approval:{required:false},continuation:{mode:'new'}}});
const fresh=()=>({id:'s',messages:[],events:[]});
function setup(items,respond=async()=>reply({content:'正文'})){
 const state=fresh(),brain={respond},media={config:{imageModel:'test',videoModel:'test'},image:async()=>{throw Error('unexpected media');}},runtime=new ToolRuntime({catalog,brain,media});
 const agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,intake:async()=>goal(items),verifier:{verifyText:async()=>pass,verifyPlan:async()=>pass,verifyArtifact:async()=>pass}});return{state,agent};
}
test('new goals survive irrelevant blocked, failed, completed and confirmation history',async()=>{
 for(const status of ['BLOCKED','FAILED','COMPLETED','WAIT_CONFIRM']){const f=setup([{}]),old=createTask(f.state,goal([{}]),'old unrelated');old.status=status;await f.agent.run(f.state,'new explicit task',()=>{},sig());assert.notEqual(currentTask(f.state).id,old.id);assert.equal(f.state.turns[0].rawInput,'new explicit task');assert.equal(f.state.turns[0].decision.operations[0].operation,'new');}
});
test('an empty resume proposal for a new request is independently rejected and replanned',async()=>{
 const state=fresh(),old=createTask(state,goal([{}]),'old blocked');old.status='BLOCKED';let calls=0;
 const semantic={summary:'old',deliverables:[],gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false},approval:{required:false,reason:''},continuation:{mode:'continue',taskId:old.id}};
 const brain={respond:async()=>{calls++;if(calls===1)return reply(semantic);if(calls===2)return reply({operation:'new',evidence:'new product'});if(calls===3)return reply({...semantic,continuation:{mode:'new',taskId:''},deliverables:[{description:'new product',kind:'text',count:1,action:'respond',purpose:'general',requiredEvidence:'none',references:[],dependsOn:[],constraints:[],requestEvidence:'new product'}]});return reply({routes:[{deliverableIndex:0,operation:'answer',skills:[]}]});}};
 const g=await understandGoal(brain,catalog,{query:'new product',taskSnapshot:taskSnapshot(state),strictControl:true},sig());assert.equal(g.resumeTaskId,undefined);assert.equal(g.semantic.deliverables[0].description,'new product');assert.equal(g.intakeTrace[1].phase,'verify_turn_operation');
});
test('revision retires unfinished obligations and stale approval cannot authorize changed contract',()=>{
 const state=fresh(),old=createTask(state,goal([{}]),'old');acceptRevision(old,'r1');old.approval.required=true;requireApproval(state,{items:[{prompt:'old'}]});const frozen=old.approval.planHash;old.revision++;assert.throws(()=>approveTask(state,old.id,frozen),/确认对象/);
 const next=createTask(state,goal([{}]),'revision',{parentTaskId:old.id});assert.equal(old.supersededBy,next.id);assert.equal(old.status,'CANCELLED');assert.equal(taskActions(old).canResume,false);assert.throws(()=>assertContract(old),/取代/);
});
test('graph and accepted contract detect lost node methods or changed requirements',()=>{
 const state=fresh(),task=createTask(state,goal([{requiredMethods:['product-understanding-zh-v1']}]),'q');acceptRevision(task,'r');task.executionPlan=compileGoal(task);assert.ok(task.executionPlan.coverage.some(r=>r.evidence==='runtime_method'));task.executionPlan.nodes[0].requiredMethods=[];assert.throws(()=>validateGraph(task),/不一致/);task.goal.summary='changed';assert.throws(()=>assertContract(task),/合同/);
});
test('a permissive quality judge cannot complete a required method with no runtime evidence',()=>{
 const state=fresh(),task=createTask(state,goal([{requiredMethods:['product-understanding-zh-v1']}]),'q');task.validationPolicy='strict';const item=task.items[0];addArtifact(state,{itemId:item.id,type:'text',content:'excellent prose',verification:{technical:'passed',semantic:'passed'}});reconcileTask(state);assert.notEqual(task.status,'COMPLETED');
});
test('stage schema rejects other stage writes and fixes internal cardinality independently of files',()=>{
 const product={requiredMethods:['product-understanding-zh-v1'],spec:{},count:1},validate=new Ajv({strict:false}).compile(stageSchema(product,catalog));assert.equal(validate({content:'ok',structure:{facts:[],assumptions:[],sellingPoints:[],directions:[]}}),false);
 const directions={requiredMethods:['direction-designer-zh-v1'],spec:{},count:1,contentCardinality:3,artifactCount:1},schema=stageSchema(directions,catalog);assert.equal(schema.properties.structure.properties.directions.minItems,3);
 assert.throws(()=>validateStageResult({spec:{durationSeconds:15}},{structure:{shots:[{durationSeconds:3}]}}),/时长/);
 assert.ok(!renderStage({facts:['USB'],assumptions:[],sellingPoints:[]}).includes('营销 Brief'));
});
test('selected direction binds stable artifact and version regardless of candidate ordering',()=>{
 const state=fresh(),task=createTask(state,goal([{}, {dependsOn:[0],spec:{selectedDirectionIndex:2}}]),'q'),source=addArtifact(state,{itemId:task.items[0].id,type:'text',content:'ALL DIRECTIONS',metadata:{structure:{directions:[{id:'d1',content:'one'},{id:'d2',content:'two'}]}},verification:{technical:'passed',semantic:'passed'}});
 const bound=bindStageSources(state,task.items[1])[0];assert.equal(bound.selectedDirection.id,'d2');assert.equal(bound.selectedDirection.artifactId,source.id);assert.equal(bound.selectedDirection.version,1);assert.equal(bound.content,undefined);assert.equal(bound.structure,undefined);
});
test('failed and superseded candidates cannot become downstream default or explicit sources',()=>{
 const state=fresh(),task=createTask(state,goal([{}, {dependsOn:[0]}]),'q'),source=addArtifact(state,{itemId:task.items[0].id,type:'text',content:'bad',verification:{technical:'passed',semantic:'failed'}});assert.deepEqual(resolveSources(state,task.items[1]),[]);task.items[1].references=[source.id];assert.throws(()=>resolveSources(state,task.items[1]),/验收/);
});
test('event payload and snapshot retain time-of-record values; failed turn has no old task result',()=>{
 const state=fresh(),task=createTask(state,goal([{}]),'q'),snapshot=taskSnapshot(state),event=immutableEvent(state,{type:'task_state',task:snapshot});task.items[0].status='COMPLETED';task.transitions.push({to:'COMPLETED'});assert.equal(event.task.items[0].status,'PENDING');assert.equal(snapshot.items[0].status,'PENDING');assert.equal(immutableEvent(state,{type:'final',taskId:null}).taskId,null);state.lastTurn={status:'failed'};state.status='completed';assert.equal(clientStatus(state),'failed');
});
test('runtime inquiries produce authoritative facts without creative model calls or submissions',async()=>{
 for(const operation of ['inspect_capabilities','inspect_quote','query_task']){const f=setup([{operation}],async()=>{throw Error('inquiries must read facts');});await f.agent.run(f.state,'inspect',()=>{},sig());assert.equal(f.state.status,'completed');const facts=currentTask(f.state).items[0].readReceipt.facts;assert.ok(facts.source);assert.equal(Object.keys(f.state.taskStore.artifacts).length,0);assert.equal(f.agent.finalResponses.length,0);assert.equal(Object.keys(f.state.taskStore.executions).length,0);if(operation==='inspect_quote'){assert.equal(facts.quote.total,null);assert.equal(facts.quote.canAuthorize,false);}}
});
test('required Skill uses actual loaded content, hashes, model links and stage-scoped input',async()=>{
 const f=setup([{requiredMethods:['product-understanding-zh-v1']}],async input=>{const payload=JSON.parse(input[1].content);assert.ok(payload.methods[0].content.length>100);assert.deepEqual(payload.facts,['USB供电','容量未知']);return reply({content:'ignored extra stages',structure:{facts:['USB供电'],assumptions:['容量未知'],sellingPoints:['桌面使用']}});});await f.agent.run(f.state,'request',()=>{},sig());const t=currentTask(f.state);assert.equal(t.status,'COMPLETED');const m=t.items[0].methods[0];assert.equal(m.contentHash.length,64);assert.equal(m.modelCallIds.length,1);assert.equal(m.outputArtifactIds.length,1);assert.ok(f.state.events.at(-1).text.includes('ignored extra stages'));assert.equal(f.state.modelCalls[0].nodeId,t.items[0].id);
});
test('model traces retain normalized transport and raw response with credentials redacted',async()=>{
 const state=fresh(),brain=tracedBrain(new DeepSeek({key:'sk-12345678901234567890',model:'test',baseUrl:'https://test.invalid'},async()=>new Response(JSON.stringify({id:'provider-1',output:reply({content:'ok'}),usage:{input_tokens:3}}))));
 await withTrace(state,async()=>{},()=>brain.respond([{role:'user',content:'source https://test.invalid/a?signature=secret sk-12345678901234567890'}],[],sig(),{json:true}));const call=state.modelCalls[0];assert.equal(call.providerResponse.id,'provider-1');assert.equal(call.normalizedRequest.model,'test');assert.ok(!JSON.stringify(call).includes('12345678901234567890'));assert.ok(!JSON.stringify(call).includes('signature=secret'));assert.equal(call.status,'returned');
});
test('concurrent model trace scopes do not cross session boundaries',async()=>{
 const a=fresh(),b=fresh(),brain=tracedBrain({respond:async input=>{await new Promise(r=>setTimeout(r,5));return reply({content:input[0].content});}});await Promise.all([withTrace(a,async()=>{},()=>brain.respond([{content:'A'}],[],sig())),withTrace(b,async()=>{},()=>brain.respond([{content:'B'}],[],sig()))]);assert.equal(a.modelCalls[0].input[0].content,'A');assert.equal(b.modelCalls[0].input[0].content,'B');assert.equal(a.modelCalls.length,1);
});
test('one answer can consume capability and quote sources without duplicating its output slot',()=>{
 const semantic={deliverables:[{kind:'text',action:'query',purpose:'general',requiredEvidence:'none'}]};
 const plan=validatePlan({routes:[{deliverableIndex:0,operation:'inspect_capabilities',skills:[]},{deliverableIndex:0,operation:'inspect_quote',skills:[]}]},semantic,catalog);assert.equal(plan.routes.length,1);assert.equal(plan.routes[0].operation,'inspect_runtime');
});
test('same request replays its outcome, an explicit new request with identical content creates new work',async()=>{
 let calls=0;const f=setup([{}],async()=>{calls++;return reply({content:'same'});}),events=[];
 await f.agent.run(f.state,'same',()=>{},sig(),{requestId:'request-A'});const task=currentTask(f.state).id;
 await f.agent.run(f.state,'same',e=>events.push(e),sig(),{requestId:'request-A'});assert.equal(calls,1);assert.equal(currentTask(f.state).id,task);assert.ok(events.some(e=>e.type==='final'));
 await assert.rejects(f.agent.run(f.state,'different',()=>{},sig(),{requestId:'request-A'}),/不同请求/);
 await f.agent.run(f.state,'same',()=>{},sig(),{requestId:'request-B'});assert.equal(calls,2);assert.notEqual(currentTask(f.state).id,task);
});
test('submission guard checks read-only permissions, frozen scope, unknown receipts and parameter identity',()=>{
 const state=fresh(),task=createTask(state,goal([{operation:'generate_image',output:'image'}]),'q'),item=task.items[0],args={prompt:'one'},slot='batch:0';acceptRevision(task,'r');
 task.contract.effects.mediaSubmissionAllowed=false;assert.throws(()=>guardSubmission(task,item,'generate_image',args),/只读/);task.contract.effects.mediaSubmissionAllowed=true;
 task.approval={required:true,status:'approved',revision:1,contractHash:task.contract.hash,payload:{itemId:item.id,tool:'generate_image',items:[{prompt:'different'}]}};assert.throws(()=>guardSubmission(task,item,'generate_image',args),/具体方案/);
 task.approval.required=false;const logical=guardSubmission(task,item,'generate_image',args,{slot});
 assert.throws(()=>guardSubmission(task,item,'generate_image',args,{slot,executions:[{logicalExecutionId:logical,status:'unknown'}]}),/受理状态未知/);
 assert.throws(()=>guardSubmission(task,item,'generate_image',{prompt:'new'},{slot,executions:[{logicalExecutionId:logical,status:'succeeded',parameterHash:fingerprint('generate_image',args)}]}),/修改参数/);
});
test('missing quote cannot be bypassed by continuing a partially delivered plan',async()=>{
 const f=setup([{operation:'inspect_quote'},{operation:'generate_image',output:'image',dependsOn:[0]}]);await f.agent.run(f.state,'quote then image',()=>{},sig());const t=currentTask(f.state);assert.equal(t.status,'BLOCKED');assert.equal(t.recovery.kind,'missing_quote');assert.equal(t.items[0].status,'COMPLETED');assert.equal(t.items[1].status,'BLOCKED');assert.equal(t.executionPlan.nodes[0].status,'completed');assert.equal(taskActions(t).canResume,false);await f.agent.run(f.state,'continue',()=>{},sig(),{resumeTaskId:t.id});assert.equal(Object.keys(f.state.taskStore.executions).length,0);assert.equal(currentTask(f.state).status,'BLOCKED');
});
test('multiple text files satisfy independent artifact slots even with identical bodies',async()=>{
 const f=setup([{artifactCount:3,contentCardinality:1}]);await f.agent.run(f.state,'three files',()=>{},sig());assert.equal(currentTask(f.state).status,'COMPLETED');assert.equal(Object.keys(f.state.taskStore.artifacts).length,3);assert.deepEqual(Object.values(f.state.taskStore.artifacts).map(a=>a.metadata.deliverySlot),[0,1,2]);
});
test('old graph migration preserves frozen batches and refuses a tampered graph',()=>{
 const state=fresh(),task=createTask(state,goal([{}]),'q'),g=compileGoal(task),shape=g.nodes.map(({id,dependsOn,kind,skillId,tool,output,count})=>({id,dependsOn,kind,skillId,tool,output,count}));task.executionPlan={version:1,goalHash:g.goalHash,graphHash:fingerprint('graph',shape),nodes:shape.map(n=>({...n,batchId:'frozen',revision:1}))};migrateGraph(task);validateGraph(task);assert.equal(task.executionPlan.version,2);assert.equal(task.executionPlan.nodes[0].batchId,'frozen');
 task.executionPlan={version:1,goalHash:g.goalHash,graphHash:'tampered',nodes:shape};assert.throws(()=>migrateGraph(task),/历史执行图/);
});
test('explicit resume target is independent of the current focus',async()=>{
 const f=setup([{}]),old=createTask(f.state,goal([{}]),'old unfinished'),focus=createTask(f.state,goal([{}]),'new focus');
 await f.agent.run(f.state,'resume old',()=>{},sig(),{resumeTaskId:old.id});assert.equal(currentTask(f.state).id,old.id);assert.equal(old.status,'COMPLETED');assert.equal(focus.items[0].status,'PENDING');assert.equal(f.state.turns[0].decision.operations[0].targetTaskId,old.id);
});
test('explicit cancellation retires the task without invoking a model or a media adapter',async()=>{
 const f=setup([{}],async()=>{throw Error('cancel must not generate');}),task=createTask(f.state,goal([{}]),'unfinished');
 f.agent.intake=async()=>({...task.goal,semantic:{...task.goal.semantic,continuation:{mode:'cancel',taskId:task.id}},cancelTaskId:task.id});await f.agent.run(f.state,'取消整个任务',()=>{},sig());assert.equal(task.status,'CANCELLED');assert.equal(task.cancelledByUser,true);assert.equal(taskActions(task).canResume,false);assert.equal(f.state.turns[0].decision.operations[0].operation,'cancel');assert.throws(()=>assertContract(task),/取消/);assert.equal(Object.keys(f.state.taskStore.executions).length,0);
});
test('schema repair identifies the exact forbidden field instead of repeating an opaque root error',async()=>{
 let calls=0;const semantic={summary:'hello',deliverables:[{description:'hello',kind:'text',count:1,action:'respond',purpose:'general',requiredEvidence:'none',references:[],dependsOn:[],constraints:[],requestEvidence:'hello'}],gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow'},approval:{required:false,reason:''},continuation:{mode:'new',taskId:''}};
 semantic.safety.untrustedInstructions=false;
 const brain={respond:async input=>{calls++;if(calls===1)return reply({...semantic,executionDefaults:{video:{durationSeconds:5}}});if(calls===2){assert.match(input.map(m=>m.content).join('\n'),/additionalProperty.*executionDefaults/);return reply(fieldPatchFor(input,semantic));}return reply({routes:[{deliverableIndex:0,operation:'answer',skills:[]}]});}};
 const g=await understandGoal(brain,catalog,{query:'hello',strictControl:true},sig());assert.equal(g.tasks[0].operation,'answer');assert.equal(calls,2);
});
test('schema codec recovers key whitespace without changing semantic values or overwriting collisions',()=>{
 const schema={properties:{facts:{},continuation:{properties:{mode:{}}}}},value={'fact s':['原文 空格保留'],continuation:{' mode ':'new'}};const changes=normalizeSchemaKeys(value,schema);assert.equal(changes.length,2);assert.deepEqual(value,{facts:['原文 空格保留'],continuation:{mode:'new'}});
 const collision={facts:['one'],'fact s':['different']};normalizeSchemaKeys(collision,schema);assert.deepEqual(collision,{facts:['one'],'fact s':['different']});
});

test('one final document executes four isolated stages and binds actual second direction',async()=>{
 const requiredMethods=['product-understanding-zh-v1','marketing-brief-zh-v1','direction-designer-zh-v1','storyboard-one-shot-zh-v2'],inputs=[];
 const outputs=[{facts:['USB'],assumptions:['容量未知'],sellingPoints:['桌面']},{audience:'桌面用户',hook:'桌面使用',brief:'USB桌面加湿器'},{directions:[{title:'一',content:'方向一'},{title:'二',content:'方向二'},{title:'三',content:'方向三'}],recommendation:'第二方向'},{shots:Array.from({length:5},()=>({content:'镜头',durationSeconds:3})),durationSeconds:15}];
 const f=setup([{operation:'storyboard',requiredMethods,artifactCount:1,count:1,spec:{directionCount:3,selectedDirectionIndex:2,shotCount:5,secondsPerShot:3,durationSeconds:15}}],async input=>{inputs.push(JSON.parse(input[1].content));const structure=outputs[inputs.length-1];return reply({...(!structure.directions&&!structure.shots?{content:'完整阶段正文'}:{}),structure});});
 await f.agent.run(f.state,'one assembled document',()=>{},sig());const t=currentTask(f.state),artifacts=Object.values(f.state.taskStore.artifacts),delivery=artifacts.filter(a=>a.purpose==='deliverable');
 assert.equal(t.status,'COMPLETED');assert.equal(inputs.length,4);assert.equal(delivery.length,1);assert.equal(delivery[0].metadata.stages.length,4);assert.equal(t.executionPlan.nodes[0].outputContract.stages.length,4);
 inputs.forEach((input,n)=>{assert.equal(input.deliveryContract.description,t.items[0].description);assert.deepEqual(input.methods.map(m=>m.slug),[requiredMethods[n]]);assert.equal(input.evidenceContext.query,'one assembled document');assert.equal(input.evidenceContext.role,'provenance_only');if(n)assert.ok(input.sources.some(s=>s.id===delivery[0].metadata.stages[n-1].artifactId));});
 const direction=artifacts.find(a=>a.metadata.structure?.directions),binding=inputs[3].sources.find(s=>s.selectedDirection);
 assert.equal(binding.selectedDirection.id,direction.metadata.structure.directions[1].id);assert.equal(binding.selectedDirection.version,direction.version);assert.equal(binding.content,undefined);assert.equal(binding.structure,undefined);
 assert.equal(methodSatisfied(t.items[0],delivery[0]),true);t.items[0].methods[3].inputArtifacts=[];reconcileTask(f.state);assert.notEqual(t.status,'COMPLETED');
});

test('collapsed skill labels cannot pass a permissive judge without stage lineage',()=>{
 const requiredMethods=['product-understanding-zh-v1','marketing-brief-zh-v1'];assert.throws(()=>stageSchema({requiredMethods,spec:{},count:1},catalog),/独立阶段/);
 const state=fresh(),t=createTask(state,goal([{requiredMethods}]),'collapsed'),i=t.items[0];t.validationPolicy='strict';
 const a=addArtifact(state,{itemId:i.id,type:'text',content:'all stages in one model call',verification:{technical:'passed',semantic:'passed'}});
 i.methods=requiredMethods.map(skillId=>({skillId,status:'validated',contentHash:'hash',contractValidated:true,outputArtifactIds:[a.id]}));reconcileTask(state);assert.notEqual(t.status,'COMPLETED');
});

test('deferred promised media cannot become a completed text-only contract even with zero scope audit',()=>{
 const state=fresh(),g=goal([{}]);g.semantic.approval.required=true;g.semantic.deferred=['正式生成白色杯子图片，用户确认后执行'];g.requestContract={media:{image:0,video:0,audio:0},systemFacts:[],readOnly:false};
 const t=createTask(state,g,'先方案报价确认后生成'),i=t.items[0];t.validationPolicy='strict';addArtifact(state,{itemId:i.id,type:'text',content:'方案完成',verification:{technical:'passed',semantic:'passed'}});reconcileTask(state);
 assert.equal(t.status,'BLOCKED');assert.equal(t.recovery.kind,'unresolved_scope');assert.match(t.reason,/延期要求/);
 delete t.goal.semantic.deferred;reconcileTask(state);assert.equal(t.status,'BLOCKED');assert.match(t.reason,/确认后的交付义务/);
});

test('control decisions without a known target are rejected before acceptance',async()=>{
 assert.throws(()=>acceptDecision({rawInput:'q'}, {...goal([{}]),semantic:{continuation:{mode:'continue',taskId:''}}},null),/真实目标/);
 let calls=0;const semantic={summary:'q',deliverables:[],gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false},approval:{required:false,reason:''},continuation:{mode:'continue',taskId:''}};
 await assert.rejects(()=>understandGoal({respond:async()=>{calls++;return reply(semantic);}},catalog,{query:'q',strictControl:true,auditContracts:true},sig()),/真实目标任务/);assert.equal(calls,3);
});

test('a selected direction with no actual source cannot reach the quality judge',async()=>{
 let calls=0;const f=setup([{operation:'storyboard',requiredMethods:['storyboard-one-shot-zh-v2'],spec:{selectedDirectionIndex:2}}],async()=>{calls++;return reply({content:'基于第二方向',structure:{shots:[],durationSeconds:15}});});
 await f.agent.run(f.state,'q',()=>{},sig());assert.equal(calls,0);assert.equal(currentTask(f.state).status,'BLOCKED');
});

test('global selected-direction spec applies to consumers, not product and direction producers',async()=>{
 const required=['product-understanding-zh-v1','marketing-brief-zh-v1','direction-designer-zh-v1','storyboard-one-shot-zh-v2'],inputs=[];
 const structures=[{facts:['USB'],assumptions:[],sellingPoints:[]},{audience:'桌面',hook:'USB',brief:'brief'},{directions:[{title:'1',content:'a'},{title:'2',content:'b'},{title:'3',content:'c'}],recommendation:'2'},{shots:Array.from({length:5},()=>({content:'shot',durationSeconds:3})),durationSeconds:15}];
 const f=setup(required.map((slug,n)=>({operation:n===3?'storyboard':'answer',requiredMethods:[slug],count:n===2?3:1,contentCardinality:n===2?3:1,dependsOn:n?[n-1]:[],spec:{directionCount:3,selectedDirectionIndex:2,shotCount:5,secondsPerShot:3,durationSeconds:15}})),async input=>{inputs.push(JSON.parse(input[1].content));const structure=structures[inputs.length-1];return reply({...(!structure.directions&&!structure.shots?{content:'完整阶段正文'}:{}),structure});});
 await f.agent.run(f.state,'four stages',()=>{},sig());assert.equal(currentTask(f.state).status,'COMPLETED');assert.equal(inputs.length,4);for(const input of inputs.slice(0,3))assert.equal(input.item.spec.selectedDirectionIndex,2);assert.equal(inputs[3].sources.find(s=>s.selectedDirection).selectedDirection.index,2);
});

test('pre-workflow version-two graphs migrate without changing frozen media batches',()=>{
 const state=fresh(),t=createTask(state,goal([{operation:'generate_image',output:'image'}]),'q');const old=compileGoal(t);for(const n of old.nodes){delete n.outputContract.stages;n.batchId='existing-batch';n.revision=1;}
 old.graphHash=fingerprint('graph',old.nodes.map(({id,dependsOn,kind,skillId,tool,output,count,requiredMethods,outputContract})=>({id,dependsOn,kind,skillId,tool,output,count,requiredMethods,outputContract})));t.executionPlan=old;
 migrateGraph(t);validateGraph(t);assert.equal(t.executionPlan.nodes[0].batchId,'existing-batch');assert.deepEqual(t.executionPlan.nodes[0].outputContract.stages,[]);
});

test('independent scope audit cannot interpret pending approval as zero future media',async()=>{
 const semantic={summary:'先方案后图片',deliverables:[{description:'cup image',kind:'image',count:1,action:'create',purpose:'marketing',requiredEvidence:'none',references:[],dependsOn:[],constraints:[],requestEvidence:'确认后生成图片'}],gaps:[],assumptions:[],deferred:[],facts:[],globalConstraints:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false},approval:{required:true,reason:'确认后生成'},continuation:{mode:'new',taskId:''}};
 let n=0;const brain={respond:async()=>{n++;return reply(n===1?semantic:n===2?{required:true,evidence:'确认后生成'}:{media:{image:0,video:0,audio:0},requiredMethods:[],systemFacts:['quote'],readOnly:false,evidence:'现在未确认所以0'});}};
 const g=await understandGoal(brain,catalog,{query:'确认后生成图片',strictControl:true,auditContracts:true},sig());assert.equal(n,1);assert.equal(g.requestContract.media.image,1);assert.equal(g.semantic.approval.required,true);assert.equal(g.requestContract.currentPermission.mediaSubmission,'requires_revision_bound_approval');
});

test('typed document counts compile without asking the model to recopy a legacy counter',async()=>{
 const semantic={summary:'one document, three directions',deliverables:[{description:'directions',kind:'text',count:3,artifactCount:1,contentCardinality:3,action:'create',purpose:'marketing',requiredEvidence:'none',references:[],dependsOn:[],constraints:[],requestEvidence:'three directions',requiredMethods:['direction-designer-zh-v1']}],gaps:[],assumptions:[],deferred:[],facts:[],globalConstraints:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false},approval:{required:false,reason:''},continuation:{mode:'new',taskId:''}};
 let n=0;const brain={respond:async()=>reply(++n===1?semantic:n===2?{media:{image:0,video:0,audio:0},requiredMethods:[],systemFacts:[],textFileCount:null,readOnly:false,evidence:'text only'}:{routes:[{deliverableIndex:0,operation:'marketing_script',skills:['direction-designer-zh-v1']}]})};
 const g=await understandGoal(brain,catalog,{query:'one document, three directions using direction-designer-zh-v1',strictControl:true,auditContracts:true},sig());assert.equal(g.tasks[0].artifactCount,1);assert.equal(g.tasks[0].contentCardinality,3);assert.equal(g.tasks[0].count,3);assert.equal(n,1);
});
import {reviseFactRequirements} from '../server/fact-revision.mjs';
import {canonicalReferences} from '../server/sources.mjs';

test('fact revision removes a cancelled quote while preserving unrelated obligations',()=>{
 const previous=['quote','task_state'];assert.deepEqual(reviseFactRequirements(previous,{add:[],remove:[{source:'quote',evidence:'取消报价'}]},'取消报价，其他不变'),['task_state']);assert.deepEqual(previous,['quote','task_state']);
 assert.deepEqual(reviseFactRequirements(previous,{add:[],remove:[]},'改为红色'),previous);
 assert.throws(()=>reviseFactRequirements(previous,undefined,'取消报价'),/factChanges/);
 assert.throws(()=>reviseFactRequirements(previous,{add:[],remove:[{source:'quote',evidence:'取消报价'}]},'改为红色'),/原文依据/);
});

test('typed task source resolves one accepted artifact and rejects ambiguous versions',()=>{
 const taskId='11111111-1111-1111-1111-111111111111',a={id:'image-a',taskId,purpose:'deliverable',publication:'current',verification:{technical:'passed',semantic:'passed'}};
 assert.deepEqual(canonicalReferences(['image-a','task:'+taskId],[a]),['image-a']);
 assert.throws(()=>canonicalReferences(['task:'+taskId],[a,{...a,id:'image-b'}]),/唯一/);
 assert.throws(()=>canonicalReferences(['task:'+taskId],[{...a,publication:'audit'}]),/唯一/);
});

test('runtime fact requests use registry evidence without giving deployment failures to intake',async()=>{
 const semantic={turnOperation:{kind:'inspect',query:{kind:'capabilities',includeQuote:true}},summary:'capabilities and quote',deliverables:[{description:'tools schema and quote',kind:'text',count:1,action:'query',purpose:'general',requiredEvidence:'runtime',references:[],dependsOn:[],constraints:[],requestEvidence:'actual tools schema and quote'}],gaps:[],assumptions:[],deferred:[],facts:[],globalConstraints:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false},approval:{required:false,reason:''},continuation:{mode:'new',taskId:''}};
 let n=0;const brain={respond:async input=>{n++;if(n===1)assert.equal(JSON.parse(input[1].content).runtimeFacts,undefined);return reply(n===1?semantic:n===2?{media:{image:0,video:0,audio:0},requiredMethods:[],systemFacts:['capabilities','quote'],readOnly:true,evidence:'only query'}:{routes:[{deliverableIndex:0,operation:'inspect_capabilities',skills:[]}]});}};
 const g=await understandGoal(brain,catalog,{query:'actual tools schema and quote, only query',strictControl:true,auditContracts:true,runtimeFacts:{entries:[],skills:[],quote:{status:'unavailable'}}},sig());assert.equal(g.tasks[0].operation,'inspect_runtime');assert.equal(g.tasks[0].requiredEvidence,'runtime');assert.equal(n,1);
});
import {specializeMediaSchema,restoreContractConstants} from '../server/goal-compiler.mjs';
import {mediaSkillFor} from '../server/media-skill-contracts.mjs';

test('an image edit sends contract-owned reference URLs even when model omits or changes them',()=>{
 const source='https://fixtures.invalid/original.png',schema=specializeMediaSchema(mediaSkillFor('edit_image'),{spec:{ratio:'1:1'}},1,null,[source]);
 for(const args of [{prompt:'edit'},{prompt:'edit',referenceImages:['https://fixtures.invalid/wrong.png']}]){const result=restoreContractConstants({items:[args]},schema);assert.deepEqual(result.items[0].referenceImages,[source]);assert.equal(result.items[0].prompt,'edit');}
});

test('global explicit methods receive concrete route ownership before contract acceptance',async()=>{
 const requiredMethods=['product-understanding-zh-v1','marketing-brief-zh-v1','direction-designer-zh-v1','storyboard-one-shot-zh-v2'];
 const semantic={summary:'one workflow document',requiredMethods,deliverables:[{description:'one workflow document',kind:'text',count:1,artifactCount:1,contentCardinality:1,spec:{directionCount:3},action:'create',purpose:'marketing',requiredEvidence:'none',references:[],dependsOn:[],constraints:[],requestEvidence:'one workflow document'}],gaps:[],assumptions:[],deferred:[],facts:[],globalConstraints:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false},approval:{required:false,reason:''},continuation:{mode:'new',taskId:''}};
 let n=0;const brain={respond:async()=>reply(++n===1?semantic:n===2?{media:{image:0,video:0,audio:0},requiredMethods,textFileCount:1,systemFacts:[],readOnly:false,evidence:'text only'}:{routes:[{deliverableIndex:0,operation:'storyboard',skills:requiredMethods}]})};
 const g=await understandGoal(brain,catalog,{query:'one workflow document using '+requiredMethods.join(', '),strictControl:true,auditContracts:true},sig());assert.deepEqual(g.tasks[0].requiredMethods,requiredMethods);assert.equal(n,1);
});
