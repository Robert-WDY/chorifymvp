import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {Agent} from './runtime-model-fixture.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {currentTask,taskArtifacts,storeOf,createTask,taskSnapshot,clientStatus} from '../server/task-state.mjs';
import {Verifier} from '../server/verification.mjs';
import {SessionStore} from '../server/session-store.mjs';
import {hasPendingTasks,refreshTasks} from '../server/task-monitor.mjs';
import {resolveSources} from '../server/sources.mjs';

const catalog=await loadCatalog();
const signal=()=>new AbortController().signal;
const reply=value=>[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}];
const pass=()=>({passed:true,issues:[],uncertain:false});
const goal=(tasks)=>({summary:'创作测试',mode:'create',tasks:tasks.map(t=>({operation:'generate_image',output:'image',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none',...t})),skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow',reason:'',untrustedInstructions:false},semantic:{approval:{required:false},continuation:{mode:'new',taskId:''},deliverables:tasks.map(()=>({description:'按要求完成作品'}))}});

function fixture(g){
  const state={id:'11111111-1111-4111-8111-111111111111',messages:[],events:[]};
  const calls=[],submissions=[],checkpoints=[];
  let serial=0;
  const brain={respond:async(input)=>{
    calls.push(structuredClone(input));
    const p=JSON.parse(input.findLast(i=>i.role==='user').content);
    if(input[0].content.includes('你负责为当前已接受媒体节点'))return reply({concept:'测试方案',preservedConstraints:[],safety:{passed:true,reason:'普通创作'},items:[{prompt:'咖啡创作',...(p.goal.operation==='generate_video'?{duration:5,ratio:'16:9'}:{size:'2048x2048',...(p.goal.references?.length?{referenceImages:p.goal.references}:{})})}]});
    return reply({content:p.sources?.[0]?.content?p.sources[0].content+'，更简洁':'青柚计划 COPY_SOURCE_7391，售价39元。'});
  }};
  const media={config:{imageModel:'fake',videoModel:'fake'},image:async(args)=>{submissions.push(args);return{status:'succeeded',images:[{url:'https://test.invalid/'+ ++serial+'.png',size:'2048x2048'}]};},video:async(args)=>{submissions.push(args);return{status:'queued',taskId:'job-'+ ++serial};},getVideo:async id=>({status:'succeeded',taskId:id,videoUrl:'https://test.invalid/result.mp4'})};
  const verifier={verifyPlan:async()=>pass(),verifyText:async()=>pass(),verifyArtifact:async()=>pass()};
  const runtime=new ToolRuntime({catalog,brain,media});
  const agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,verifier,intake:async()=>g,save:async s=>checkpoints.push(structuredClone(s))});
  return{state,calls,submissions,checkpoints,brain,media,verifier,runtime,agent,run:(control={})=>agent.run(state,'修改当前作品',()=>{},signal(),control)};
}

test('two text revisions consume their exact source body and retain the parent chain',async()=>{
  const f=fixture(goal([{operation:'marketing_script',output:'text'}]));await f.run();
  for(let revision=2;revision<=3;revision++){
    const source=taskArtifacts(f.state).find(a=>a.type==='text');
    const next=goal([{operation:'rewrite',output:'text',references:[source.id]}]);
    next.semantic.continuation={mode:'revise',taskId:currentTask(f.state).id};f.agent.intake=async()=>next;
    await f.run();assert.equal(f.state.status,'completed');
    const body=JSON.parse(f.calls.at(-1)[1].content);
    assert.equal(body.sources[0].content,source.content);assert.equal(body.sources[0].id,source.id);
    const result=taskArtifacts(f.state).find(a=>a.type==='text');
    assert.equal(result.parentId,source.id);assert.equal(result.version,revision);assert.match(result.content,/COPY_SOURCE_7391/);
  }
});

test('a missing source blocks text generation and references cannot select another session',async()=>{
  const f=fixture(goal([{operation:'rewrite',output:'text',references:['absent-artifact']} ]));
  await f.run();assert.equal(f.state.status,'blocked');assert.equal(f.calls.length,0);
  assert.match(currentTask(f.state).reason,/源素材/);
});

