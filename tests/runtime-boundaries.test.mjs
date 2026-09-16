import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {loadCatalog} from '../server/catalog.mjs';
import {understandGoal,semanticSchema} from '../server/intent.mjs';
import {operationInputSchema,inspectionGoal} from '../server/turn-operation.mjs';
import {missingFieldPlan,applyMissingFields} from '../server/structured-repair.mjs';
import {intentSnapshot,assertIntentPreserved,assertIntentSnapshot} from '../server/intent-snapshot.mjs';
import {createTask,addArtifact,reconcileTask,storeOf} from '../server/task-state.mjs';
import {completionFacts} from '../server/task-requirements.mjs';
import {composeFinalResponse} from '../server/final-response.mjs';
import {compactIntakePayload} from '../server/model-context.mjs';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
import {assistantProse} from '../dist/reply-view.js';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=x=>[{type:'message',role:'assistant',content:[{type:'output_text',text:typeof x==='string'?x:JSON.stringify(x)}]}];
const draft=()=>({summary:'先创建主体图，再基于它修改场景',turnOperation:{kind:'create'},deliverables:[
 {description:'创建主体图',kind:'image',action:'create',count:1,dependsOn:[],references:[],constraints:[]},
 {description:'基于主体图修改场景',kind:'image',action:'create',count:1,dependsOn:[0],references:['task:0'],constraints:[]}
],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''}});
function fixture(){
 const d=draft(),s={id:'runtime-boundaries',messages:[],events:[]};
 const goal={summary:d.summary,semantic:d,safety:d.safety,assumptions:[],missingInputs:[],intentSnapshot:intentSnapshot('先创建主体图，再改场景',d),tasks:d.deliverables.map(i=>({description:i.description,operation:'generate_image',output:'image',count:1,dependsOn:i.dependsOn,references:i.references,constraints:[],spec:{},requiredMethods:[],requiredEvidence:'none'}))};
 const task=createTask(s,goal,goal.intentSnapshot.query);task.validationPolicy='strict';
 return {s,task};
}
function image(s,task,index){
 const id='exec'+index;s.taskStore.executions[id]={id,taskId:task.id,itemId:task.items[index].id,tool:'generate_image',status:'succeeded'};
 return addArtifact(s,{itemId:task.items[index].id,type:'image',sourceExecutionId:id,url:'https://example.com/'+index+'.png',verification:{technical:'passed',semantic:'passed'}});
}
test('Case1 schema field repair preserves both image requirements and their dependency',()=>{
 const d=draft();d.deliverables[0].purpose='general';delete d.safety;
 const snapshot=intentSnapshot('two steps',d),schema=operationInputSchema(semanticSchema),plan=missingFieldPlan(d,schema);
 assert.ok(plan);assert.ok(plan.paths.includes('/safety'));assert.ok(plan.removePaths.includes('/deliverables/0/purpose'));
 const patch=Object.fromEntries(plan.paths.map(path=>[plan.keys[path],path==='/safety'?draft().safety:null]));
 const repaired=applyMissingFields(d,patch,plan);
 assert.equal(new Ajv({strict:false}).compile(schema)(repaired),true);
 assertIntentPreserved(snapshot,repaired);assert.equal(repaired.deliverables.length,2);assert.deepEqual(repaired.deliverables[1].dependsOn,[0]);
 assert.equal(d.deliverables[0].purpose,'general');
});
test('schema patches cannot replace the entire plan or drop a slot',()=>{
 const d=draft();delete d.safety;const plan=missingFieldPlan(d,operationInputSchema(semanticSchema));
 assert.throws(()=>applyMissingFields(d,{...draft(),deliverables:[draft().deliverables[0]]},plan));
 const snapshot=intentSnapshot('two steps',d);
 assert.throws(()=>assertIntentPreserved(snapshot,{...d,deliverables:[d.deliverables[0]]}),/义务/);
 const reversed=structuredClone(d);reversed.deliverables[1].dependsOn=[];
 assert.throws(()=>assertIntentPreserved(snapshot,reversed),/义务/);
});
test('intent snapshot rejects persisted tampering after JSON reload',()=>{
 const snapshot=JSON.parse(JSON.stringify(intentSnapshot('two steps',draft())));
 assertIntentSnapshot(snapshot);snapshot.deliverables.pop();assert.throws(()=>assertIntentSnapshot(snapshot),/Snapshot/);
});
test('real intake accepts only a field patch and exposes an immutable two-step snapshot',async()=>{
 const d=draft();d.deliverables[0].purpose='general';let calls=0;
 const brain={respond:async(input,tools)=>{assert.equal(tools.length,0);calls++;
  if(calls===1)return reply(d);
  const payload=JSON.parse(input[1].content);assert.equal(payload.lockedDraft.deliverables.length,2);
  return reply(Object.fromEntries(payload.paths.map(path=>[payload.fieldKeys[path],null])));
 }};
 const goal=await understandGoal(brain,catalog,{query:'创建主体图，再基于它修改场景',strictControl:true,auditContracts:true},signal());
 assert.equal(calls,2);assert.equal(goal.tasks.length,2);assert.equal(goal.intentSnapshot.deliverables.length,2);assert.deepEqual(goal.tasks[1].dependsOn,[0]);
});
test('illegal operation enum is patched in place without changing a query goal',()=>{
 const d=draft();d.turnOperation.kind='query';const plan=missingFieldPlan(d,operationInputSchema(semanticSchema));
 assert.deepEqual(plan.paths,['/turnOperation/kind']);
 const repaired=applyMissingFields(d,{[plan.keys['/turnOperation/kind']]:'create'},plan);
 assert.deepEqual(repaired.deliverables,d.deliverables);
});
test('Case2 one image delivered and second execution failed leaves Task PENDING',()=>{
 const {s,task}=fixture();image(s,task,0);task.items[1].status='BLOCKED';task.items[1].issues.push('provider failure');
 s.taskStore.executions.failed={taskId:task.id,itemId:task.items[1].id,status:'failed'};
 reconcileTask(s);assert.equal(task.status,'PENDING');assert.equal(task.completionStatus,'pending');
 assert.deepEqual(task.requirements.map(r=>r.status),['fulfilled','pending']);
 assert.deepEqual(completionFacts(task,s.taskStore).byType.image,{required:2,produced:1,fulfilled:1,remaining:1});
});
test('removing a pending execution item cannot remove its requirement or complete task',()=>{
 const {s,task}=fixture();image(s,task,0);task.items.pop();reconcileTask(s);
 assert.equal(task.requirements.length,2);assert.equal(task.status,'PENDING');assert.equal(task.requirements[1].status,'pending');
});
test('requirement definitions cannot be silently reduced during retry',()=>{
 const {s,task}=fixture();task.requirements[0].count=0;assert.throws(()=>reconcileTask(s),/Requirement/);
});
test('artifact DAG records actual predecessor artifact and task completes only after both requirements',()=>{
 const {s,task}=fixture();const a=image(s,task,0);reconcileTask(s);const b=image(s,task,1);reconcileTask(s);
 assert.deepEqual(a.dependsOn,[]);assert.equal(a.parentArtifact,null);assert.ok(b.dependsOn.includes(a.id));assert.equal(task.status,'COMPLETED');
 const restored=JSON.parse(JSON.stringify(s));reconcileTask(restored);assert.equal(restored.taskStore.tasks[task.id].completionStatus,'fulfilled');
});
test('Case3 status query supplies required/produced/remaining and passes through composer without new task',async()=>{
 const {s,task}=fixture();image(s,task,0);reconcileTask(s);const taskCount=Object.keys(s.taskStore.tasks).length;
 const semantic={...draft(),deliverables:[],turnOperation:{kind:'inspect',targetTaskId:task.id,query:{kind:'task'},answerContract:{questionDimensions:['completion_status','required_count','produced_count','remaining_count'],scope:'task'}}};
 let finalCalls=0;const brain={respond:async(input,tools,_signal,options)=>{
  assert.equal(options.tracePhase,'final_response');assert.deepEqual(tools,[]);finalCalls++;
  const data=JSON.parse(input[1].content),counts=data.state.selectedTasks[0].byType.image;
  assert.equal(counts.required,2);assert.equal(counts.produced,1);assert.equal(counts.remaining,1);
  return reply('还未完成。要求2张，已生成1张，还缺1张。');
 }};
 const agent=new Agent({effectPolicy:'trusted_embedder',brain,catalog,runtime:{brain},intake:async()=>inspectionGoal('完成了吗，要求几张，做了几张',semantic,[task],[])});
 await agent.run(s,'完成了吗，要求几张，做了几张',()=>{},signal());
 assert.equal(finalCalls,1);assert.equal(Object.keys(s.taskStore.tasks).length,taskCount);assert.equal(s.taskStore.activeTaskId,task.id);
 assert.match(s.events.at(-1).text,/要求2张.*已生成1张.*还缺1张/);assert.equal(s.turns.at(-1).responseReceipt.status,'composed');
});
test('Case4 summarize skill performs intake and composer without creating a production task',async()=>{
 const s={id:'summarize',messages:[],events:[]},calls=[];
 const brain={respond:async(input,tools,_signal,options)=>{
  calls.push(options.tracePhase);assert.deepEqual(tools,[]);
  if(options.tracePhase==='understand')return reply({...draft(),summary:'概括Skill内容',deliverables:[],turnOperation:{kind:'summarize',query:{kind:'skill_detail',targets:['creative-prompt-rewrite']}}});
  assert.equal(options.tracePhase,'final_response');const data=JSON.parse(input[1].content);assert.ok(data.facts.skillInstructions.content.length>1000);
  return reply('它把创意要求整理成可执行提示词，并保留原有主体和限制。');
 }};
 const agent=new Agent({effectPolicy:'trusted_embedder',brain,catalog,runtime:{brain}});
 await agent.run(s,'总结一下提示词改写skill',()=>{},signal());
 assert.deepEqual(calls,['understand','final_response']);assert.equal(Object.keys(s.taskStore.tasks).length,0);assert.equal(Object.keys(s.taskStore.artifacts).length,0);assert.equal(s.events.at(-1).status,'completed');
});
test('final composer has no state mutation or tool execution authority even with malicious output',async()=>{
 const {s,task}=fixture(),turn={rawInput:'完成了吗'},before=JSON.stringify(s.taskStore);let count=0;
 const text=await composeFinalResponse({respond:async()=>{count++;return [{type:'function_call',name:'generate_image',arguments:'{}'}];}},s,turn,{text:'未全部完成',taskId:task.id,artifacts:[],status:'limited'},signal());
 assert.match(text,/尚未全部完成/);assert.equal(count,0);assert.equal(JSON.stringify(s.taskStore),before);assert.equal(turn.responseReceipt.status,'composed');
});
test('final composer failure never resubmits or removes a previously generated image',async()=>{
 const {s,task}=fixture(),a=image(s,task,0),before=JSON.stringify(s.taskStore),turn={rawInput:'生成'};
 await composeFinalResponse({respond:async()=>{throw new Error('timeout');}},s,turn,{text:'已生成一张',taskId:task.id,artifacts:[a],status:'limited'},signal());
 assert.equal(JSON.stringify(s.taskStore),before);assert.equal(turn.responseReceipt.status,'composed');
});
test('duplicate assistant context is retained once with resolvable source pointers',()=>{
 const body='skill source'.repeat(1000),payload={conversation:{recentMessages:[{messageId:'a',role:'assistant',content:body},{messageId:'b',role:'assistant',content:body},{messageId:'c',role:'user',content:'总结'}]}};
 compactIntakePayload(payload);assert.equal(payload.conversation.recentMessages[0].content,undefined);assert.equal(payload.conversation.recentMessages[0].contentMessageId,'b');assert.equal(payload.conversation.recentMessages[1].content,body);
});
test('compiled two-image pipeline submits in dependency order and binds actual first result',async()=>{
 const s={id:'compiled-two-images',messages:[],events:[]},submissions=[],phases=[];
 const brain={respond:async(input,tools,_signal,options)=>{
  phases.push(options.tracePhase);
  if(options.tracePhase==='understand')return reply(draft());
  if(options.tracePhase==='final_response')return reply('两步都已完成。');
  assert.equal(options.tracePhase,'media_plan');
  const data=JSON.parse(input[1].content),refs=data.goal.references||[];
  return reply({concept:'执行当前图片目标',preservedConstraints:[],safety:{passed:true,reason:'普通创作内容'},items:[{prompt:'image '+submissions.length,size:'2048x2048',...(refs.length?{referenceImages:refs}:{})}]});
 }};
 const media={config:{imageModel:'fixture'},image:async args=>{submissions.push(structuredClone(args));return {status:'succeeded',images:[{url:'https://example.com/result-'+submissions.length+'.png'}]};},video:async()=>{throw new Error('video is forbidden');}};
 const runtime=new ToolRuntime({catalog,brain,media});
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,verifier:new Verifier(brain,{policy:'delivery_only'})}).run(s,'先创建主体图，再以第一张图修改场景',()=>{},signal());
 const task=s.taskStore.tasks[s.taskStore.activeTaskId];
 assert.equal(submissions.length,2,JSON.stringify({status:task.status,reason:task.reason,recovery:task.recovery}));
 assert.deepEqual(submissions[1].referenceImages,['https://example.com/result-1.png']);
 assert.equal(task.status,'COMPLETED');assert.deepEqual(task.requirements.map(r=>r.status),['fulfilled','fulfilled']);
 const images=Object.values(s.taskStore.artifacts).filter(a=>a.type==='image');assert.ok(images[1].dependsOn.includes(images[0].id));
 assert.deepEqual(phases,['understand','media_plan','media_plan']);
});
test('answer, summarize and explain never accept a hidden image production obligation',async()=>{
 for(const kind of ['answer','summarize','explain']){
  const d=draft();d.turnOperation.kind=kind;
  await assert.rejects(understandGoal({respond:async()=>reply(d)},catalog,{query:'test',strictControl:true,auditContracts:true},signal()),/非生产回答/);
 }
});
test('final response replay is idempotent and does not call composer again',async()=>{
 const s={id:'replay-answer',messages:[],events:[]};let calls=0;
 const brain={respond:async(_input,_tools,_signal,options)=>{calls++;return options.tracePhase==='understand'?reply({...draft(),deliverables:[],turnOperation:{kind:'answer'}}):reply('可以继续沟通。');}};
 const agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime:{brain},catalog}),control={requestId:'same-request'};
 await agent.run(s,'你好',()=>{},signal(),control);const count=calls;
 await agent.run(s,'你好',()=>{},signal(),control);assert.equal(calls,count);assert.equal(s.turns.length,1);assert.equal(Object.keys(s.taskStore.tasks).length,0);
});
test('assistant prose displays transport escapes but leaves code and literal examples intact',()=>{
 assert.equal(assistantProse('可以。\\n\\n**generate\\_image**'),'可以。\n\n**generate_image**');
 const code=String.fromCharCode(96)+'a\\nb'+String.fromCharCode(96)+' 与 "\\n"';
 assert.equal(assistantProse(code),code);
 assert.equal(assistantProse('正常\n换行'),'正常\n换行');
});
test('runtime rejects whole-plan repair and persists the original two requirements without any execution',async()=>{
 const s={id:'reject-plan-regeneration',messages:[],events:[]};let repairs=0;
 const brain={respond:async(_input,_tools,_signal,options)=>{
  if(options.tracePhase==='final_response')return reply({artifactIds:[]});
  repairs++;const d=draft();if(repairs===1)d.deliverables[0].purpose='general';else d.deliverables.pop();return reply(d);
 }};
 await new Agent({effectPolicy:'trusted_embedder',brain,catalog,runtime:{brain}}).run(s,'先主体图再背景图',()=>{},signal());
 assert.equal(repairs,3);assert.equal(s.turns[0].intentSnapshot,undefined);assert.equal(s.turns[0].draftIntentSnapshot.deliverables.length,2);assertIntentSnapshot(s.turns[0].draftIntentSnapshot);
 assert.equal(s.events.at(-1).status,'failed');assert.equal(Object.keys(s.taskStore.executions).length,0);assert.equal(Object.keys(s.taskStore.tasks).length,0);
 assert.equal(s.turns[0].responseReceipt.status,'composed');
});
test('query composer failure cannot be reported as answered or complete and preserves creative focus',async()=>{
 const {s,task}=fixture();const semantic={...draft(),deliverables:[],turnOperation:{kind:'inspect',query:{kind:'task'},targetTaskId:task.id}};
 const brain={respond:async()=>{throw new Error('answer unavailable');}};
 const agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime:{brain},catalog,intake:async()=>inspectionGoal('完成了吗',semantic,[task],[])});
 await agent.run(s,'完成了吗',()=>{},signal());
 assert.equal(s.events.at(-1).status,'failed');assert.equal(s.turns.at(-1).queryReceipt.checks.answerCovered,false);
 assert.equal(s.taskStore.activeTaskId,task.id);assert.equal(Object.keys(s.taskStore.tasks).length,1);
});

