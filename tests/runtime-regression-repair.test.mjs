import test from 'node:test';
import assert from 'node:assert/strict';
import {understandGoal} from '../server/intent.mjs';
import {Agent} from '../server/agent.mjs';
import {Agent as LegacyAgent} from '../server/agent-loop.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {composeFinalResponse} from '../server/final-response.mjs';
import {assertIntentSnapshot} from '../server/intent-snapshot.mjs';
import {withTrace,tracedBrain} from '../server/trace-context.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=value=>[{type:'message',content:[{type:'output_text',text:typeof value==='string'?value:JSON.stringify(value)}]}];
const safety={disposition:'allow',untrustedInstructions:false,reason:''};
const draft=()=>({summary:'两个图片成果',turnOperation:{kind:'create'},deliverables:[{kind:'image',action:'create',count:1,description:'主体图'},{kind:'image',action:'create',count:1,description:'第二个背景',dependsOn:[0],references:['task:0']}],safety,approval:{required:false,reason:''}});

test('missing summary preserves the already parsed two-item snapshot during field repair',async()=>{
 const raw=draft();delete raw.summary;let calls=0;
 const brain={respond:async(input,tools)=>{
  assert.deepEqual(tools,[]);if(++calls===1)return reply(raw);
  const patch=JSON.parse(input[1].content);assert.deepEqual(patch.paths,['/summary']);assert.equal(patch.lockedDraft.deliverables.length,2);
  return reply({[patch.fieldKeys['/summary']]:'两个图片成果'});
 }};
 const goal=await understandGoal(brain,catalog,{query:'做两张，第二张依赖第一张',strictControl:true},signal());
 assert.equal(calls,2);assert.equal(goal.tasks.length,2);assert.deepEqual(goal.tasks[1].dependsOn,[0]);assertIntentSnapshot(goal.intentSnapshot);
});

test('a non-intent response can retry intake but the first parsed intent is recorded exactly once',async()=>{
 const state={currentRunId:'bootstrap',turns:[{runId:'bootstrap'}],taskStore:{tasks:{}}};let calls=0;
 const brain=tracedBrain({respond:async()=>reply(++calls===1?{invalid:true}:draft())});
 const goal=await withTrace(state,async()=>{},()=>understandGoal(brain,catalog,{query:'两个图片成果',strictControl:true},signal()));
 assert.equal(calls,2);assert.equal(goal.intentSnapshot.deliverables.length,2);
 assert.equal(state.modelCalls.flatMap(c=>c.validations||[]).filter(v=>v.phase==='intent_snapshot').length,1);
 assert.equal(state.turns[0].intentSnapshot.hash,goal.intentSnapshot.hash);
});

test('an observation routing contradiction repairs only operation kind and preserves visual obligation',async()=>{
 const image={id:'source',kind:'image',url:'https://example.com/source.png'},raw={...draft(),summary:'分析图片',turnOperation:{kind:'inspect',query:{kind:'artifacts'}},deliverables:[{kind:'text',action:'respond',description:'描述真实图片',requiredEvidence:'image',references:['source']}]};let calls=0;
 const goal=await understandGoal({respond:async(input)=>{
  if(++calls===1)return reply(raw);
  const p=JSON.parse(input[1].content);assert.deepEqual(p.paths,['/turnOperation/kind']);
  return reply({[p.fieldKeys[p.paths[0]]]:'observe'});
 }},catalog,{query:'分析图片',assets:[image]},signal());
 assert.equal(calls,2);assert.equal(goal.tasks[0].operation,'analyze_image');assert.equal(goal.tasks[0].requiredEvidence,'image');assert.deepEqual(goal.tasks[0].references,['source']);
});

