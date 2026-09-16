import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadCatalog} from '../server/catalog.mjs';
import {understandGoal} from '../server/intent.mjs';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
import {currentTask,taskArtifacts} from '../server/task-state.mjs';
import {registerRequestInputs,bindRequestEvidence,validateTextInputs} from '../server/request-input.mjs';
import {ReferenceCatalog} from '../server/reference-catalog.mjs';
import {sourceUnits,bindSourceSelection} from '../server/source-coverage.mjs';
import {checkPreconditions} from '../server/tool-policy.mjs';
import {composeFinalResponse} from '../server/final-response.mjs';
import {redactDebug} from '../server/debug-trace.mjs';
const catalog=await loadCatalog(),safety={disposition:'allow',untrustedInstructions:false,reason:''};
const reply=x=>[{type:'message',content:[{type:'output_text',text:typeof x==='string'?x:JSON.stringify(x)}]}];
const sig=()=>new AbortController().signal;
const text=(description,extra={})=>({description,kind:'text',action:'create',count:1,form:'copy',...extra});
const contract=(...deliverables)=>({summary:'本轮需求',turnOperation:{kind:'create'},deliverables,safety,approval:{required:false,reason:''}});
const native=(actionType,extra={})=>({summary:'本轮需求',safety,businessActions:[{id:'a',actionType,intent:'本轮需求',...extra}]});
const intakeReplays=[];
after(async()=>{if(process.env.FOUNDATIONS_TRACE_DIR)await writeFile(join(process.env.FOUNDATIONS_TRACE_DIR,'corrected-draft-traces.json'),JSON.stringify({evidenceType:'local_model_fixture',paidCalls:0,replays:intakeReplays},null,2));});
async function understand(drafts,options={}){let calls=0;const inputs=[],outputs=[];const goal=await understandGoal({respond:async input=>{inputs.push(structuredClone(input));const d=drafts[Math.min(calls++,drafts.length-1)],output=reply(typeof d==='function'?d(JSON.parse(input[1].content)):d);outputs.push(structuredClone(output));return output;}},catalog,{query:'本轮需求',actionMode:'core',strictControl:true,auditContracts:true,...options},sig());intakeReplays.push({query:options.query||'本轮需求',inputs,outputs,goal});return {goal,calls,inputs};}
function sample(schema){
 if(schema.const!==undefined)return schema.const;if(schema.enum)return schema.enum[0];
 if(schema.type==='object')return Object.fromEntries((schema.required||[]).map(k=>[k,sample(schema.properties[k])]));
 if(schema.type==='array')return Array.from({length:schema.minItems??1},()=>sample(schema.items));
 if(schema.type==='number'||schema.type==='integer')return schema.minimum??1;
 if(schema.type==='boolean')return true;return '测试正文：产品广告';
}
function runtimeFixture(){
 const state={id:'foundations-'+Math.random().toString(16).slice(2),messages:[],events:[],assets:[]},calls=[];let next,controlDecision='resume',mediaCalls=0,finalDraft;
 const brain={respond:async(input,_tools,_signal,options)=>{
  const p=JSON.parse(typeof input[1].content==='string'?input[1].content:'{}');calls.push({phase:options?.tracePhase,input:structuredClone(input)});
  if(options.tracePhase==='understand')return reply(typeof next==='function'?next(p):next);
  if(options.tracePhase==='verify_turn_operation')return reply({operation:controlDecision,evidence:p.query});
  if(options.tracePhase==='verify_facts'){const actual=JSON.parse(input[1].content.find(x=>x.type==='input_text').text);assert.ok(actual.boundary.hash);assert.equal(typeof actual.content,'string');return reply({outcome:'passed',issues:[]});} // Explicit offline verdict; this fixture tests lineage, not semantic quality.
  if(options.tracePhase==='final_response')return reply(finalDraft||{artifactIds:p.artifacts.filter(a=>a.delivered).map(a=>a.id)});
  if(options.tracePhase==='media_plan')return reply({concept:'产品图方案',preservedConstraints:[],safety:{passed:true,reason:'普通产品'},items:[{prompt:'产品图',size:'2048x2048'}]});
  assert.equal(options.tracePhase,'text_generation');
  const marker='Schema：',schema=JSON.parse(input[0].content.slice(input[0].content.lastIndexOf(marker)+marker.length));return reply(sample(schema));
 }};
 const media={config:{imageModel:'offline-fixture'},image:async()=>{mediaCalls++;throw Error('this fixture must not submit media');}};
 const runtime=new ToolRuntime({catalog,brain,media}),agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,actionMode:'core',verifier:new Verifier(brain,{policy:'delivery_only'})});
 return {state,calls,agent,mediaCalls:()=>mediaCalls,final:x=>finalDraft=x,decision:x=>controlDecision=x,
  run:async(plan,query='本轮需求',control={})=>{next=plan;await agent.run(state,query,()=>{},sig(),control);},
  export:async name=>{if(process.env.FOUNDATIONS_TRACE_DIR)await writeFile(join(process.env.FOUNDATIONS_TRACE_DIR,name+'.trace.json'),JSON.stringify({evidenceType:'local_model_fixture',paidCalls:0,state:redactDebug(state)},null,2));}};
}
test('P0 semantic correction can replace an unaccepted EDIT_IMAGE with a text revision',async()=>{
 const source={id:'text-source',type:'text',content:'产品图提示词',version:1};
 const bad=native('EDIT_IMAGE',{target:{type:'TEXT',id:source.id,version:1},modification:{change:['优化'],preserve:[]}});
 const fixed=contract(text('优化提示词',{action:'modify',form:'prompt',references:[source.id],requiredMethods:['creative-prompt-rewrite']}));
 const {goal,calls,inputs}=await understand([bad,fixed],{assets:[source]});
 assert.equal(calls,2);assert.equal(goal.tasks[0].operation,'rewrite');assert.equal(goal.intentSnapshot.deliverables[0].type,'text');
 assert.equal(goal.intentSnapshot.origin,'first_parsed_intent');assert.equal(inputs[1][0].content.includes('尚未接受'),true);
});
test('P0 invalid source selection recovers using a real typed candidate, never a filename alias',async()=>{
 const image={id:'real-image',type:'image',version:2,url:'https://example.com/product.png'};
 const first=native('EDIT_IMAGE',{target:{type:'IMAGE',id:'product.png',version:2},modification:{change:['背景'],preserve:['主体']}});
 const {goal,calls}=await understand([first,p=>native('EDIT_IMAGE',{target:{type:'CANDIDATE',handle:p.relevantEvidence.references[0].handle},modification:{change:['背景'],preserve:['主体']}})],{assets:[image]});
 assert.equal(calls,2);assert.deepEqual(goal.tasks[0].references,[image.id]);assert.equal(goal.tasks[0].referenceBindings[0].version,2);
});
test('P0 unchanged unsupported semantics stop after feedback and execute nothing',async()=>{
 let calls=0;await assert.rejects(understandGoal({respond:async()=>{calls++;return reply(native('EDIT_IMAGE',{target:{type:'TEXT',id:'t',version:1},modification:{change:['x'],preserve:[]}}));}},catalog,{query:'本轮需求',actionMode:'core',assets:[{id:'t',type:'text',content:'文字',version:1}]},sig()),/类型/);assert.equal(calls,2);
});
test('P0 a structurally invalid version can be field-repaired without locking the bad value',async()=>{
 const source={id:'real-image',type:'image',version:2,url:'https://example.com/image.png'};
 const bad=native('EDIT_IMAGE',{target:{type:'IMAGE',id:source.id,version:0},modification:{change:['背景'],preserve:['主体']}});
 const {goal,calls}=await understand([bad,p=>Object.fromEntries(p.paths.map(path=>[p.fieldKeys[path],2]))],{assets:[source]});
 assert.equal(calls,2);assert.equal(goal.tasks[0].referenceBindings[0].version,2);assert.equal(goal.tasks[0].count,1);
});
test('P0 typed inline inputs keep content, filename, version, hash and source message; same ingestion is idempotent',()=>{
 const state={id:'s',taskStore:{inputs:{}}},message={messageId:'m',content:'请优化\n```prompt.txt\n白色咖啡杯\n```',role:'user'};
 const ids=registerRequestInputs(state,message,[{filename:'facts.json',mimeType:'application/json',content:'{"name":"杯子"}'}]);
 assert.equal(ids.length,2);assert.deepEqual(registerRequestInputs(state,message,[{filename:'facts.json',mimeType:'application/json',content:'{"name":"杯子"}'}]),ids);
 const source=state.taskStore.inputs[ids[0]];assert.equal(source.content,'白色咖啡杯\n');assert.equal(source.filename,'prompt.txt');assert.equal(source.version,1);assert.equal(source.sourceMessageId,'m');assert.equal(source.contentHash.length,64);
 const catalog=new ReferenceCatalog(Object.values(state.taskStore.inputs),{scope:'s'});assert.equal(catalog.resolveReference(ids[0]).usable,true);assert.throws(()=>catalog.resolveReference('prompt.txt'),/不存在/);
 assert.throws(()=>validateTextInputs([{filename:'x.txt',content:3}]),/正文/);
});
test('P0 exact evidence spans preserve multiple excerpts and reject hallucinated offsets or ellipses',()=>{
 const m={messageId:'m',role:'user',content:'先写脚本，稍后改背景'},s=contract(text('脚本',{requestEvidenceSpans:[{messageId:'m',start:0,end:4},{messageId:'m',start:7,end:10}]}));
 bindRequestEvidence(s,{query:m.content,currentMessage:m});assert.deepEqual(s.deliverables[0].evidenceSegments.map(x=>x.text),['先写脚本','改背景']);
 assert.throws(()=>bindRequestEvidence(contract(text('脚本',{requestEvidence:'先写…改背景'})),{query:m.content,currentMessage:m}),/证据不匹配/);
 assert.throws(()=>bindRequestEvidence(contract(text('脚本',{requestEvidenceSpans:[{messageId:'m',start:1,end:100}]})),{query:m.content,currentMessage:m}),/位置不存在/);
});
test('SKILL_001: inline prompt executes the actual registered Skill and saves a reusable text artifact',async()=>{
 const f=runtimeFixture();await f.run(p=>contract(text('优化提示词',{action:'modify',form:'prompt',references:[p.relevantEvidence.references.find(r=>r.filename==='prompt1.txt').handle],requiredMethods:['creative-prompt-rewrite']})),'优化这个图片提示词，让它更适合电商广告。',{inputs:[{filename:'prompt1.txt',content:'白色杯子，产品摄影'}]});
 const task=currentTask(f.state),artifact=taskArtifacts(f.state).find(a=>a.purpose==='deliverable');assert.equal(task.status,'COMPLETED');assert.ok(artifact);assert.equal(artifact.version,2);assert.ok(f.state.taskStore.inputs[artifact.parentArtifact]);assert.ok(task.items[0].methods.some(m=>m.skillId==='creative-prompt-rewrite'&&m.contractValidated));
 assert.equal(new ReferenceCatalog([artifact]).resolveReference(artifact.id).usable,true);await f.export('SKILL_001');
});
test('USER_STYLE_01: one direction remains one; speaker identity never sets audience automatically',async()=>{
 const f=runtimeFixture(),plan=contract(text('一个产品广告方向',{form:'directions',count:1}));plan.speakerRole='电商运营';
 await f.run(plan,'我是电商运营，帮我做一个产品广告方向。');const task=currentTask(f.state);
 assert.equal(task.status,'COMPLETED');assert.equal(task.items[0].spec.directionCount,1);assert.equal(task.goal.semantic.targetAudience,undefined);
 const artifact=taskArtifacts(f.state).find(a=>a.purpose==='deliverable');assert.equal(artifact.metadata.structure.directions.length,1);assert.equal(task.items[0].specOrigins.directionCount.origin,'accepted_request');await f.export('USER_STYLE_01');
});
test('USER_STYLE_03: textual proposal completes without inventing future media or a submission',async()=>{
 const f=runtimeFixture(),plan=contract(text('广告图文字方案',{form:'directions'}));plan.approval={required:true,reason:'先给方案不要生成'};plan.executionAuthorization={image:false,video:false};
 await f.run(plan,'老板让我今天出一个广告图方案，先给方案不要生成。');const task=currentTask(f.state);
 assert.equal(task.status,'COMPLETED');assert.equal(task.items.length,1);assert.equal(task.approval.required,false);assert.equal(task.contract.executionPermission.mediaSubmission,'denied');assert.equal(f.mediaCalls(),0);assert.equal(task.goal.requestContract.media.image,0);await f.export('USER_STYLE_03');
});
test('USER_STYLE_06: unresolved revision asks for the missing target and change without selecting image or approval',async()=>{
 const f=runtimeFixture(),plan=contract();plan.gaps=[{scope:'global',description:'请指出上一版对象和要修改的内容',level:'blocking',kind:'user_input',resolution:'明确目标与修改增量'}];
 await f.run(plan,'我只想修改上一版，不要重新开始。');assert.equal(currentTask(f.state).status,'NEEDS_INPUT');assert.equal(f.mediaCalls(),0);assert.equal(f.calls.filter(c=>c.phase==='text_generation').length,0);assert.match(f.state.events.at(-1).text,/指出上一版/);await f.export('USER_STYLE_06');
});
test('USER_STYLE_07: local missing selection only gates the script and directions remain saved and referencable',async()=>{
 const f=runtimeFixture(),plan=contract(text('三个方向',{form:'directions',count:3}),text('选择后写脚本',{form:'script',dependsOn:[0],references:['task:0']}));
 plan.gaps=[{description:'等待用户选择方向',level:'blocking',resolution:'选择一个已保存方向',affectedDeliverables:[1]}];
 await f.run(plan,'先给三个方向，选完再写脚本');const task=currentTask(f.state);
 assert.equal(task.status,'NEEDS_INPUT');assert.equal(task.items[0].status,'COMPLETED');assert.equal(task.items[1].status,'NEEDS_INPUT');assert.equal(task.requirements[0].status,'fulfilled');assert.equal(task.requirements[1].status,'pending');
 assert.equal(f.calls.filter(c=>c.phase==='text_generation').length,1);const artifact=taskArtifacts(f.state).find(a=>a.purpose==='deliverable');assert.equal(sourceUnits(artifact).length,3);assert.throws(()=>checkPreconditions(f.state,task.items[1],'commit_text_deliverable',{content:'未授权脚本'}),/尚未满足/);await f.export('USER_STYLE_07');
});
test('P1 selecting a saved direction binds artifact version plus unit ID; stale versions never silently reselect',()=>{
 const source={id:'directions',type:'text',version:3,content:'三个方向',metadata:{structure:{directions:[{content:'一'},{content:'二'},{content:'三'}]}}},catalog=new ReferenceCatalog([source]),unit=sourceUnits(source)[1];
 const d=text('脚本',{references:[source.id],selector:{type:'unit',artifactId:source.id,version:3,unitId:unit.id}});bindSourceSelection(d,catalog);assert.equal(d.selectorBinding.unitId,unit.id);assert.equal(d.selectorBinding.index,2);
 assert.throws(()=>bindSourceSelection(text('脚本',{references:[source.id],selector:{type:'unit',artifactId:source.id,version:2,unitId:unit.id}}),catalog),/版本/);
});
test('MT_TASK_001: choosing direction after the first stage consumes its saved version without regenerating directions',async()=>{
 const f=runtimeFixture(),plan=contract(text('三个方向',{form:'directions',count:3}),text('后续脚本',{form:'script',dependsOn:[0],references:['task:0'],activation:{timing:'after_user_input',condition:'等待选择'}}));
 await f.run(plan,'先给三个方向，选完写脚本');const old=currentTask(f.state),source=taskArtifacts(f.state).find(a=>a.purpose==='deliverable'),unit=sourceUnits(source)[1];
 const next=contract(text('选第二个方向写脚本',{form:'script',references:[source.id],selector:{type:'unit',artifactId:source.id,version:source.version,unitId:unit.id},requiredMethods:['video-script-zh-v1']}));next.turnOperation={kind:'modify',targetTaskId:old.id};
 await f.run(next,'选第二个方向写脚本');const task=currentTask(f.state);assert.equal(task.status,'COMPLETED');assert.equal(task.parentTaskId,old.id);assert.equal(task.items[0].selectorBinding.unitId,unit.id);assert.equal(f.calls.filter(c=>c.phase==='text_generation').length,2);
 assert.equal(Object.values(f.state.taskStore.artifacts).filter(a=>a.purpose==='deliverable'&&a.metadata?.structure?.directions).length,1);
 const script=taskArtifacts(f.state).find(a=>a.purpose==='deliverable');
 await f.run(contract(text('脚本改15秒',{action:'modify',form:'script',references:[script.id],spec:{durationSeconds:15},requiredMethods:['video-script-zh-v1']})),'把脚本改成15秒');
 const revision=taskArtifacts(f.state).find(a=>a.purpose==='deliverable');assert.equal(revision.parentId,script.id);assert.equal(revision.version,script.version+1);assert.equal(currentTask(f.state).items[0].spec.durationSeconds,15);
 await f.export('MT_TASK_001');
});
test('MT_SWITCH_001: a waiting media task resumes with its exact saved plan and original evidence, without submission or repeat',async()=>{
 const f=runtimeFixture();await f.run(native('CREATE_IMAGE',{confirmation:true,confirmationEvidence:'先确认'}),'生成产品图，先确认');const imageTask=currentTask(f.state),planHash=imageTask.approval.planHash,spans=structuredClone(imageTask.goal.semantic.deliverables[0].requestEvidenceSpans);
 await f.run(contract(text('广告文案')),'先写一句广告文案');const textTask=currentTask(f.state);
 const resume={...contract(),turnOperation:{kind:'resume',targetTaskId:imageTask.id}};
 await f.run(resume,'继续刚才图片任务',{requestId:'stable-resume'});assert.equal(currentTask(f.state).id,imageTask.id);assert.notEqual(textTask.id,imageTask.id);assert.equal(imageTask.approval.planHash,planHash);assert.equal(imageTask.approval.status,'pending');assert.deepEqual(imageTask.goal.semantic.deliverables[0].requestEvidenceSpans,spans);assert.equal(imageTask.continuationEvidence.at(-1).text,'继续刚才图片任务');
 const count=f.calls.length;await f.run(resume,'继续刚才图片任务',{requestId:'stable-resume'});assert.equal(f.calls.length,count);assert.equal(f.mediaCalls(),0);await f.export('MT_SWITCH_001');
});
test('P1 final composition cannot hide rejected intake with newly invented creative content',async()=>{
 const f=runtimeFixture();f.final('以下是我补写的三个广告方向：A、B、C');await f.run(native('EDIT_IMAGE',{target:{type:'IMAGE',id:'invented',version:1},modification:{change:['背景'],preserve:[]}}),'修改上一张');
 assert.equal(f.state.events.at(-1).status,'failed');assert.doesNotMatch(f.state.events.at(-1).text,/A、B、C|用户图片失效/);assert.equal(Object.keys(f.state.taskStore.artifacts).length,0);await f.export('final-boundary');
});
test('P1 final rendering refuses unsaved event artifacts even if the model repeats their IDs',async()=>{
 const turn={rawInput:'写方案',taskId:'t',decision:{status:'accepted'}},state={taskStore:{tasks:{},artifacts:{},executions:{}}};
 const answer=await composeFinalResponse({respond:async()=>reply({artifactIds:['invented']})},state,turn,{taskId:'t',status:'completed',artifacts:[{id:'invented',type:'text',content:'未保存方案'}]},sig());
 assert.doesNotMatch(answer,/未保存方案/);assert.equal(turn.responseReceipt.status,'composed');
});
