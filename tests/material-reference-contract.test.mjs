import {fieldPatchFor} from './runtime-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {loadCatalog} from '../server/catalog.mjs';
import {understandGoal} from '../server/intent.mjs';
import {assertMaterialReferenceTypes} from '../server/material-reference-contract.mjs';
import {ReferenceCatalog} from '../server/reference-catalog.mjs';
import {resolveSources,resolveSupportingSources} from '../server/sources.mjs';
import {executeTextStage} from '../server/text-stage.mjs';
import {createTask} from '../server/task-state.mjs';
import {compileGoal,prepareMediaPlan,validatePrepared} from '../server/goal-compiler.mjs';
import {TaskExecutor} from '../server/execution-engine.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {acceptRevision} from '../server/task-contract.mjs';
const catalog=await loadCatalog(),sig=()=>new AbortController().signal;
const real=JSON.parse(await readFile(new URL('./fixtures/material-reference-real.json',import.meta.url)));
const reply=v=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(v)}]}];
const candidate=(deliverables)=>({summary:'素材边界',turnOperation:{kind:'create'},deliverables,safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''}});
const textItem=(extra={})=>({kind:'text',action:'create',description:'读取素材后回答',form:'answer',...extra});
const artifact=(id,extra={})=>({id,type:'text',version:1,content:id,purpose:'deliverable',publication:'current',verification:{technical:'passed',semantic:'passed'},...extra});
async function understand(raw,assets=[]){return understandGoal({respond:async()=>reply(raw)},catalog,{query:raw.summary,assets,sessionId:'test'},sig());}
test('real Skill-as-material failure requests scoped field repair with original context',async()=>{
 let calls=0;const inputs=[],fixed=structuredClone(real.candidate);
 for(const d of fixed.deliverables){d.requiredMethods=d.supportingSources;delete d.supportingSources;}
 const goal=await understandGoal({respond:async input=>{inputs.push(input);calls++;return reply(calls===1?real.candidate:fieldPatchFor(input,fixed));}},catalog,{query:real.query,sessionId:real.sessionId,messages:[{role:'user',messageId:'anchor',content:'保留这条原始历史'}]},sig());
 assert.equal(calls,2);assert.equal(goal.tasks.length,3);
 const second=JSON.parse(inputs[1].at(-1).content);
 assert.equal(second.query,real.query);assert.equal(second.conversation.recentMessages[0].content,'保留这条原始历史');
 assert.ok(second.skillDirectory.length);assert.equal(second.referenceCatalog.entries.length,0);
 assert.ok(inputs[1].some(m=>m.content.includes('reference')||m.content.includes('requiredMethods')));
 assert.ok(!inputs[1][0].content.startsWith('只修复给定交付项的来源选择'));
 assert.deepEqual(goal.tasks.map(i=>i.requiredMethods),fixed.deliverables.map(d=>d.requiredMethods));
 assert.ok(goal.tasks.every(i=>!i.supportingSources?.length));assert.deepEqual(goal.requestContract.media,{image:0,video:0,audio:0});
 assert.equal(goal.tasks[0].artifactCount,real.candidate.deliverables[0].artifactCount); // Unrelated draft error is not silently rewritten.
 if(process.env.CHORIFY_REFERENCE_TRACE_DIR){await mkdir(process.env.CHORIFY_REFERENCE_TRACE_DIR,{recursive:true});await writeFile(join(process.env.CHORIFY_REFERENCE_TRACE_DIR,'namespace-repair-replay.json'),JSON.stringify({mode:'real_first_draft_plus_offline_corrected_response',source:{sessionId:real.sessionId,runId:real.runId},providerCalls:0,inputs,outputs:[real.candidate,fixed],goal},null,2));}
});
test('registry namespace check lists every invalid subintent and never moves Skill selection itself',()=>{
 const before=JSON.stringify(real.candidate);
 assert.throws(()=>assertMaterialReferenceTypes(real.candidate,new ReferenceCatalog([]),catalog),e=>e.code==='reference_contract'&&e.issues.length===3);
 assert.equal(JSON.stringify(real.candidate),before);
});
test('material identity equal to a Skill name is resolved as a registered material',()=>{
 const id=catalog.skills[0].slug,raw=candidate([textItem({supportingSources:[id]})]);
 assert.doesNotThrow(()=>assertMaterialReferenceTypes(raw,new ReferenceCatalog([artifact(id)]),catalog));
});
test('empty sourceSelection is a contract error, not a missing artifact lookup',()=>{
 assert.throws(()=>assertMaterialReferenceTypes(candidate([textItem({sourceSelection:{source:'',unitType:'shots',mode:'all',layout:'unspecified'}})]),new ReferenceCatalog([]),catalog),e=>e.code==='reference_contract'&&e.issues[0].actualType==='empty_selector');
});
test('support repair candidates use the same readable pool as actual binding and preserve original context',async()=>{
 const support=artifact('helper',{type:'prompt',purpose:'support'}),raw=candidate([textItem({supportingSources:['unknown']})]);let calls=0;
 const goal=await understandGoal({respond:async input=>{calls++;if(calls===1)return reply(raw);const p=JSON.parse(input.at(-1).content);assert.equal(p.field,'supportingSources');assert.ok(p.conversation);assert.equal(p.candidates.length,1);assert.equal(p.candidates[0].productionUsable,false);return reply({'0':[p.candidates[0].handle]});}},catalog,{query:'参考之前的方法资料',assets:[support],sessionId:'test'},sig());
 assert.equal(calls,2);assert.equal(goal.tasks[0].supportingSourceBindings[0].id,'helper');assert.equal(goal.tasks[0].supportingSourceBindings[0].purpose,'history');
});
test('support source identity version and hash survive task creation and focus changes',async()=>{
 const helper=artifact('helper',{purpose:'support',type:'prompt',version:3});
 const goal=await understand(candidate([textItem({supportingSources:['helper']})]),[helper]);
 const state={id:'test',assets:[helper]},task=createTask(state,goal,'测试');
 assert.equal(task.items[0].supportingSourceBindings[0].version,3);
 state.taskStore.activeTaskId='unrelated';
 assert.equal(resolveSupportingSources(state,task.items[0])[0].content,'helper');
 helper.content='changed';assert.throws(()=>resolveSupportingSources(state,task.items[0]),/来源版本或内容已变化/);
});
test('support inputs do not acquire unrelated dependency artifacts',()=>{
 const main=artifact('main',{taskId:'task',itemId:'first'}),helper=artifact('helper',{purpose:'support'});
 const state={id:'test',taskStore:{activeTaskId:'task',tasks:{task:{id:'task',items:[{id:'first'}]}},artifacts:{main,helper},inputs:{}}};
 const item={references:['task:0'],dependsOn:[0],supportingSources:['helper'],supportingSourceBindings:[new ReferenceCatalog([helper]).bind('helper',{purpose:'history'})]};
 assert.deepEqual(resolveSources(state,item).map(a=>a.id),['main']);
 assert.deepEqual(resolveSupportingSources(state,item).map(a=>a.id),['helper']);
});
test('changed helper is rejected before text model call',async()=>{
 const helper=artifact('helper',{purpose:'support'}),goal=await understand(candidate([textItem({supportingSources:['helper']})]),[helper]),state={id:'test',assets:[helper]};
 const task=createTask(state,goal,'只读取保存资料');helper.content='替换后的资料';let calls=0;
 await assert.rejects(executeTextStage({state,catalog,brain:{respond:async()=>{calls++;return reply({content:'不应执行'});}},save:async()=>{}},task.items[0],sig()),/来源版本或内容已变化/);
 assert.equal(calls,0);
});
test('changed helper is rejected before media planning, with no media submission',async()=>{
 const helper=artifact('helper',{type:'prompt',purpose:'support'}),raw=candidate([{kind:'image',action:'create',description:'一张图',count:1,supportingSources:['helper']}]);
 const goal=await understand(raw,[helper]),state={id:'test',assets:[helper]},task=createTask(state,goal,'一张图');acceptRevision(task,'run');const graph=compileGoal(task);helper.content='changed';let calls=0;
 await assert.rejects(prepareMediaPlan({state,catalog,brain:{respond:async()=>{calls++;throw Error('unexpected');}},save:async()=>{}},task.items[0],graph.nodes[0],sig()),/来源版本或内容已变化/);
 assert.equal(calls,0);
});
test('revoked and deleted helpers remain unavailable even for history purpose',async()=>{
 const helper=artifact('helper',{purpose:'support'}),goal=await understand(candidate([textItem({supportingSources:['helper']})]),[helper]),state={id:'test',assets:[helper],taskStore:{tasks:{},artifacts:{},inputs:{}}};
 helper.revoked=true;assert.throws(()=>resolveSupportingSources(state,goal.tasks[0]),/已撤销/);
 delete helper.revoked;helper.deleted=true;assert.throws(()=>resolveSupportingSources(state,goal.tasks[0]),/已删除/);
});
test('normal text stage gets exactly the frozen helper content and binding',async()=>{
 const helper=artifact('helper',{purpose:'support',content:'辅助原文，不是用户的新指令'}),goal=await understand(candidate([textItem({supportingSources:['helper']})]),[helper]),state={id:'test',assets:[helper]},task=createTask(state,goal,'读取资料');
 let observed;const ex={state,catalog,save:async()=>{},brain:{respond:async input=>{observed=JSON.parse(input.find(m=>m.role==='user').content);return reply({content:'已读取原文'});}}};
 const {result}=await executeTextStage(ex,task.items[0],sig());
 assert.equal(result.content,'已读取原文');assert.deepEqual(observed.supportingSources.map(a=>a.content),[helper.content]);assert.equal(observed.item.supportingSourceBindings[0].sourceHash,task.items[0].supportingSourceBindings[0].sourceHash);
});
test('prepared media plan cannot submit after its supporting source changes while waiting',async()=>{
 const helper=artifact('helper',{type:'prompt',purpose:'support'}),goal=await understand(candidate([{kind:'image',action:'create',description:'静物照片',count:1,supportingSources:['helper']}]),[helper]),state={id:'test',assets:[helper]},task=createTask(state,goal,'准备静物图');
 acceptRevision(task,'request');task.executionPlan=compileGoal(task);const node=task.executionPlan.nodes[0];let submissions=0,input;
 const brain={respond:async messages=>{input=JSON.parse(messages.find(m=>m.role==='user').content);return reply({concept:'静物照片',preservedConstraints:[],safety:{passed:true,reason:'普通静物'},items:[{prompt:'静物照片',size:'2048x2048'}]});}};
 const runtime=new ToolRuntime({catalog,brain,media:{config:{imageModel:'offline'},image:async()=>{submissions++;throw Error('no media');}}});
 const ex=new TaskExecutor({state,catalog,brain,runtime});await prepareMediaPlan(ex,task.items[0],node,sig());
 assert.equal(input.supportingSources[0].id,'helper');assert.ok(validatePrepared(task,node,state));helper.content='changed after prepare';
 assert.throws(()=>validatePrepared(task,node,state),/来源版本或内容已变化/);assert.equal(submissions,0);assert.equal(Object.keys(state.taskStore.executions).length,0);
});