test('explicit dependency references resolve only validated deliverables',async()=>{
  const f=fixture(goal([{operation:'marketing_script',output:'text'},{operation:'rewrite',output:'text',dependsOn:[0],references:['task:0']}]));
  await f.run();assert.equal(f.state.status,'completed');
  const source=taskArtifacts(f.state).find(a=>a.itemId===currentTask(f.state).items[0].id);
  assert.equal(JSON.parse(f.calls[1][1].content).sources[0].content,source.content);
  assert.throws(()=>resolveSources(f.state,{references:['task:0'],dependsOn:[]}),/依赖/);
});

test('unknown media blocks its own retry but allows independent new text and media tasks',async()=>{
  const f=fixture(goal([{}]));const originalImage=f.media.image;
  f.media.image=async(args)=>{f.submissions.push(args);throw new Error('connection lost');};
  await f.run();const oldTask=currentTask(f.state).id;assert.equal(f.submissions.length,1);
  f.agent.intake=async()=>goal([{operation:'answer',output:'text'}]);await f.run();assert.equal(f.state.status,'completed');
  f.media.image=originalImage;f.agent.intake=async()=>goal([{}]);await f.run();assert.equal(f.state.status,'completed');assert.equal(f.submissions.length,2);
  storeOf(f.state).activeTaskId=oldTask;await f.run({resumeTaskId:oldTask});
  assert.equal(f.state.status,'blocked');assert.equal(f.submissions.length,2);
  assert.equal(Object.values(storeOf(f.state).executions).find(e=>e.taskId===oldTask).status,'unknown');
});

test('an unknown media result does not suppress an independent text node in the same task',async()=>{
  const f=fixture(goal([{}, {operation:'answer',output:'text'}]));
  f.media.image=async()=>{throw new Error('unknown');};await f.run();
  assert.equal(currentTask(f.state).status,'BLOCKED');
  assert.equal(currentTask(f.state).items[1].status,'COMPLETED');
});

const original={id:'source',taskId:'old',type:'image',url:'https://test.invalid/original.png',metadata:{provider:{size:'2048x2048'}}};
const imageState=()=>({taskStore:{activeTaskId:'t',tasks:{t:{id:'t',protocol:'compiled-v1',items:[]}},artifacts:{source:structuredClone(original)}}});
const editItem=()=>({operation:'edit_image',description:'只改背景，杯子位置大小和其他区域不变',constraints:['杯子位置大小不变'],spec:{},references:['source'],dependsOn:[]});
const edited=()=>({type:'image',taskId:'t',url:'https://test.invalid/result.png',parentId:'source',metadata:{args:{size:'2048x2048'},provider:{size:'2048x2048'}}});
const comparison=()=>({sourceObserved:true,resultObserved:true,requestedChanges:'passed',preservedRegions:'passed'});

test('edit verification sends both labeled images and requires complete comparison evidence',async()=>{
  let input;
  const v=new Verifier({respond:async value=>{input=value;return reply({...pass(),comparison:comparison()});}});
  const verdict=await v.verifyArtifact(editItem(),edited(),imageState(),signal());assert.equal(verdict.passed,true);
  assert.deepEqual(input[1].content.filter(p=>p.type==='input_image').map(p=>p.image_url),[original.url,edited().url]);
  assert.match(input[1].content.filter(p=>p.type==='input_text').map(p=>p.text).join('\n'),/原图 1.*source/);
  assert.match(input[0].content,/相对大小/);
});

test('preservation failure and uncertain source evidence cannot be overruled by passed=true',async()=>{
  for(const [details,uncertain] of [[{preservedRegions:'failed'},false],[{preservedRegions:'uncertain'},true],[{sourceObserved:false},true]]){
    const v=new Verifier({respond:async()=>reply({...pass(),comparison:{...comparison(),...details}})});
    const verdict=await v.verifyArtifact(editItem(),edited(),imageState(),signal());
    assert.equal(verdict.passed,false);assert.equal(verdict.uncertain,uncertain);
  }
});