test('repair fills a missing description without replacing the understood deliverables',()=>{
 const d=draft();delete d.deliverables[1].description;
 const snapshot=intentSnapshot('two image steps',d),plan=missingFieldPlan(d,operationInputSchema(semanticSchema));
 assert.deepEqual(plan.paths,['/deliverables/1/description']);
 const repaired=applyMissingFields(d,{[plan.keys[plan.paths[0]]]:'基于第一张修改背景'},plan);
 assertIntentPreserved(snapshot,repaired);assert.deepEqual(repaired.deliverables[1].dependsOn,[0]);
});

test('schema repair cannot change summary, file count or existing change constraints',()=>{
 const d=draft();d.deliverables[0]={...d.deliverables[0],kind:'text',artifactCount:2,spec:{ratio:'16:9'},changeContract:{change:['ratio'],preserve:['subject']}};
 const snapshot=intentSnapshot(d.summary,d);
 for(const mutate of [v=>v.summary='different request',v=>v.deliverables[0].artifactCount=1,v=>v.deliverables[0].spec.ratio='9:16',v=>v.deliverables[0].changeContract.preserve=[]]){
  const changed=structuredClone(d);mutate(changed);assert.throws(()=>assertIntentPreserved(snapshot,changed),/义务/);
 }
});

test('a later image revision does not erase fulfillment of its predecessor requirement',()=>{
 const {s,task}=fixture();const first=image(s,task,0);reconcileTask(s);
 s.taskStore.executions.exec1={id:'exec1',taskId:task.id,itemId:task.items[1].id,status:'succeeded'};
 const second=addArtifact(s,{itemId:task.items[1].id,type:'image',sourceExecutionId:'exec1',parentId:first.id,url:'https://example.com/revised.png',verification:{technical:'passed',semantic:'passed'}});
 reconcileTask(s);reconcileTask(s);
 assert.equal(s.taskStore.artifacts[first.id].publication,'superseded');
 assert.equal(task.status,'COMPLETED');assert.deepEqual(task.requirements.map(r=>r.status),['fulfilled','fulfilled']);
 assert.deepEqual(completionFacts(task,s.taskStore).byType.image,{required:2,produced:2,fulfilled:2,remaining:0});
 assert.equal(second.parentArtifact,first.id);
});

