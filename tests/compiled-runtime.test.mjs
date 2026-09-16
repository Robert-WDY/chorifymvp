import {fieldPatchFor} from './runtime-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from './runtime-model-fixture.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {currentTask,taskArtifacts,storeOf,transition} from '../server/task-state.mjs';
import {SessionStore} from '../server/session-store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {specializeMediaSchema,structuredOutput} from '../server/goal-compiler.mjs';
import {mediaSkills} from '../server/media-skill-contracts.mjs';
import {Verifier} from '../server/verification.mjs';
import {understandGoal} from './intake-compat.mjs';
const catalog=await loadCatalog(),sig=()=>new AbortController().signal;
const message=x=>[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(x)}]}];
const goal=(tasks,approval=false)=>({summary:'咖啡创作',mode:'create',tasks:tasks.map(t=>({operation:'generate_image',output:'image',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none',...t})),skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow',reason:'',untrustedInstructions:false},semantic:{approval:{required:approval},continuation:{mode:'new',taskId:''},deliverables:tasks.map(()=>({description:'咖啡作品'}))}});
function fixture(g,{uncertain=false,rejectFirst=false,simulate=false,failSubmit=false,invalidPlan=false}={}){
 let serial=0,plans=0,verified=0;const submissions=[],calls=[],jobs=new Map(),state={id:'11111111-1111-4111-8111-111111111111',messages:[],events:[]};
 const brain={respond:async(input,tools)=>{assert.equal(tools.length,0,'LLM must never receive executable tools');calls.push(input);const p=JSON.parse(input.at(-1).content);if(input[0].content.includes('你负责为当前已接受媒体节点')){
  plans++;return message({concept:'咖啡创意',preservedConstraints:[],safety:{passed:true,reason:'普通创作'},items:Array.from({length:p.goal.count},(_,i)=>({prompt:'咖啡 '+plans+' '+i,...(p.goal.operation==='generate_video'?{duration:invalidPlan?15:5,ratio:'16:9'}:{size:'2048x2048',...(p.goal.references.length?{referenceImages:p.goal.references}:{})})}))});
 }return message({content:'清晨咖啡，温柔开启新一天。'});}};
 const media={config:{imageModel:'test',videoModel:'test'},image:async args=>{submissions.push(args);if(failSubmit)throw new Error('connection lost');return{status:'succeeded',images:[{url:'https://test.invalid/'+ ++serial+'.png'}],simulated:simulate};},video:async args=>{submissions.push(args);const taskId='job-'+ ++serial;jobs.set(taskId,{taskId,status:'succeeded',videoUrl:'https://test.invalid/'+serial+'.mp4',simulated:simulate});return{status:'queued',taskId};},getVideo:async id=>jobs.get(id)};
 const verifier={verifyPlan:async()=>({passed:true,issues:[]}),verifyText:async()=>({passed:true,issues:[]}),verifyArtifact:async()=>({passed:!uncertain&&!(rejectFirst&&++verified===1),uncertain,issues:uncertain?['无法观察']:rejectFirst?['背景不符合']:[]})};
 const runtime=new ToolRuntime({catalog,brain,media}),agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,intake:async()=>g,verifier,simulation:simulate});
 return{state,agent,submissions,calls,run:(control={})=>agent.run(state,'咖啡',()=>{},sig(),control),plans:()=>plans};
}
test('compiler runs a mandatory contracted skill and a persisted batch with zero model tool permissions',async()=>{
 const f=fixture(goal([{count:3}]));await f.run();assert.equal(f.state.status,'completed');assert.equal(f.submissions.length,3);const t=currentTask(f.state);assert.equal(t.executionPlan.nodes[0].skillId,'image_creation_skill');assert.equal(t.items[0].methods[0].status,'validated');assert.equal(t.verification.semantic,'not_checked');assert.equal(t.verification.quality,'not_evaluated');assert.equal(taskArtifacts(f.state).filter(a=>a.purpose==='deliverable').length,3);
});
test('confirmation executes frozen parameters after reload without rerunning skill',async()=>{
 const f=fixture(goal([{}],true));await f.run();const task=currentTask(f.state);assert.equal(task.status,'WAIT_CONFIRM');assert.equal(f.submissions.length,0);const args=structuredClone(task.approval.payload.items);Object.assign(f.state,JSON.parse(JSON.stringify(f.state)));await f.run({resumeTaskId:task.id,planHash:task.approval.planHash});assert.deepEqual(f.submissions,args);assert.equal(f.plans(),1);assert.equal(f.state.status,'completed');
});
test('tampering with approved batch is blocked before submission',async()=>{
 const f=fixture(goal([{}],true));await f.run();const t=currentTask(f.state);t.batches[t.executionPlan.nodes[0].batchId].items[0].prompt='tampered';await f.run({resumeTaskId:t.id,planHash:t.approval.planHash});assert.equal(f.submissions.length,0);assert.equal(f.state.status,'blocked');
});
test('unobservable artifact cannot complete; continuation retries validation without regenerating',async()=>{
 const f=fixture(goal([{}]),{uncertain:true});await f.run();assert.equal(f.state.status,'blocked');assert.equal(f.submissions.length,1);await f.run({resumeTaskId:currentTask(f.state).id});assert.equal(f.state.status,'blocked');assert.equal(f.submissions.length,1);
});
test('quality rejection runs skill with feedback and preserves parent revision',async()=>{
 const f=fixture(goal([{}]),{rejectFirst:true});await f.run();assert.equal(f.state.status,'completed');assert.equal(f.plans(),2);const artifacts=taskArtifacts(f.state).filter(a=>a.purpose==='deliverable');assert.equal(artifacts.length,2);assert.equal(artifacts[1].parentId,artifacts[0].id);assert.equal(artifacts[1].version,2);
});
test('simulation has a separate terminal result and never production completion',async()=>{
 const f=fixture(goal([{operation:'generate_video',output:'video',count:10}]),{simulate:true});await f.run();assert.equal(f.state.status,'simulated');assert.equal(f.submissions.length,10);assert.equal(currentTask(f.state).verification.semantic,'simulated_not_checked');
});
test('unknown submission survives disk restart and never retries generation',async()=>{
 const f=fixture(goal([{}]),{failSubmit:true}),directory=await mkdtemp(join(tmpdir(),'compiled-'));try{
  const persistence=new SessionStore(directory);f.agent.save=s=>persistence.save(s);await f.run();assert.equal(f.submissions.length,1);const restored=await persistence.load(f.state.id);Object.assign(f.state,restored);await f.run({resumeTaskId:currentTask(f.state).id});assert.equal(f.submissions.length,1);assert.equal(Object.values(storeOf(f.state).executions)[0].status,'unknown');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('unsupported video editing preserves goal and never replaces it with video generation',async()=>{
 const f=fixture(goal([{operation:'edit_video',output:'video'}]));await f.run();assert.equal(f.state.status,'blocked');assert.equal(f.submissions.length,0);assert.equal(currentTask(f.state).items[0].operation,'edit_video');
});
test('dependent media waits for a validated text artifact',async()=>{
 const f=fixture(goal([{operation:'marketing_script',output:'text'},{dependsOn:[0]}]));await f.run();assert.equal(f.state.status,'completed');assert.equal(taskArtifacts(f.state).filter(a=>a.purpose==='deliverable').length,2);assert.ok(f.calls[1][1].content.includes('清晨咖啡'));
});
test('clarification keeps task identity and confirmation obligation even if next model drops it',async()=>{
 const g={...goal([],true),needsClarification:true,missingInputs:['需要什么作品']};const f=fixture(g);await f.run();const id=currentTask(f.state).id;const next=goal([{}]);next.semantic.continuation={mode:'clarify',taskId:id};f.agent.intake=async()=>next;await f.run();assert.equal(currentTask(f.state).id,id);assert.equal(currentTask(f.state).status,'WAIT_CONFIRM');assert.equal(f.submissions.length,0);
});
test('image editing uses source and emits only generate_image from the public tool surface',async()=>{
 const f=fixture(goal([{operation:'edit_image',spec:{ratio:'1:1'},references:['https://test.invalid/source.png']}]));f.state.assets=[{assetId:'source',url:'https://test.invalid/source.png',kind:'image',source:'用户提供'}];await f.run();assert.equal(f.state.status,'completed');assert.deepEqual(f.submissions[0].referenceImages,['https://test.invalid/source.png']);assert.equal(Object.values(storeOf(f.state).executions)[0].tool,'generate_image');
});
test('model cannot set completed state directly',async()=>{const f=fixture(goal([{}]));await f.run();assert.throws(()=>transition(f.state,'COMPLETED'),/验收/);});

test('verified multi-unit text completes as one document without repeated creation',async()=>{
 const f=fixture(goal([{operation:'marketing_script',output:'text',count:3}]));await f.run();assert.equal(f.state.status,'completed');const a=taskArtifacts(f.state).filter(a=>a.type==='text');assert.equal(a.length,1);assert.equal(a[0].metadata.unitCount,3);assert.equal(f.calls.length,1);
});

test('twenty media outputs use one contract while an oversized goal is retained and blocked',async()=>{
 const f=fixture(goal([{operation:'generate_video',output:'video',count:20}]),{simulate:true});await f.run();assert.equal(f.state.status,'simulated');assert.equal(f.submissions.length,20);
 const tooMany=fixture(goal([{operation:'generate_video',output:'video',count:21}]));await tooMany.run();assert.equal(tooMany.state.status,'blocked');assert.equal(currentTask(tooMany.state).items[0].count,21);assert.equal(tooMany.submissions.length,0);
});
test('per-task schema rejects shot arrays and incorrect total duration before submission',async()=>{
 const schema=specializeMediaSchema(mediaSkills[1],{spec:{durationSeconds:5,ratio:'16:9'}},1);let calls=0;
 const output=await structuredOutput({respond:async()=>message({concept:'one film',preservedConstraints:[],safety:{passed:true,reason:'safe'},items:++calls===1?[{prompt:'shot1',duration:2,ratio:'16:9'},{prompt:'shot2',duration:3,ratio:'16:9'}]:[{prompt:'0-2s shot1; 2-5s shot2',duration:5,ratio:'16:9'}]})},'contract',{},schema,sig());
 assert.equal(calls,2);assert.equal(output.items.length,1);assert.equal(output.items[0].duration,5);
});
test('validator repairs malformed JSON without defaulting a failed content verdict to success',async()=>{
 let calls=0;const verifier=new Verifier({respond:async()=>++calls===1?[{type:'message',content:[{type:'output_text',text:'{"passedtrue,'}]}]:message({passed:false,uncertain:false,issues:['wrong background']})});
 const verdict=await verifier.verifyPlan({description:'blue',constraints:[],spec:{},observations:[]},'generate_image',[],{},sig());assert.equal(calls,2);assert.equal(verdict.passed,false);
});
test('legacy skill instructions are reference data, while exact task schema is system authority',async()=>{
 const f=fixture(goal([{operation:'generate_video',output:'video'}]));await f.run();assert.equal(f.state.status,'completed');const input=f.calls[0];assert.ok(JSON.parse(input[1].content).methodReferences.length);assert.match(input[0].content,/每个item是一件完整最终成品/);assert.ok(!input[0].content.includes('# 单次整图'));
});
test('Chinese title count evidence excludes a layout space at the exact twelve-character boundary',async()=>{
 const verifier=new Verifier({respond:async input=>{const payload=JSON.parse(input[1].content[0].text);assert.equal(payload.lengthEvidence[0].characters,13);assert.equal(payload.lengthEvidence[0].withoutPunctuation,12);return message({passed:true,uncertain:false,issues:[]});}});
 const verdict=await verifier.verifyText({operation:'marketing_script',description:'十二字以内标题',constraints:[],observations:[]},'幽默风：耳戴小方块 世界只剩我和歌',{},sig());assert.equal(verdict.passed,true);
});
test('a truncated continuation ID is repaired instead of silently becoming a new task',async()=>{
 const id='13ab2963-84cc-4ca2-9719-772ae5e3dfc9';let calls=0;
 const semantic={summary:'补充原始素材',deliverables:[],gaps:[{description:'请提供原图',level:'blocking',resolution:'提供URL'}],assumptions:[],deferred:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''}};
 const result=await understandGoal({respond:async input=>{const value={...semantic,continuation:{mode:'clarify',taskId:++calls===1?id.slice(0,-1):id}};return message(calls===1?value:fieldPatchFor(input,value));}},catalog,{query:'继续补充',strictControl:true,taskSnapshot:{id,status:'NEEDS_INPUT'}},sig());assert.equal(calls,2);assert.equal(result.semantic.continuation.taskId,id);
});

test('NEEDS_INPUT cannot skip recompilation through a model-selected continue',async()=>{
 const id='13ab2963-84cc-4ca2-9719-772ae5e3dfc9';let calls=0;
 const semantic={summary:'补齐原图并改蓝背景',deliverables:[{description:'改蓝背景图片',kind:'image',count:1,action:'modify',purpose:'general',requiredEvidence:'none',references:['https://test.invalid/source.png'],dependsOn:[],constraints:['蓝背景'],requestEvidence:'原图在这里'}],gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''}};
 const brain={respond:async()=>{calls++;return message(calls===2?{routes:[{deliverableIndex:0,operation:'edit_image',skills:[]}]}:{...semantic,continuation:{mode:'continue',taskId:id}});}};
 const result=await understandGoal(brain,catalog,{query:'提供原图',assets:[{url:'https://test.invalid/source.png',kind:'image'}],strictControl:true,taskSnapshot:{id,status:'NEEDS_INPUT'}},sig());assert.equal(calls,1);assert.equal(result.resumeTaskId,undefined);assert.equal(result.semantic.continuation.mode,'clarify');assert.equal(result.tasks[0].operation,'edit_image');assert.deepEqual(result.tasks[0].references,['https://test.invalid/source.png']);
});