test('image edit unit-selector removal cannot change the actual image or its modification request',async()=>{
 const source={id:'cup',type:'image',url:'https://example.com/cup.png'},raw={...draft(),summary:'改背景',deliverables:[{kind:'image',action:'modify',count:1,description:'背景改米白，杯子不动',references:['cup'],changeContract:{change:['背景米白'],preserve:['杯子']},sourceSelection:{source:'expired-handle',unitType:'products',mode:'selected',unitIds:['invented-unit'],layout:'separate_images'}}]};let calls=0;
 const goal=await understandGoal({respond:async input=>{
  if(++calls===1)return reply(raw);
  const p=JSON.parse(input[1].content);assert.deepEqual(p.removePaths,['/deliverables/0/sourceSelection']);return reply({[p.fieldKeys[p.paths[0]]]:null});
 }},catalog,{query:'背景改米白，杯子不动',assets:[source]},signal());
 assert.equal(calls,2);assert.equal(goal.tasks[0].operation,'edit_image');assert.deepEqual(goal.tasks[0].references,['cup']);assert.deepEqual(goal.tasks[0].changeContract,raw.deliverables[0].changeContract);assert.equal(goal.tasks[0].sourceSelection,undefined);
});

test('legacy completed text survives a terse final composer without inventing semantic acceptance',async()=>{
 const state={id:'legacy-delivery',messages:[],events:[]};let executionCalls=0,answerCalls=0;
 const brain={respond:async(input,_tools,_signal,options)=>{
  if(options?.tracePhase==='final_response'){
   answerCalls++;const artifact=JSON.parse(input[1].content).artifacts[0];assert.equal(artifact.accepted,false);assert.equal(artifact.delivered,true);return reply({artifactIds:[artifact.id]});
  }
  if(++executionCalls===1)return [{type:'function_call',call_id:'commit',name:'commit_text_deliverable',arguments:JSON.stringify({content:'正式广告文案：清晨一杯，轻松出发。'})}];
  return reply('完成');
 }};
 const runtime=new ToolRuntime({catalog,brain,media:{config:{}}});
 const intake=async()=>({summary:'写文案',tasks:[{operation:'answer',output:'text',count:1,references:[],dependsOn:[],constraints:[],requiredEvidence:'none'}],skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety});
 await new LegacyAgent({brain,runtime,catalog,intake}).run(state,'写文案',()=>{},signal());
 assert.equal(state.status,'completed');assert.equal(answerCalls,0);assert.match(state.events.at(-1).text,/正式广告文案：清晨一杯/);assert.equal(state.events.at(-1).responseReceipt.status,'composed');
});

test('presentation composer appends a bound image even if its prose omits the image',async()=>{
 const turn={rawInput:'展示原图',queryReceipt:{facts:{query:{type:'presentation'},entries:[{id:'old',type:'image',version:2,url:'https://example.com/old.png'}]}}};
 const text=await composeFinalResponse({respond:async(_input,tools)=>{assert.deepEqual(tools,[]);return reply('这是原来的图片。');}},{messages:[]},turn,{status:'completed',artifacts:[],text:''},signal());
 assert.match(text,/!\[图片 v2\]\(https:\/\/example.com\/old.png\)/);assert.equal(turn.responseReceipt.status,'composed');
});

test('real Runtime records intake and composer separately with no production task for a query',async()=>{
 const state={id:'query-phases',messages:[],events:[]},phases=[];
 const brain={config:{model:'configured-test-model'},respond:async(input,tools,_signal,options)=>{
  phases.push(options.tracePhase);assert.deepEqual(tools,[]);
  if(options.tracePhase==='understand')return reply({...draft(),summary:'模型身份',turnOperation:{kind:'inspect',query:{kind:'model_identity'}},deliverables:[]});
  assert.equal(JSON.parse(input[1].content).facts.modelIdentity.configuredModel,'configured-test-model');return reply('当前配置的模型是 configured-test-model。');
 }};
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime:{brain},catalog}).run(state,'现在是什么模型',()=>{},signal());
 assert.deepEqual(phases,['understand','final_response']);assert.deepEqual(state.modelCalls.map(c=>c.tracePhase),phases);assert.equal(Object.keys(state.taskStore.tasks).length,0);assert.equal(Object.keys(state.taskStore.artifacts).length,0);assert.equal(state.events.at(-1).status,'completed');
});
