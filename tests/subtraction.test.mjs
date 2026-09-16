import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import Ajv from 'ajv';
import {Agent} from './runtime-model-fixture.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {understandGoal,semanticSchema,validateSemantic} from '../server/intent.mjs';
import {operationInputSchema,projectOperationCandidate,applyPlanDelta,revisionTarget} from '../server/turn-operation.mjs';
import {currentTask,taskArtifacts,approveTask,taskSnapshot} from '../server/task-state.mjs';
import {inspectFacts,queryChecks,loadInspection,renderFacts} from '../server/runtime-facts.mjs';
import {observeImages} from '../server/observation-contract.mjs';
import {createHash} from 'node:crypto';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=x=>[{type:'message',role:'assistant',content:[{type:'output_text',text:typeof x==='string'?x:JSON.stringify(x)}]}];
const safety={disposition:'allow',untrustedInstructions:false,reason:''};
const candidate=(kind,deliverables=[],extra={})=>({summary:'隔离操作',turnOperation:{kind},deliverables,safety,approval:{required:false,reason:''},...extra});
const d=(kind,description,rest={})=>({kind,description,action:'create',count:1,requestEvidence:description,...rest});
test('A compact edit has delta, precise medium fields, and no duplicate control decisions',()=>{
 const schema=operationInputSchema(semanticSchema),check=new Ajv({strict:false}).compile(schema);
 const value=candidate('modify',[d('image','改背景',{action:'modify',references:['image'],changeContract:{change:['背景改米白'],preserve:['白杯不变']},spec:{ratio:'1:1'}})]);
 assert.equal(check(value),true,JSON.stringify(check.errors));assert.equal(schema.properties.continuation,undefined);assert.equal(schema.properties.spec,undefined);
 const old=structuredClone(value);delete old.deliverables[0].changeContract;assert.equal(check(old),false);
 const wrong=structuredClone(value);wrong.deliverables[0].action='inspect';assert.equal(check(wrong),false);
 wrong.deliverables[0].action='modify';wrong.deliverables[0].spec.directionCount=3;assert.equal(check(wrong),false);
 const projected=projectOperationCandidate(structuredClone(value),catalog);assert.deepEqual(projected.continuation,{mode:'new',taskId:''});assert.equal(projected.deliverables[0].action,'modify');
});
test('A media duplicate proof rejects repeated effects but permits independent extra requests',()=>{
 const delivery=d('image','产品',{references:[],dependsOn:[],constraints:[],requiredEvidence:'none',purpose:'general'});
 const s=projectOperationCandidate(candidate('create',[delivery,{...delivery,dependsOn:[0]}]),catalog);
 assert.throws(()=>validateSemantic(s),/独立新增义务/);
 s.deliverables[1].requestEvidence='另外再生成一张';assert.doesNotThrow(()=>validateSemantic(s));
});
test('A legacy global method ownership cannot disappear or be copied to every target',()=>{
 const s=candidate('create',[d('text','甲'),d('text','乙')],{requiredMethods:['提示词改写']});
 assert.throws(()=>projectOperationCandidate(structuredClone(s),catalog),/目标归属/);
 s.deliverables[1].requiredMethods=['creative-prompt-rewrite'];const normalized=projectOperationCandidate(s,catalog);
 assert.deepEqual(normalized.deliverables.map(x=>x.requiredMethods),[[],['creative-prompt-rewrite']]);
});
test('A query receipts distinguish missing information from topic mismatch and skill reading from execution',async()=>{
 const facts=await loadInspection({state:{},runtime:{},catalog},{runtimeQuery:{type:'skill_detail',targets:['creative-prompt-rewrite']}});
 assert.ok(facts.skillInstructions.content.length>100);assert.match(renderFacts(facts),/提示词/);assert.equal(queryChecks(facts).queryResolved,true);assert.equal(queryChecks(facts).answerCovered,false);assert.equal(queryChecks(facts).answerCoverageStatus,'not_composed');
 assert.equal(queryChecks({query:{type:'history'},message:null}).answerCovered,false);assert.equal(queryChecks({query:{type:'history',topicMatched:false},message:{content:'x'}}).completionAllowed,false);
 assert.throws(()=>inspectFacts({state:{},runtime:{},catalog},{runtimeQuery:{type:'invented'}}),/未实现/);
});
test('A comparison is one ordered observation and failed sets are retried atomically',async()=>{
 const images=['a','b'].map(id=>({id,type:'image',url:'https://test.invalid/'+id+'.png',version:1}));
 const state={taskStore:{tasks:{},artifacts:{},inputs:Object.fromEntries(images.map(a=>[a.id,a]))}},item={id:'i',references:['a','b'],dependsOn:[],requiredEvidence:'image',description:'比较两图'};
 let fail=true;const calls=[],executor={state,runtime:{execute:async(name,args)=>{calls.push(args);if(fail)throw Error('offline failure');return {text:'逐图观察'};}},record:async()=>{},save:async()=>{}};
 await assert.rejects(observeImages(executor,item,signal()),/offline failure/);assert.equal(item.observations.length,0);fail=false;
 await observeImages(executor,item,signal());await observeImages(executor,item,signal());assert.equal(calls.length,2);assert.deepEqual(calls[1].urls,images.map(a=>a.url));
});
test('B untouched E04 response preserves recorded error in legacy replay and cannot bypass current small contract',async()=>{
 const [f]=JSON.parse(await readFile(new URL('./fixtures/subtraction-captured.json',import.meta.url),'utf8'));
 assert.equal(createHash('sha256').update(f.rawText).digest('hex'),f.rawSha256);
 const raw=JSON.parse(f.rawText);assert.equal(raw.deliverables.length,2);assert.equal(raw.deliverables[1].action,'modify');assert.equal(raw.deliverables[1].changeContract,undefined);
 const options={...f.before,query:f.query,strictControl:true,auditContracts:true};let calls=0;
 await assert.rejects(understandGoal({respond:async()=>{calls++;return reply(raw);}},catalog,options,signal()),/格式错误/);assert.equal(calls,3);
 // This is explicitly an old response compatibility test, not a new-model success.
 // Captured opaque handles expire. Resolve them using the original captured
 // catalog only; action, count, description and evidence stay byte-equivalent.
 const bound=structuredClone(raw);for(const item of bound.deliverables)item.references=item.references.map(ref=>f.capturedReferenceCatalog.entries.find(e=>e.handle===ref)?.id||ref);
 const compatible=await understandGoal({respond:async()=>reply(bound)},catalog,{...options,legacyReplay:true},signal());
 assert.equal(compatible.tasks.length,2);assert.equal(compatible.tasks[1].operation,'edit_image');
});
test('B captured D01 split visual requests become one source-complete request; visual quality remains unverified',async()=>{
 const [,f]=JSON.parse(await readFile(new URL('./fixtures/subtraction-captured.json',import.meta.url),'utf8'));
 assert.equal(f.visionCalls.length,2);assert.ok(f.visionCalls.every(c=>c.input[1].content.filter(p=>p.type==='input_image').length===1));
 const item=structuredClone(f.item),state={taskStore:{tasks:{},artifacts:f.sources,inputs:{}}},calls=[];
 await observeImages({state,runtime:{execute:async(name,args)=>{calls.push(args);return {text:'模拟联合观察，只验证完整来源输入'};}},record:async()=>{},save:async()=>{}},item,signal());
 assert.equal(calls.length,1);assert.deepEqual(calls[0].urls,item.references.map(id=>f.sources[id].url));
});
test('A compact missing control repair locks the original target instead of requesting old continuation',async()=>{
 const raw=candidate('create',[d('text','标题',{form:'title'})]);delete raw.approval;let calls=0;
 const goal=await understandGoal({respond:async input=>{if(++calls===1)return reply(raw);const p=JSON.parse(input[1].content);assert.deepEqual(p.lockedDraft,raw);assert.deepEqual(p.missingPaths,['/approval']);return reply({approval:{required:false,reason:''}});}},catalog,{query:'标题',strictControl:true},signal());
 assert.equal(calls,2);assert.equal(goal.tasks[0].operation,'marketing_script');
});
test('A saved plan delta preserves facts, hard constraints and existing quote gate while reusing prior methods',async()=>{
 const old={id:'saved-plan',revision:2,status:'WAIT_CONFIRM',approval:{required:true,planHash:'saved-hash',payload:{items:[{prompt:'白杯，16:9，无字',duration:5,ratio:'16:9'}]}},goal:{semantic:{facts:['白杯'],globalConstraints:['无字','16:9'],deliverables:[{...d('video','白杯方案',{references:[],dependsOn:[],constraints:['无字'],spec:{ratio:'16:9',durationSeconds:5},requiredMethods:['video-script-zh-v1']}),purpose:'general',requiredEvidence:'none'}]},requestContract:{systemFacts:['quote']}}};
 old.approval.status='pending';old.approval.payload.itemId='video-node';
 old.executionPlan={nodes:[{itemId:'video-node',skillArtifactId:'saved-prompt'}]};old.artifacts=[{id:'saved-prompt',version:1,type:'prompt',content:'白杯5秒16:9'}];
 const request=candidate('revise_plan',[],{turnOperation:{kind:'revise_plan',targetTaskId:old.id},revisionDelta:{targetArtifactId:'saved-prompt',targetVersion:1,changes:[{field:'ratio',from:'16:9',to:'9:16'}],preserve:['duration','source','facts']}});
 const goal=await understandGoal({respond:async()=>reply(request)},catalog,{query:'改为9:16',taskSnapshot:old,taskCandidates:[old],strictControl:true,auditContracts:true},signal());
 assert.deepEqual(goal.semantic.facts,['白杯']);assert.deepEqual(goal.semantic.globalConstraints,['无字','9:16']);assert.deepEqual(goal.requestContract.systemFacts,['quote']);assert.deepEqual(goal.tasks[0].requiredMethods,[]);assert.equal(goal.semantic.approval.required,true);assert.equal(goal.tasks[0].spec.durationSeconds,5);
});
test('C ten sequential natural queries with explicitly simulated model and media, no injected predecessor artifacts',async()=>{
 const state={id:randomUUID(),messages:[],events:[]},submissions=[],requests=[],snapshots=[];
 let command,phase=0,serial=0;
 const brain={respond:async(input,tools)=>{
  assert.equal(tools.length,0);requests.push({phase,input});const prompt=input[0].content;
  if(prompt.startsWith('你是创作助手的本轮需求理解器'))return reply(command);
  if(prompt.startsWith('你是任务交付验证器'))return reply({outcome:'passed',issues:[]});
  if(prompt.startsWith('完成当前item或stage')){
   const payload=JSON.parse(input[1].content),content=phase===1?payload.item.description:'绿瓶采用绿色瓶身，轮廓简洁。浅灰背景衬托瓶子的外观。';
   return reply(payload.methods.length?{content,structure:{prompt:content,referenceRoles:[]}}:{content});
  }
  if(prompt.startsWith('你负责为当前已接受媒体节点')){
   const p=JSON.parse(input[1].content);
   if(p.goal.operation==='edit_image'){assert.ok(p.goal.changeContract.change.length);assert.ok(p.goal.changeContract.preserve.length);}
   return reply({concept:p.goal.description,preservedConstraints:p.goal.constraints,safety:{passed:true,reason:'离线方案'},items:Array.from({length:p.goal.count},()=>({prompt:p.goal.description,...(p.goal.operation==='generate_video'?{duration:5,ratio:'16:9',resolution:'720p',firstFrameUrl:p.goal.references[0]}:{size:'2048x2048',...(p.goal.references.length?{referenceImages:p.goal.references}:{})})}))});
  }
  if(input[1]?.content?.some?.(x=>x.type==='input_image'))return reply('观察到绿色瓶身和浅灰背景；没有性能证据。');
  throw Error('Unexpected simulated model phase: '+prompt.slice(0,80));
 }};
 const media={config:{imageModel:'isolated-stub',videoModel:'forbidden'},image:async args=>{submissions.push(structuredClone(args));return {status:'succeeded',simulated:true,images:[{url:'https://test.invalid/simulated-'+ ++serial+'.png'}]};},video:async()=>{throw Error('REAL VIDEO SUBMISSION FORBIDDEN');},getVideo:async()=>{throw Error('VIDEO POLL FORBIDDEN');}};
 const runtime=new ToolRuntime({catalog,brain,media}),agent=new Agent({effectPolicy:'trusted_embedder',catalog,brain,runtime,verifier:new Verifier(brain),simulation:true});
 const artifacts=()=>taskArtifacts(state).filter(a=>a.purpose==='deliverable');
 async function turn(query,value,status,expectedSubmissions){
  phase++;command={...value,summary:query};const before=submissions.length;
  await agent.run(state,query,()=>{},signal(),{requestId:'chain-'+phase});
  snapshots.push({phase,query,state:structuredClone(state),submissions:structuredClone(submissions)});
  if(process.env.MVP_DATA_DIR){await mkdir(process.env.MVP_DATA_DIR,{recursive:true});await writeFile(join(process.env.MVP_DATA_DIR,'subtraction-chain.json'),JSON.stringify({mode:'simulated_model_and_media',snapshots},null,2));}
  const final=state.events.filter(e=>e.type==='final').at(-1);
  assert.equal(final.status,status,'turn '+phase+': '+final.text);assert.equal(submissions.length-before,expectedSubmissions,'turn '+phase+' effect count');return final;
 }
 const specs={ratio:'1:1'},constraints=['无人','无字'];
 await turn('实际使用图片提示词案例导演，准备深蓝底白杯与浅灰底橙瓶两份独立提示词，均为1:1，无人无字，暂不生图',candidate('create',['深蓝底白杯','浅灰底橙瓶'].map(x=>d('text',x+'，1:1，无人无字',{form:'prompt',requiredMethods:['图片提示词案例导演（V2）'],constraints}))), 'completed',0);
 const prompts=artifacts();assert.equal(prompts.length,2);assert.ok(currentTask(state).items.every(i=>i.methods.some(m=>m.skillId==='image-prompt-gallery-director-v2'&&m.status==='validated')));
 await turn('根据这两份提示词生成两张产品图',candidate('create',prompts.map((a,i)=>d('image',i?'浅灰底橙瓶':'深蓝底白杯',{references:[a.id],spec:specs,constraints}))), 'simulated',2);
 let [cup,bottle]=artifacts();const originalBottle=bottle;
 await turn('只把橙瓶改成绿瓶，其他不动',candidate('modify',[d('image','瓶身改绿，其他不动',{action:'modify',references:[bottle.id],changeContract:{change:['瓶身改绿'],preserve:['背景构图不变']},spec:specs})]), 'simulated',1);
 assert.deepEqual(submissions.at(-1).referenceImages,[bottle.url]);bottle=artifacts()[0];assert.equal(bottle.parentId,originalBottle.id);
 await turn('给绿瓶写两句外观介绍，不生图、不编性能',candidate('observe',[d('text','给绿瓶写两句外观介绍，不编性能',{references:[bottle.id],form:'copy',requiredEvidence:'image',constraints:['只写可见外观','不编性能']})]), 'completed',0);
 await turn('回到白杯图，只改背景为米白',candidate('modify',[d('image','白杯背景改米白',{action:'modify',references:[cup.id],changeContract:{change:['背景改米白'],preserve:['白杯不变']},spec:specs})]), 'simulated',1);
 assert.deepEqual(submissions.at(-1).referenceImages,[cup.url]);cup=artifacts()[0];
 const beforeRead=JSON.stringify(state.taskStore),focus=state.taskStore.activeTaskId;
 const shown=await turn('展示当前白杯与绿瓶，不重新生成',candidate('present',[],{turnOperation:{kind:'present',presentation:{targets:[cup.id,bottle.id]}}}), 'completed',0);
 assert.equal(JSON.stringify(state.taskStore),beforeRead);assert.match(shown.text,new RegExp(cup.url.replaceAll('.','\\.')));assert.equal(state.taskStore.activeTaskId,focus);
 await agent.run(state,'展示当前白杯与绿瓶，不重新生成',()=>{},signal(),{requestId:'chain-6'});assert.equal(submissions.length,4);
 const retainedBottle=JSON.stringify(state.taskStore.artifacts[bottle.id]);
 await turn('明确额外新增一张同风格绿瓶，保留原图',candidate('create',[d('image','额外新增同风格绿瓶',{references:[bottle.id],spec:specs}),d('image','保留展示原图',{action:'present',references:[bottle.id]})]), 'simulated',1);
 assert.equal(JSON.stringify(state.taskStore.artifacts[bottle.id]),retainedBottle);assert.equal(artifacts().filter(a=>a.type==='image').length,1);
 await turn('根据米白底白杯图准备5秒16:9视频方案，不生成视频',candidate('create',[d('video','白杯展示5秒16:9',{references:[cup.id],spec:{durationSeconds:5,ratio:'16:9'},constraints:['5秒','16:9']})],{approval:{required:true,reason:'不生成视频'}}), 'needs_input',0);
 const old=currentTask(state),oldHash=old.approval.planHash,oldItems=structuredClone(old.approval.payload.items),beforePlans=requests.filter(r=>r.input[0].content.startsWith('你负责为当前已接受媒体节点')).length;
 const target=revisionTarget(taskSnapshot(state));
 await turn('修改为9:16，仍不生成视频',candidate('revise_plan',[],{turnOperation:{kind:'revise_plan',targetTaskId:old.id},revisionDelta:{targetArtifactId:target.targetArtifactId,targetVersion:target.targetVersion,changes:[{field:'ratio',from:'16:9',to:'9:16'}],preserve:['duration','source','facts']},approval:{required:true,reason:'仍不生成视频'}}), 'needs_input',0);
 const revised=currentTask(state);assert.equal(requests.filter(r=>r.input[0].content.startsWith('你负责为当前已接受媒体节点')).length,beforePlans);assert.equal(revised.approval.payload.items[0].ratio,'9:16');assert.equal(revised.approval.payload.items[0].duration,5);assert.equal(revised.approval.payload.items[0].firstFrameUrl,cup.url);assert.deepEqual(old.approval.payload.items,oldItems);assert.notEqual(revised.approval.planHash,oldHash);assert.throws(()=>approveTask(state,revised.id,oldHash));assert.throws(()=>approveTask(state,old.id,oldHash));
 const final=await turn('展示实际保存的最新参数，不重新创作方案',candidate('inspect',[],{turnOperation:{kind:'inspect',targetTaskId:revised.id,query:{kind:'plan'}}}), 'completed',0);
 assert.match(final.text,/9:16/);assert.match(final.text,/实际保存的执行参数/);assert.equal(submissions.length,5);
 assert.equal(state.turns.length,10);assert.equal(state.modelCalls.filter(c=>JSON.stringify(c.input).includes('独立提取原始请求')).length,0);
});