test('summary reads the selected catalog handle as full source content without a new task',async()=>{
 const {s,task}=fixture();const source=addArtifact(s,{itemId:task.items[0].id,type:'text',content:'原始方案：蓝底白杯。完整的卖点与使用场景。',verification:{technical:'passed',semantic:'passed'}});
 const before=Object.keys(s.taskStore.tasks).length;
 const brain={respond:async(input,_tools,_signal,options)=>{
  const data=JSON.parse(input[1].content);
  if(options.tracePhase==='understand'){
   const ref=data.referenceCatalog.entries.find(r=>r.id===source.id).handle;
   return reply({...draft(),summary:'概括原方案',turnOperation:{kind:'summarize'},deliverables:[{kind:'text',action:'respond',description:'总结指定方案',references:[ref]}]});
  }
  assert.equal(options.tracePhase,'final_response');assert.equal(data.selectedSources[0].id,source.id);assert.equal(data.selectedSources[0].content,source.content);
  return reply('方案以蓝底白杯为主体，介绍卖点及使用场景。');
 }};
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime:{brain},catalog}).run(s,'总结这份方案',()=>{},signal());
 assert.equal(s.events.at(-1).status,'completed');assert.equal(Object.keys(s.taskStore.tasks).length,before);
 assert.equal(s.taskStore.activeTaskId,task.id);
});