test('missing original and missing comparison output leave the image unverified',async()=>{
  let calls=0;const v=new Verifier({respond:async()=>{calls++;return reply(pass());}});
  const missing=await v.verifyArtifact(editItem(),edited(),{},signal());assert.equal(missing.uncertain,true);assert.equal(calls,0);
  const invalid=await v.verifyArtifact(editItem(),edited(),imageState(),signal());assert.equal(invalid.passed,false);assert.equal(invalid.uncertain,true);assert.equal(calls,2);
});

test('real edit verifier persists comparison evidence; continuation rechecks images without regenerating',async()=>{
  const f=fixture(goal([{operation:'edit_image',spec:{ratio:'1:1'},references:['source']} ]));
  f.state.assets=[{assetId:'source',kind:'image',url:original.url,source:'用户提供'}];
  const generate=f.brain.respond;let certain=false,comparisons=0;
  f.brain.respond=async(input,...args)=>{
    if(!input[0].content.startsWith('你是任务交付验证器'))return generate(input,...args);
    const images=input[1].content.filter(p=>p.type==='input_image');
    if(!images.length)return reply(pass());
    comparisons++;assert.equal(images.length,2);
    return reply({...pass(),comparison:{...comparison(),preservedRegions:certain?'passed':'uncertain'}});
  };
  f.agent.verifier=new Verifier(f.brain);
  await f.run();assert.equal(f.state.status,'blocked');assert.equal(f.submissions.length,1);assert.equal(comparisons,1);
  assert.equal(taskArtifacts(f.state).find(a=>a.purpose==='deliverable').verification.comparison.preservedRegions,'uncertain');
  certain=true;await f.run({resumeTaskId:currentTask(f.state).id});
  assert.equal(f.state.status,'completed');assert.equal(f.submissions.length,1);assert.equal(comparisons,2);
  assert.equal(taskArtifacts(f.state).find(a=>a.purpose==='deliverable').verification.comparison.preservedRegions,'passed');
});

test('exact source strings are checked deterministically and full text contract reaches the judge',async()=>{
  const state=imageState();state.taskStore.artifacts.text={id:'text',type:'text',content:'青柚，原价39元'};
  const item={operation:'rewrite',description:'简写标题',references:['text'],spec:{exactTexts:['青柚']},constraints:[]};
  let calls=0;
  const v=new Verifier({respond:async input=>{calls++;const payload=JSON.parse(input[1].content[0].text);assert.deepEqual(payload.spec,item.spec);assert.equal(payload.sources[0].content,'青柚，原价39元');return reply(pass());}});
  const fail=await v.verifyText(item,'另一品牌39元',state,signal());assert.equal(fail.passed,false);assert.equal(fail.uncertain,false);assert.equal(calls,0);
  assert.equal((await v.verifyText(item,'青柚39元',state,signal())).passed,true);assert.equal(calls,1);
});

test('wrong or missing image dimensions cannot be accepted by a permissive vision model',async()=>{
  let calls=0;const v=new Verifier({respond:async()=>{calls++;return reply({...pass(),comparison:comparison()});}});
  const wrong=edited();wrong.metadata.provider.size='1024x1024';
  assert.equal((await v.verifyArtifact(editItem(),wrong,imageState(),signal())).passed,false);
  delete wrong.metadata.provider.size;assert.equal((await v.verifyArtifact(editItem(),wrong,imageState(),signal())).uncertain,true);
  assert.equal(calls,0);
});

async function roundtrip(state,callback){
  const directory=await mkdtemp(join(tmpdir(),'audit-recovery-'));
  try{const store=new SessionStore(directory);await store.save(state);await callback(await store.load(state.id),store);}
  finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('audit-recovery-'));await rm(directory,{recursive:true,force:true});}
}

async function verificationCheckpoint(){
  const f=fixture(goal([{operation:'generate_video',output:'video'}]));await f.run();
  const checkpoint=f.checkpoints.find(s=>currentTask(s)?.status==='VERIFYING');assert.ok(checkpoint);
  return{f,checkpoint};
}

