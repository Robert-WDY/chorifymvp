import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Retain legacy ReAct protocol coverage independently of the compiled runtime tests.
import {LegacyAgent as Agent} from './runtime-model-fixture.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {TaskExecutor} from '../server/execution-engine.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {currentTask,createTask,storeOf,taskArtifacts,approveTask,transition,reconcileTask} from '../server/task-state.mjs';
import {SessionStore} from '../server/session-store.mjs';
import {refreshTasks} from '../server/task-monitor.mjs';
import {understandGoal} from './intake-compat.mjs';
import {validateSemantic} from '../server/intent.mjs';
import {Verifier} from '../server/verification.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const call=(name,args)=>({type:'function_call',call_id:Math.random().toString(),name,arguments:JSON.stringify(args)});
const answer=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const plan=()=>call('update_plan',{summary:'完成创作',steps:[{title:'完成当前交付',status:'running'}]});
const goal=(tasks,approval=false)=>({summary:'完成测试目标',mode:'create',tasks:tasks.map(t=>({count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none',...t})),skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow',reason:'',untrustedInstructions:false},semantic:{approval:{required:approval},deliverables:tasks.map(t=>({description:t.description||t.operation}))}});
function setup(g,responder,{verifier=null,save=async()=>{}}={}){
 let serial=0;const submitted=[],queries=[],requests=[],jobs=new Map(),state={id:'12345678-1234-4234-8234-123456789012',messages:[],events:[]};
 const brain={respond:async(input,tools,sig,options)=>{requests.push({input:structuredClone(input),tools});return responder({state,input,tools,options});}};
 const media={config:{imageModel:'mock',videoModel:'mock'},image:async args=>{submitted.push(args);return{status:'succeeded',images:[{url:'https://example.com/image-'+ ++serial+'.png'}],simulated:true};},video:async args=>{submitted.push(args);const taskId='job-'+ ++serial;jobs.set(taskId,{taskId,status:'succeeded',videoUrl:'https://example.com/'+taskId+'.mp4',simulated:true});return{taskId,status:'queued',simulated:true};},getVideo:async id=>{queries.push(id);return jobs.get(id);}};
 const runtime=new ToolRuntime({catalog,brain,media,waitMs:1,pollMs:1}),agent=new Agent({effectPolicy:'trusted_embedder',catalog,brain,runtime,verifier,save,intake:async()=>g,maxSteps:8});
 return{state,runtime,agent,submitted,queries,requests,jobs,run:control=>agent.run(state,'测试用户需求',()=>{},signal(),control)};
}
test('10 videos: one durable batch submits and queries all jobs within 4 model decisions',async()=>{
 let turn=0;const f=setup(goal([{operation:'generate_video',output:'video',count:10}]),({state})=>{
  turn++;if(turn===1)return[plan()];if(turn===2)return[call('propose_video_batch',{items:Array.from({length:10},(_,i)=>({prompt:'创意'+i,duration:5}))})];if(turn===3)return[call('execute_batch',{batchId:Object.keys(currentTask(state).batches)[0]})];return[answer('十条视频完成')];});
 await f.run();assert.equal(f.state.status,'completed');assert.equal(f.submitted.length,10);assert.equal(f.queries.length,10);assert.equal(taskArtifacts(f.state).length,10);assert.ok(f.requests.length<=4);
 assert.equal(Object.values(storeOf(f.state).executions).length,10);
});
test('each deliverable has its own evidence; downstream media opens only after text artifact',async()=>{
 let turn=0;const f=setup(goal([{operation:'marketing_script',output:'text'},{operation:'generate_image',output:'image',dependsOn:[0]}]),({tools})=>{
  turn++;if(turn===1){assert.ok(!tools.some(t=>t.name==='generate_image'));return[call('commit_text_deliverable',{content:'广告文案：清晨一杯，轻松出发。'})];}
  if(turn===2){assert.ok(tools.some(t=>t.name==='generate_image'));return[plan(),call('generate_image',{prompt:'清晨咖啡海报'})];}return[answer('海报完成')];});
 await f.run();assert.equal(f.state.status,'completed');assert.equal(taskArtifacts(f.state).filter(a=>a.type==='text').length,1);assert.match(f.state.events.at(-1).text,/广告文案：/);assert.ok(currentTask(f.state).items.every(i=>i.status==='COMPLETED'));
});
test('confirmation binds to a concrete batch hash and survives roundtrip persistence',async()=>{
 let turn=0;const f=setup(goal([{operation:'generate_image',output:'image'}],true),({state})=>{
  turn++;if(turn===1)return[plan()];if(turn===2)return[call('propose_image_batch',{items:[{prompt:'猫咪插画'}]})];if(turn===3)return[call('execute_batch',{batchId:Object.keys(currentTask(state).batches)[0]})];return[answer('完成')];});
 await f.run();assert.equal(currentTask(f.state).status,'WAIT_CONFIRM');assert.equal(f.submitted.length,0);
 const task=currentTask(f.state);assert.throws(()=>approveTask(f.state,task.id,'stale'),/变化/);assert.equal(task.status,'WAIT_CONFIRM');
 const clone=JSON.parse(JSON.stringify(f.state));Object.assign(f.state,clone);
 await f.run({resumeTaskId:task.id,planHash:task.approval.planHash});assert.equal(f.submitted.length,1);assert.equal(f.state.status,'completed');assert.equal(storeOf(f.state).decisions.length,1);
});
test('known executions are reused within a resumed batch, never charged again',async()=>{
 const f=setup(goal([{operation:'generate_video',output:'video',count:2}]),()=>[]);createTask(f.state,await f.agent.intake(),'test');const item=currentTask(f.state).items[0];
 const engine=new TaskExecutor({state:f.state,runtime:f.runtime,catalog,brain:f.runtime.brain});await engine.execute('update_plan',{summary:'批量',steps:[{title:'生成',status:'running'}]},item,signal());
 const batch=await engine.execute('propose_video_batch',{items:[{prompt:'一'},{prompt:'二'}]},item,signal());
 await engine.execute('execute_batch',{batchId:batch.batchId},item,signal());await engine.execute('execute_batch',{batchId:batch.batchId},item,signal());assert.equal(f.submitted.length,2);assert.equal(taskArtifacts(f.state).length,2);
});
test('background receipts reconcile a limited task to completed without resubmission',async()=>{
 const f=setup(goal([{operation:'generate_video',output:'video'}]),()=>[]);createTask(f.state,await f.agent.intake(),'test');const item=currentTask(f.state).items[0];
 const engine=new TaskExecutor({state:f.state,runtime:f.runtime,catalog,brain:f.runtime.brain});await engine.execute('update_plan',{summary:'生成',steps:[{title:'生成',status:'running'}]},item,signal());await engine.execute('generate_video',{prompt:'咖啡'},item,signal());transition(f.state,'PARTIAL','上限');
 await refreshTasks(f.state,f.runtime,signal());assert.equal(f.state.status,'completed');assert.equal(f.submitted.length,1);assert.equal(taskArtifacts(f.state).length,1);
});
test('atomic checkpoint stores unknown side effects and refuses retry after restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-state-'));try{
  const persistence=new SessionStore(directory),f=setup(goal([{operation:'generate_image',output:'image'}]),()=>[],{save:s=>persistence.save(s)});createTask(f.state,await f.agent.intake(),'test');const item=currentTask(f.state).items[0];
  const engine=new TaskExecutor({state:f.state,runtime:f.runtime,catalog,brain:f.runtime.brain,save:s=>persistence.save(s)});await engine.execute('update_plan',{summary:'生成',steps:[{title:'生成',status:'running'}]},item,signal());
  f.runtime.media.image=async()=>{const saved=await persistence.load(f.state.id);assert.equal(Object.values(storeOf(saved).executions)[0].status,'unknown');throw new Error('connection lost');};
  const result=await engine.execute('generate_image',{prompt:'咖啡'},item,signal());assert.equal(result.uncertain,true);const restored=await persistence.load(f.state.id);assert.equal(Object.values(storeOf(restored).executions)[0].status,'unknown');
  const resumed=new TaskExecutor({state:restored,runtime:f.runtime,catalog,brain:f.runtime.brain});await assert.rejects(()=>resumed.execute('generate_image',{prompt:'咖啡'},currentTask(restored).items[0],signal()),/未知/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('essential missing source exits after semantic understanding, without routing failure',async()=>{
 let calls=0;const semantic={summary:'审核广告',deliverables:[{description:'审核广告',kind:'text',action:'respond',purpose:'risk_review',count:1,requiredEvidence:'none',dependsOn:[],references:[],constraints:[],requestEvidence:'审核'}],gaps:[{level:'blocking',description:'请提供广告正文',resolution:'等待原文'}],assumptions:[],deferred:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false}};
 const result=await understandGoal({respond:async()=>{calls++;return[answer(JSON.stringify(semantic))];}},catalog,{query:'告诉我广告的问题'},signal());assert.equal(calls,1);assert.equal(result.needsClarification,true);assert.equal(result.semantic.deliverables.length,1);
});
test('artifact revision keeps parent and rejects invented references',async()=>{
 let turn=0;let g=goal([{operation:'generate_image',output:'image'}]);const f=setup(g,()=>++turn%2===1?[plan(),call('generate_image',{prompt:'咖啡'})]:[answer('完成')]);await f.run();
 const parent=taskArtifacts(f.state)[0];g=goal([{operation:'edit_image',output:'image',references:[parent.id]}]);g.semantic.continuation={mode:'revise',taskId:currentTask(f.state).id};f.agent.intake=async()=>g;
 f.runtime.brain.respond=async()=>turn++===2?[plan(),call('edit_image',{prompt:'背景改蓝',referenceImages:[parent.url]})]:[answer('完成')];await f.run();
 const revision=taskArtifacts(f.state)[0];assert.equal(revision.parentId,parent.id);assert.equal(revision.version,2);assert.ok(storeOf(f.state).artifacts[parent.id]);
 const engine=new TaskExecutor({state:f.state,runtime:f.runtime,catalog,brain:f.runtime.brain});const target=currentTask(f.state).items[0];target.count=2;reconcileTask(f.state);
 await assert.rejects(()=>engine.execute('edit_image',{prompt:'另一版',referenceImages:['https://example.com/invented.png']},target,signal()),/执行项定义偏离/);assert.equal(f.submitted.length,2);
});
test('observed quality failure reopens the item, feeds replanning and preserves rejected version',async()=>{
 let checks=0,turn=0;const verifier={verifyPlan:async()=>({passed:true,issues:[]}),verifyArtifact:async()=>({passed:++checks>1,issues:checks===1?['背景应为蓝色']:[],uncertain:false})};
 const f=setup(goal([{operation:'generate_image',output:'image',constraints:['蓝色背景']}]),()=>{
  if(++turn===1)return[plan(),call('generate_image',{prompt:'蓝背景产品'})];if(turn===2)return[call('generate_image',{prompt:'严格使用纯蓝色背景，修复上一版背景错误'})];return[answer('已修复')];},{verifier});
 let n=0;f.runtime.media.image=async args=>{f.submitted.push(args);return{status:'succeeded',images:[{url:'https://example.com/quality-'+ ++n+'.png'}]};};
 await f.run();const artifacts=taskArtifacts(f.state);assert.equal(checks,2);assert.equal(f.submitted.length,2);assert.equal(f.state.status,'completed');assert.equal(artifacts[0].verification.semantic,'failed');assert.equal(artifacts[1].parentId,artifacts[0].id);assert.equal(artifacts[1].version,2);
});
test('duration mismatch cannot be silently sent to the provider',async()=>{
 const f=setup(goal([{operation:'generate_video',output:'video',spec:{durationSeconds:15}}]),()=>[]);createTask(f.state,await f.agent.intake(),'15秒视频');const item=currentTask(f.state).items[0];const engine=new TaskExecutor({state:f.state,runtime:f.runtime,catalog});
 await engine.execute('update_plan',{summary:'生成',steps:[{title:'生成',status:'running'}]},item,signal());await assert.rejects(()=>engine.execute('generate_video',{prompt:'15秒分镜',duration:12},item,signal()),/时长/);assert.equal(f.submitted.length,0);
});

test('independent media slots retain descriptions and cannot be merged into a lossy batch',async()=>{
 let turn=0;const g=goal(Array.from({length:10},(_,i)=>({operation:'generate_video',output:'video',description:'咖啡方向'+i,spec:{durationSeconds:5}})));
 const f=setup(g,()=>[]);createTask(f.state,g,'ten independent outputs');
 assert.equal(currentTask(f.state).items.length,10);assert.equal(currentTask(f.state).goal.tasks.length,10);assert.deepEqual(currentTask(f.state).items.map(i=>i.description),g.semantic.deliverables.map(d=>d.description));assert.equal(f.submitted.length,0);
 const mixed=goal([{operation:'generate_video',output:'video',spec:{durationSeconds:5}},{operation:'generate_video',output:'video',spec:{durationSeconds:10}}]);createTask(f.state,mixed,'不同长度');assert.equal(currentTask(f.state).items.length,2);
});

test('background quality rejection is resumable and invokes the bounded continuation hook',async()=>{
 const f=setup(goal([{operation:'generate_video',output:'video'}]),()=>[]);createTask(f.state,await f.agent.intake(),'视频');const item=currentTask(f.state).items[0];
 const verifier={verifyPlan:async()=>({passed:true,issues:[]}),verifyArtifact:async()=>({passed:false,uncertain:false,issues:['主体不符']})};
 const engine=new TaskExecutor({state:f.state,runtime:f.runtime,catalog,verifier});await engine.execute('update_plan',{summary:'生成',steps:[{title:'生成',status:'running'}]},item,signal());await engine.execute('generate_video',{prompt:'咖啡'},item,signal());
 for(const job of f.jobs.values())delete job.simulated;
 let resumed=0;await refreshTasks(f.state,f.runtime,signal(),{verifier,resume:async(s,id)=>{resumed++;assert.equal(id,currentTask(s).id);assert.equal(s.status,'limited');}});
 assert.equal(resumed,1);assert.equal(f.state.status,'limited');assert.equal(currentTask(f.state).backgroundContinuations,1);assert.equal(taskArtifacts(f.state)[0].verification.semantic,'failed');assert.equal(f.submitted.length,1);
});

test('verification separates preflight parameter checks from actual visual evidence',async()=>{
 const inputs=[],verifier=new Verifier({respond:async input=>{inputs.push(input);return[answer(JSON.stringify({passed:true,uncertain:false,issues:[]}))];}}),item={description:'咖啡',constraints:[],spec:{},observations:[]};
 await verifier.verifyPlan(item,'generate_video',[{prompt:'咖啡',duration:5}],{},signal());await verifier.verifyArtifact(item,{type:'video',url:'https://example.com/a.mp4',metadata:{provider:{duration:5}}},{},signal());
 assert.match(inputs[0][0].content,/绝不要求成品/);assert.equal(inputs[0][1].content.length,1);assert.equal(inputs[1][1].content[1].type,'input_video');assert.match(inputs[1][1].content[0].text,/providerMetadata/);
});

test('run_skill validates structured output and persists the real text artifact without media tools',async()=>{
 const f=setup(goal([{operation:'rewrite',output:'text'}]),({tools})=>{assert.equal(tools.length,0);return[answer(JSON.stringify({content:'清晨一杯，温柔相伴。',structure:{prompt:'清晨一杯，温柔相伴。',preservedConstraints:['咖啡']}}))];});
 createTask(f.state,await f.agent.intake(),'改写');const item=currentTask(f.state).items[0],engine=new TaskExecutor({state:f.state,runtime:f.runtime,catalog,brain:f.runtime.brain});
 const result=await engine.execute('run_skill',{slug:'creative-prompt-rewrite'},item,signal());assert.equal(result.contractValidated,true);assert.equal(result.artifact.metadata.structure.prompt,'清晨一杯，温柔相伴。');assert.equal(f.submitted.length,0);assert.equal(f.state.status,'completed');assert.doesNotThrow(()=>JSON.stringify(f.state));
});

test('a premature confirmation reply still persists a concrete plan; approval executes those exact arguments',async()=>{
 let calls=0;const f=setup(goal([{operation:'generate_image',output:'image'}],true),({options})=>{
  calls++;if(options?.json)return[answer(JSON.stringify({items:[{prompt:'白色咖啡杯，无文字',size:'2048x2048'}]}))];return[answer('方案已准备好，请确认。')];
 });
 await f.run();const task=currentTask(f.state);assert.equal(task.status,'WAIT_CONFIRM');assert.equal(f.submitted.length,0);assert.ok(task.approval.planHash);assert.equal(calls,2);
 const args=structuredClone(task.approval.payload.items[0]);await f.run({resumeTaskId:task.id,planHash:task.approval.planHash});assert.equal(f.state.status,'completed');assert.deepEqual(f.submitted,[args]);assert.equal(calls,3);
});

test('intake failure cannot claim an older completed artifact as the new request result',async()=>{
 const f=setup(goal([{operation:'answer',output:'text'}]),()=>[answer('第一轮正文')]);await f.run();const oldId=currentTask(f.state).id;
 f.agent.intake=async()=>{throw new Error('invalid structured output');};await f.run();assert.equal(currentTask(f.state).id,oldId);assert.equal(currentTask(f.state).status,'COMPLETED');assert.equal(f.state.events.at(-1).status,'failed');assert.equal(f.state.events.at(-1).taskId,null);assert.deepEqual(f.state.events.at(-1).artifacts,[]);
});

test('image batch rejects video-only parameters before any provider submission',async()=>{
 const f=setup(goal([{operation:'generate_image',output:'image'}]),()=>[]);createTask(f.state,await f.agent.intake(),'图片');const item=currentTask(f.state).items[0],engine=new TaskExecutor({state:f.state,runtime:f.runtime,catalog});
 await assert.rejects(()=>engine.execute('propose_image_batch',{items:[{prompt:'咖啡',size:'2048x2048',ratio:'1:1'}]},item,signal()),/additionalProperty.*ratio/);assert.equal(f.submitted.length,0);
});

test('continuation drafts must validate dependencies before any old-goal reuse',async()=>{
 const semantic={summary:'确认生成',deliverables:[{description:'咖啡海报',kind:'image',action:'create',purpose:'marketing',count:1,requiredEvidence:'none',dependsOn:[0],references:[],constraints:[],requestEvidence:'确认'}],continuation:{mode:'approve',taskId:'existing'},gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false}};
 assert.throws(()=>validateSemantic(structuredClone(semantic)),/依赖/);assert.throws(()=>validateSemantic(structuredClone(semantic),{taskSnapshot:{id:'existing'}}),/依赖/);semantic.deliverables[0].dependsOn=[];
 let calls=0;const stored=goal([{operation:'answer',output:'text'},{operation:'generate_image',output:'image',dependsOn:[0]}],true);
 const result=await understandGoal({respond:async()=>{calls++;return[answer(JSON.stringify(semantic))];}},catalog,{query:'确认',taskSnapshot:{id:'existing',goal:stored}},signal());assert.equal(calls,1);assert.equal(result.resumeTaskId,'existing');assert.deepEqual(result.tasks,stored.tasks);
 const denied={...semantic,deliverables:[],safety:{disposition:'refuse',reason:'危险指令',untrustedInstructions:true}};
 const refusal=await understandGoal({respond:async()=>[answer(JSON.stringify(denied))]},catalog,{query:'危险指令',taskSnapshot:{id:'existing',goal:stored}},signal());assert.equal(refusal.resumeTaskId,undefined);assert.equal(refusal.safety.disposition,'refuse');
});