test('compiled creation then modification retains both deliveries and exact parent version',async()=>{
 const s={id:'create-then-modify',messages:[],events:[]},submissions=[];
 const brain={respond:async(input,_tools,_signal,options)=>{
  if(options.tracePhase==='understand'){
   const d=draft();d.deliverables[1].action='modify';d.deliverables[1].changeContract={change:['background'],preserve:['subject']};return reply(d);
  }
  if(options.tracePhase==='final_response'){
   const data=JSON.parse(input[1].content);assert.equal(data.artifacts.length,2);assert.ok(data.artifacts.every(a=>a.accepted));return reply({artifactIds:data.artifacts.map(a=>a.id)});
  }
  const refs=JSON.parse(input[1].content).goal.references||[];
  return reply({concept:'当前图片',preservedConstraints:[],safety:{passed:true,reason:'ordinary'},items:[{prompt:'product picture',size:'2048x2048',...(refs.length?{referenceImages:refs}:{})}]});
 }};
 const media={config:{imageModel:'fixture'},image:async args=>{submissions.push(args);return {status:'succeeded',images:[{url:'https://example.com/edit-'+submissions.length+'.png',size:'2048x2048'}]};}};
 const runtime=new ToolRuntime({catalog,brain,media});
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,verifier:new Verifier(brain,{policy:'delivery_only'})}).run(s,'先创建一张，再改背景，交付两张',()=>{},signal());
 const task=s.taskStore.tasks[s.taskStore.activeTaskId],images=Object.values(s.taskStore.artifacts).filter(a=>a.type==='image');
 assert.equal(submissions.length,2);assert.equal(task.status,'COMPLETED');assert.equal(images[1].parentArtifact,images[0].id);
 assert.equal(images[1].version,2);assert.equal(s.events.at(-1).artifacts.length,2);assert.equal(s.turns.at(-1).responseReceipt.status,'composed');
 assert.ok(s.events.at(-1).text.includes(images[0].url));assert.ok(s.events.at(-1).text.includes(images[1].url));
});

