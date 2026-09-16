import test from 'node:test';
import assert from 'node:assert/strict';
import {loadCatalog} from '../server/catalog.mjs';
import {understandGoal} from '../server/intent.mjs';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
import {currentTask,taskArtifacts,taskSnapshot} from '../server/task-state.mjs';
import {buildActionContext} from '../server/action-context.mjs';
import {projectBusinessActions,actionOrder} from '../server/business-action.mjs';
import {revisionTarget} from '../server/turn-operation.mjs';
import {requestAssembly} from '../server/debug-session-view.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const safety={disposition:'allow',untrustedInstructions:false,reason:''};
const reply=x=>[{type:'message',content:[{type:'output_text',text:typeof x==='string'?x:JSON.stringify(x)}]}];
const action=(actionType,extra={})=>({id:'a1',actionType,intent:'用户的业务要求',...extra});
const request=(...businessActions)=>({summary:'当前用户要求',businessActions,safety});
const image={id:'saved-image',assetId:'saved-image',type:'image',kind:'image',url:'https://example.com/source.png',version:2};
const target={type:'IMAGE',id:image.id,version:image.version};
async function understand(raw,options={},respond){let calls=0;const goal=await understandGoal({respond:async(...args)=>{calls++;return respond?respond(...args,calls):reply(raw);}},catalog,{query:'当前用户要求',assets:[image],actionMode:'core',strictControl:true,auditContracts:true,...options},signal());return {goal,calls};}
function runtimeFixture({mode='core',failEdit=false,approvalDecision='approve'}={}){
 const state={id:'action-e2e',messages:[],events:[],assets:[]},calls=[],submissions=[];let command,editFailure=failEdit;
 const brain={respond:async(input,tools,_signal,options)=>{
  calls.push({phase:options?.tracePhase,input:structuredClone(input)});assert.equal(tools.length,0);
  if(options?.tracePhase==='understand')return reply(typeof command==='function'?command(JSON.parse(input[1].content)):command);
  if(options?.tracePhase==='observe_image'){assert.ok(input[1].content.some(p=>p.type==='input_image'));return reply('已观察当前提供图片。');}
  if(options?.tracePhase==='final_response')return reply('依据已记录结果回答。');
  if(options?.tracePhase==='verify_turn_operation')return reply({operation:approvalDecision,evidence:'local fixture decision'});
  const payload=JSON.parse(input[1].content);
  if(options?.tracePhase==='media_plan')return reply({concept:'当前画面',preservedConstraints:[],safety:{passed:true,reason:'普通产品图'},items:Array.from({length:payload.goal.count},()=>({prompt:'product picture',size:'2048x2048',...(payload.goal.references.length?{referenceImages:payload.goal.references}:{})}))});
  throw Error('unexpected model phase '+options?.tracePhase);
 }};
 const media={config:{imageModel:'local-fixture'},image:async args=>{submissions.push(structuredClone(args));if(editFailure&&args.referenceImages?.length)return {isError:true,status:'failed',text:'known fixture failure'};return {status:'succeeded',images:[{url:'https://example.com/action-'+submissions.length+'.png',size:'2048x2048'}]};}};
 const runtime=new ToolRuntime({catalog,brain,media}),agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,actionMode:mode,verifier:new Verifier(brain,{policy:'delivery_only'})});
 return {state,agent,calls,submissions,run:async(raw,query='当前用户要求',control={})=>{command=raw;await agent.run(state,query,()=>{},signal(),control);},allowEdit:()=>{editFailure=false;}};
}
test('pilot: EDIT_IMAGE compiles target, modification, revision and existing executor fields',async()=>{
 const raw=request(action('EDIT_IMAGE',{target,modification:{change:['背景改红'],preserve:['瓶身不变']}}));
 const {goal,calls}=await understand(raw,{actionMode:'image_edit'});
 assert.equal(calls,1);assert.equal(goal.businessAction.mode,'action_compiled');
 assert.equal(goal.tasks[0].operation,'edit_image');assert.equal(goal.tasks[0].requiredEvidence,'none');
 assert.equal(goal.tasks[0].referenceBindings[0].version,2);assert.equal(goal.tasks[0].changeContract.change[0],'背景改红');
 assert.equal(goal.businessAction.actions[0].requiredEvidence,undefined);assert.equal(goal.businessAction.actions[0].tool,undefined);
});
test('pilot: sequential native create and edit execute one revision with the exact parent image',async()=>{
 const f=runtimeFixture();await f.run(request(action('CREATE_IMAGE')));
 const first=taskArtifacts(f.state).find(a=>a.type==='image');assert.ok(first);
 f.agent.actionMode='image_edit';
 await f.run(request(action('EDIT_IMAGE',{target:{type:'IMAGE',id:first.id,version:first.version},modification:{change:['背景改红'],preserve:['主体不变']}})));
 const task=currentTask(f.state),revision=taskArtifacts(f.state).find(a=>a.type==='image');
 assert.equal(task.status,'COMPLETED');assert.equal(f.submissions.length,2);
 assert.deepEqual(f.submissions[1].referenceImages,[first.url]);assert.equal(revision.parentArtifact,first.id);assert.equal(revision.version,2);
 assert.equal(task.goal.businessAction.mode,'action_compiled');assert.equal(task.requirements.length,1);
 const phases=f.calls.map(c=>c.phase);assert.equal(phases.filter(p=>p==='understand').length,2);assert.equal(phases.filter(p=>p==='media_plan').length,2);
});
test('core: ANALYZE_IMAGE derives observation with no evidence flag, task creation or media submission',async()=>{
 const f=runtimeFixture();f.state.assets=[image];await f.run(request(action('ANALYZE_IMAGE',{target})));
 assert.equal(f.state.events.at(-1).status,'completed');assert.equal(f.submissions.length,0);assert.equal(Object.keys(f.state.taskStore.tasks).length,0);
 assert.equal(f.calls.filter(c=>c.phase==='observe_image').length,1);
 assert.equal(f.state.turns.at(-1).businessAction.actions[0].actionType,'ANALYZE_IMAGE');
 assert.equal(f.state.turns.at(-1).queryReceipt.facts.observations[0].version,2);
});
test('core: CREATE_VIDEO maps declared count and duration without invoking video production',async()=>{
 const {goal,calls}=await understand(request(action('CREATE_VIDEO',{expectedOutput:{count:2},parameters:{durationSeconds:5,ratio:'9:16'}})));
 assert.equal(calls,1);assert.equal(goal.tasks[0].operation,'generate_video');assert.equal(goal.tasks[0].count,2);
 assert.deepEqual(goal.requestContract.media,{image:0,video:2,audio:0});assert.equal(goal.tasks[0].spec.ratio,'9:16');
});
test('core: input bindings produce stable DAG edges without a model-generated execution graph',async()=>{
 const edit=action('EDIT_IMAGE',{id:'edit',target:{type:'ACTION_OUTPUT',actionId:'create'},modification:{change:['背景改室外'],preserve:['主体']}});
 const create=action('CREATE_IMAGE',{id:'create'}),other=action('CREATE_IMAGE',{id:'independent',intent:'另一个独立画面'});
 const {goal}=await understand(request(edit,create,other));
 assert.deepEqual(goal.businessAction.actions.map(a=>a.id),['create','edit','independent']);
 assert.deepEqual(goal.tasks.map(t=>t.dependsOn),[[],[0],[]]);assert.deepEqual(goal.tasks[1].references,['task:0']);
 assert.equal(goal.intentSnapshot.deliverables.length,3);
});
test('core: dependent outputs both execute and preserve the two original requirements',async()=>{
 const f=runtimeFixture();await f.run(request(action('CREATE_IMAGE'),action('EDIT_IMAGE',{id:'a2',intent:'修改第一张背景',target:{type:'ACTION_OUTPUT',actionId:'a1'},modification:{change:['背景改室外'],preserve:['主体']}})));
 const task=currentTask(f.state),images=taskArtifacts(f.state).filter(a=>a.type==='image');
 assert.equal(task.status,'COMPLETED');assert.equal(images.length,2);assert.equal(images[1].parentArtifact,images[0].id);
 assert.deepEqual(task.requirements.map(r=>r.status),['fulfilled','fulfilled']);assert.equal(task.executionPlan.nodes[1].dependsOn[0],task.items[0].id);
});
test('core: partial failure remains pending and explicit resume does not resubmit the first output',async()=>{
 const f=runtimeFixture({failEdit:true});await f.run(request(action('CREATE_IMAGE'),action('EDIT_IMAGE',{id:'a2',intent:'修改背景',target:{type:'ACTION_OUTPUT',actionId:'a1'},modification:{change:['背景'],preserve:['主体']}})));
 const task=currentTask(f.state);assert.equal(task.status,'PENDING');assert.deepEqual(task.requirements.map(r=>r.status),['fulfilled','pending']);
 f.allowEdit();await f.run(null,'继续',{resumeTaskId:task.id});
 assert.equal(task.status,'COMPLETED');assert.equal(f.submissions.filter(a=>!a.referenceImages?.length).length,1);assert.equal(Object.keys(f.state.taskStore.tasks).length,1);
});
test('core: confirmation binds the saved proposal and resumes without replanning',async()=>{
 const f=runtimeFixture();await f.run(request(action('CREATE_IMAGE',{confirmation:true,confirmationEvidence:'先确认'})),'先确认');
 const task=currentTask(f.state);assert.equal(task.status,'WAIT_CONFIRM');assert.equal(f.submissions.length,0);
 const modelPlans=f.calls.filter(c=>c.phase==='media_plan').length;
 await f.run(context=>{assert.ok(context.activeTaskState.confirmation);return request(action('CONFIRM_ARTIFACT',{target:context.activeTaskState.confirmation,intent:'确认保存方案'}));},'确认');
 assert.equal(task.status,'COMPLETED');assert.equal(f.submissions.length,1);assert.equal(f.calls.filter(c=>c.phase==='media_plan').length,modelPlans);
 assert.equal(f.calls.filter(c=>c.phase==='verify_turn_operation').length,1);assert.equal(Object.keys(f.state.taskStore.tasks).length,1);
 assert.equal(f.state.turns.at(-1).businessAction.actions[0].actionType,'CONFIRM_ARTIFACT');
});
test('core: a valid saved proposal does not bypass the existing natural-language approval guard',async()=>{
 const f=runtimeFixture({approvalDecision:'inspect'});
 await f.run(request(action('CREATE_IMAGE',{confirmation:true,confirmationEvidence:'先确认'})),'先确认');
 const task=currentTask(f.state);
 await f.run(context=>request(action('CONFIRM_ARTIFACT',{target:context.activeTaskState.confirmation})),'这个方案是什么');
 assert.equal(f.calls.filter(c=>c.phase==='verify_turn_operation').length,1);
 assert.equal(f.submissions.length,0);assert.equal(task.status,'WAIT_CONFIRM');assert.equal(task.approval.status,'pending');
 assert.match(f.state.turns.at(-1).error||'',/批准意图核对/);
});
test('core: expired confirmation, confirmation with modifications and wrong target versions are refused',async()=>{
 const f=runtimeFixture();await f.run(request(action('CREATE_IMAGE',{confirmation:true,confirmationEvidence:'先确认'})),'先确认');
 const task=currentTask(f.state),saved=taskSnapshot(f.state),proposal=revisionTarget(saved);
 const binding={type:'PROPOSAL',id:proposal.targetArtifactId,version:proposal.targetVersion,taskId:task.id,taskRevision:task.revision,planHash:task.approval.planHash};
 const candidates=[{...task,artifacts:taskArtifacts(f.state)}];
 for(const change of [{target:{...binding,planHash:'stale'}},{target:binding,parameters:{ratio:'9:16'}},{target:{...binding,version:99}}]){
  await assert.rejects(understand(request(action('CONFIRM_ARTIFACT',change)),{taskSnapshot:saved,taskCandidates:candidates}),/批准|版本/);
 }
 assert.equal(f.submissions.length,0);assert.equal(task.approval.status,'pending');
});
test('core: action field repair preserves both deliveries, target and dependency',async()=>{
 const raw=request(action('CREATE_IMAGE',{expectedOutput:{count:1}}),action('EDIT_IMAGE',{id:'a2',intent:'第二张修改',target:{type:'ACTION_OUTPUT',actionId:'a1'},modification:{change:['背景'],preserve:['主体']}}));delete raw.safety;
 const {goal,calls}=await understand(raw,{},async(input,_tools,_signal,_options,n)=>{
  if(n===1)return reply(raw);const p=JSON.parse(input[1].content);assert.equal(p.lockedDraft.businessActions.length,2);
  return reply(Object.fromEntries(p.paths.map(path=>[p.fieldKeys[path],safety])));
 });
 assert.equal(calls,2);assert.equal(goal.tasks.length,2);assert.deepEqual(goal.tasks[1].dependsOn,[0]);assert.equal(goal.intentSnapshot.deliverables.length,2);
});
test('core: repair refuses whole-plan replacement and preserves undeclared-tool boundary',async()=>{
 const raw=request(action('CREATE_IMAGE',{tool:'generate_video'}));let seen=0;
 const {goal}=await understand(raw,{},async(input,_tools,_signal,_options,n)=>{seen=n;if(n===1)return reply(raw);const p=JSON.parse(input[1].content);assert.deepEqual(p.removePaths,['/businessActions/0/tool']);return reply(Object.fromEntries(p.paths.map(path=>[p.fieldKeys[path],null])));});
 assert.equal(seen,2);assert.equal(goal.tasks[0].operation,'generate_image');
 await assert.rejects(understand({...raw,safety:undefined},{},async(_i,_t,_s,_o,n)=>reply(n===1?raw:request(action('CREATE_VIDEO')))),/补丁|合同|结构/);
});
test('core: invalid cycles and invented broad workflows cannot silently drop obligations',async()=>{
 assert.throws(()=>actionOrder([action('EDIT_IMAGE',{target:{type:'ACTION_OUTPUT',actionId:'a1'}})]),/循环/);
 await assert.rejects(understand(request(action('CREATE_ADVERTISEMENT'))),/未注册|合同|格式/);
});
test('core: selected image version and session scope are still hard boundaries',async()=>{
 await assert.rejects(understand(request(action('EDIT_IMAGE',{target:{...target,version:9},modification:{change:['背景'],preserve:[]}}))),/版本/);
 await assert.rejects(understand(request(action('ANALYZE_IMAGE',{target})),{sessionId:'this-session',assets:[{...image,sessionId:'another-session'}]}),/不存在|过期/);
});
test('shadow: legacy draft executes unchanged and records registry comparison without a second model call',async()=>{
 const raw={summary:'生成两张图片',turnOperation:{kind:'create'},deliverables:[{description:'两张图片',kind:'image',action:'create',count:2}],approval:{required:false,reason:''},safety};
 const {goal,calls}=await understand(raw,{actionMode:'shadow'});assert.equal(calls,1);assert.equal(goal.tasks[0].count,2);assert.equal(goal.businessAction.mode,'shadow');assert.equal(goal.businessAction.mappings[0].derived.operation,'generate_image');
});
test('core: text and media mixed requests keep the compatibility route and every obligation',async()=>{
 const raw={summary:'脚本与图片',turnOperation:{kind:'create'},deliverables:[{description:'宣传脚本',kind:'text',action:'create',form:'script'},{description:'宣传图片',kind:'image',action:'create',count:1,dependsOn:[0],references:['task:0']}],approval:{required:false,reason:''},safety};
 const {goal,calls}=await understand(raw);assert.equal(calls,1);assert.equal(goal.tasks.length,2);assert.equal(goal.businessAction.mode,'shadow');assert.equal(goal.businessAction.unsupported.length,1);assert.deepEqual(goal.tasks[1].dependsOn,[0]);
});
test('context: three layers preserve source IDs and exact history without whole task/artifact duplication',async()=>{
 let payload;
 await understand(request(action('ANALYZE_IMAGE',{target})),{messages:[{messageId:'m1',role:'assistant',content:'exact historical answer'}]},async(input)=>{payload=JSON.parse(input[1].content);return reply(request(action('ANALYZE_IMAGE',{target})));});
 assert.deepEqual(payload.userMemory,[]);assert.equal(payload.activeTaskState,null);assert.equal(payload.assets,undefined);assert.equal(payload.taskIndex,undefined);assert.equal(payload.taskSnapshot,undefined);
 assert.equal(payload.relevantEvidence.references[0].id,image.id);assert.equal(payload.relevantEvidence.conversation.recentMessages[0].content,'exact historical answer');
 assert.equal(payload.relevantEvidence.references[0].url,undefined,'executor loads the real URL after binding');
});
test('context: only explicitly confirmed session memory is passed; inferred account facts are excluded',()=>{
 const payload={query:'q',referenceCatalog:{entries:[]},conversation:{recentMessages:[],messageIndex:[{messageId:'user-m1',role:'user'}],recentAttempts:[]}};
 const memory=[{scope:'session',confirmedByUser:true,sourceMessageId:'user-m1',value:'喜欢简洁风格'},{scope:'session',value:'模型猜测的品牌'},{scope:'account',confirmedByUser:true,sourceMessageId:'other',value:'另一个账号'}];
 assert.deepEqual(buildActionContext(payload,{userMemory:memory}).userMemory,[memory[0]]);
});
test('core: missing target version is field-repaired without reselecting its image',async()=>{
 const raw=request(action('EDIT_IMAGE',{target:{type:'IMAGE',id:image.id},modification:{change:['背景'],preserve:['主体']}}));
 const {goal,calls}=await understand(raw,{},async(input,_t,_s,_o,n)=>{
  if(n===1)return reply(raw);const p=JSON.parse(input[1].content);assert.deepEqual(p.paths,['/businessActions/0/target/version']);
  return reply({[p.fieldKeys[p.paths[0]]]:2});
 });
 assert.equal(calls,2);assert.equal(goal.tasks[0].referenceBindings[0].id,image.id);assert.equal(goal.tasks[0].referenceBindings[0].version,2);
});
test('core: a multi-output predecessor cannot silently become its first image',async()=>{
 await assert.rejects(understand(request(action('CREATE_IMAGE',{expectedOutput:{count:2}}),action('EDIT_IMAGE',{id:'a2',target:{type:'ACTION_OUTPUT',actionId:'a1'},modification:{change:['颜色'],preserve:[]}}))),/多个候选/);
});
test('core: confirmation survives JSON reload and duplicate requests reuse recorded results',async()=>{
 const f=runtimeFixture();await f.run(request(action('CREATE_IMAGE',{confirmation:true,confirmationEvidence:'先确认'})),'先确认');
 Object.assign(f.state,JSON.parse(JSON.stringify(f.state)));
 const control={requestId:'request-confirm-reloaded'};
 const command=context=>request(action('CONFIRM_ARTIFACT',{target:context.activeTaskState.confirmation}));
 await f.run(command,'确认',control);assert.equal(currentTask(f.state).status,'COMPLETED');
 const calls=f.calls.length;await f.run(command,'确认',control);assert.equal(f.submissions.length,1);assert.equal(f.calls.length,calls);
});
test('core: asynchronous video produces a real-shaped receipt and artifact with an offline provider',async()=>{
 const state={id:'action-video',messages:[],events:[]},submissions=[],polls=[];
 const brain={respond:async(input,_tools,_signal,options)=>{
  if(options.tracePhase==='understand')return reply(request(action('CREATE_VIDEO',{parameters:{durationSeconds:5,ratio:'16:9'}})));
  if(options.tracePhase==='final_response')return reply('视频结果已返回。');
  assert.equal(options.tracePhase,'media_plan');return reply({concept:'产品视频',preservedConstraints:[],safety:{passed:true,reason:'普通产品'},items:[{prompt:'product movie',duration:5,ratio:'16:9'}]});
 }};
 const media={config:{videoModel:'offline'},video:async args=>{submissions.push(args);return {taskId:'offline-job',status:'queued'};},getVideo:async id=>{polls.push(id);return {taskId:id,status:'succeeded',videoUrl:'https://example.com/offline-video.mp4',metadata:{duration:5,ratio:'16:9'}};}};
 const runtime=new ToolRuntime({brain,catalog,media});
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,actionMode:'core',verifier:new Verifier(brain,{policy:'delivery_only'})}).run(state,'产品宣传视频',()=>{},signal());
 assert.equal(submissions.length,1);assert.ok(polls.length>=1);assert.equal(currentTask(state).status,'COMPLETED');
 const artifact=taskArtifacts(state).find(a=>a.type==='video');assert.ok(artifact.sourceExecutionId);assert.equal(state.taskStore.executions[artifact.sourceExecutionId].status,'succeeded');
});
test('debug: history comes from the actual nested context rather than being reconstructed',()=>{
 const conversation={recentMessages:[{messageId:'m',role:'assistant',content:'literal prior answer'}]};
 const call={normalizedRequest:{input:[{role:'user',content:JSON.stringify({query:'q',activeTaskState:null,relevantEvidence:{conversation}})}]}};
 const assembly=requestAssembly(call);assert.equal(assembly.source,'actual_request');assert.deepEqual(assembly.conversation,conversation);
});