test('restart between receipt and verification resumes validation without another paid submission',async()=>{
  const {f,checkpoint}=await verificationCheckpoint();
  await roundtrip(checkpoint,async(state,store)=>{
    assert.equal(hasPendingTasks(state),true);f.calls.length=0;
    await refreshTasks(state,f.runtime,signal(),{verifier:f.verifier,save:s=>store.save(s),resume:async(s,id)=>f.agent.run(s,'恢复验收',()=>{},signal(),{resumeTaskId:id})});
    assert.equal(currentTask(state).status,'COMPLETED');assert.equal(f.submissions.length,1);assert.equal(f.calls.length,0);
    assert.equal(hasPendingTasks(state),false);assert.equal((await store.load(state.id)).status,'completed');
  });
});

test('background verification recovery respects paused states and a persisted retry budget',async()=>{
  const {f,checkpoint}=await verificationCheckpoint();
  for(const status of ['CANCELLED','REFUSED','WAIT_CONFIRM','BLOCKED','NEEDS_INPUT']){
    const state=structuredClone(checkpoint);currentTask(state).status=status;
    assert.equal(hasPendingTasks(state),false);
    await refreshTasks(state,f.runtime,signal(),{resume:async()=>assert.fail('must not resume paused work')});
  }
  await roundtrip(checkpoint,async(state,store)=>{
    for(let attempt=0;attempt<2;attempt++){
      await assert.rejects(refreshTasks(state,f.runtime,signal(),{save:s=>store.save(s),resume:async()=>{throw new Error('fake outage');}}),/fake outage/);
      state=await store.load(state.id);assert.equal(currentTask(state).backgroundContinuations,attempt+1);
    }
    assert.equal(hasPendingTasks(state),false);assert.equal(taskSnapshot(state).actions.canResume,true);
  });
  assert.equal(f.submissions.length,1);
});

test('recovering an older task preserves the foreground task identity',async()=>{
  const {f,checkpoint}=await verificationCheckpoint();
  const foreground=createTask(checkpoint,goal([{operation:'answer',output:'text'}]),'新的独立问题');
  await refreshTasks(checkpoint,f.runtime,signal(),{verifier:f.verifier,resume:async(s,id)=>f.agent.run(s,'恢复旧任务',()=>{},signal(),{resumeTaskId:id})});
  assert.equal(currentTask(checkpoint).id,foreground.id);assert.equal(f.submissions.length,1);
});

test('interrupted planning exposes a deterministic resume action and pending submission is never repeated',async()=>{
  const f=fixture(goal([{}]));await f.run();
  const planning=f.checkpoints.find(s=>currentTask(s)?.status==='PLANNING'&&currentTask(s)?.executionPlan);
  await roundtrip(planning,async(state)=>{
    assert.equal(clientStatus(state),'interrupted');assert.equal(taskSnapshot(state).actions.canResume,true);
    await f.agent.run(state,'恢复规划',()=>{},signal(),{resumeTaskId:currentTask(state).id});assert.equal(state.status,'completed');
  });
  const pending=f.checkpoints.find(s=>Object.values(storeOf(s).executions).some(e=>e.status==='pending'));
  await roundtrip(pending,async(state)=>{
    const count=f.submissions.length;assert.equal(taskSnapshot(state).actions.canResume,false);assert.equal(taskSnapshot(state).actions.awaitingReconciliation,true);
    await f.agent.run(state,'恢复提交',()=>{},signal(),{resumeTaskId:currentTask(state).id});assert.equal(state.status,'blocked');assert.equal(f.submissions.length,count);
  });
});

test('confirmation actions still require the frozen plan hash and cannot authorize themselves',async()=>{
  const g=goal([{}]);g.semantic.approval.required=true;const f=fixture(g);await f.run();
  assert.equal(taskSnapshot(f.state).actions.requiresApproval,true);assert.equal(f.submissions.length,0);
  await f.run({resumeTaskId:currentTask(f.state).id});assert.equal(f.submissions.length,0);assert.equal(currentTask(f.state).status,'WAIT_CONFIRM');
  const task=currentTask(f.state);await f.run({resumeTaskId:task.id,planHash:task.approval.planHash});assert.equal(f.submissions.length,1);
});