test('compiled partial failure, status question and explicit resume preserve one task and avoid resubmitting first image',async()=>{
 const s={id:'partial-query-resume',messages:[],events:[]},calls=[];let failing=true;
 const brain={respond:async(input,_tools,_signal,options)=>{
  if(options.tracePhase==='understand'){
   const data=JSON.parse(input[1].content);
   if(!data.taskSnapshot)return reply(draft());
   return reply({...draft(),deliverables:[],turnOperation:{kind:'inspect',targetTaskId:data.taskSnapshot.id,query:{kind:'task'},answerContract:{questionDimensions:['required_count','produced_count','remaining_count'],scope:'task'}}});
  }
  if(options.tracePhase==='final_response')return reply('依据任务账本说明本轮结果。');
  const refs=JSON.parse(input[1].content).goal.references||[];
  return reply({concept:'当前图片',preservedConstraints:[],safety:{passed:true,reason:'ordinary'},items:[{prompt:'product picture',size:'2048x2048',...(refs.length?{referenceImages:refs}:{})}]});
 }};
 const media={config:{imageModel:'fixture'},image:async args=>{
  calls.push(structuredClone(args));if(args.referenceImages?.length&&failing)return {isError:true,status:'failed',text:'known provider failure'};
  return {status:'succeeded',images:[{url:args.referenceImages?.length?'https://example.com/resumed.png':'https://example.com/first.png'}]};
 }};
 const runtime=new ToolRuntime({catalog,brain,media}),agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,verifier:new Verifier(brain,{policy:'delivery_only'})});
 await agent.run(s,'两张依赖图片',()=>{},signal());
 const task=s.taskStore.tasks[s.taskStore.activeTaskId];assert.equal(task.status,'PENDING');assert.deepEqual(task.requirements.map(r=>r.status),['fulfilled','pending']);
 await agent.run(s,'完成了吗，要求几张，做了几张',()=>{},signal());
 assert.equal(Object.keys(s.taskStore.tasks).length,1);assert.equal(s.taskStore.activeTaskId,task.id);
 assert.deepEqual(s.turns.at(-1).queryReceipt.facts.completion[0].byType.image,{required:2,produced:1,fulfilled:1,remaining:1});
 failing=false;await agent.run(s,'继续',()=>{},signal(),{resumeTaskId:task.id});
 assert.equal(task.status,'COMPLETED',JSON.stringify({reason:task.reason,recovery:task.recovery,items:task.items.map(i=>({status:i.status,issues:i.issues})),batches:task.batches,executions:s.taskStore.executions}));assert.equal(calls.filter(c=>!c.referenceImages?.length).length,1);
 assert.equal(Object.keys(s.taskStore.tasks).length,1);assert.deepEqual(task.requirements.map(r=>r.status),['fulfilled','fulfilled']);
});
