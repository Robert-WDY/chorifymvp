import test from 'node:test';import assert from 'node:assert/strict';
import {understandGoal,semanticSchema} from '../server/intent.mjs';
import {operationInputSchema} from '../server/turn-operation.mjs';
import {bindRequestEvidence,evidenceCandidates} from '../server/request-input.mjs';
import {assertWorkflow} from '../server/planning-boundary.mjs';
import {applyStages} from '../server/stage-contract.mjs';
import {currentTask,taskArtifacts} from '../server/task-state.mjs';
import Ajv from 'ajv';
import {catalog,reply,signal,contract,textItem,archived,rawDraft,fixture} from './contract-boundary-fixture.mjs';
test('stage1 archived discontinuous quotation repairs only evidence and preserves selected dependency',async()=>{
 const draft=rawDraft('01-dep-casual'),query=archived('01-dep-casual','result').query;let calls=0;
 const g=await understandGoal({respond:async input=>{
  if(++calls===1)return reply(draft);
  const p=JSON.parse(input[1].content);assert.deepEqual(p.paths,['/deliverables/1/requestEvidence']);
  assert.ok(p.evidenceRepair.candidates.every(c=>query.slice(c.start,c.end)===c.text));
  assert.deepEqual(p.lockedDraft,draft);
  return reply({[p.fieldKeys[p.paths[0]]]:p.evidenceRepair.candidates.find(c=>c.text.startsWith('就用后一个')).text});
 }},catalog,{query,actionMode:'core',strictControl:true,auditContracts:true},signal());
 assert.equal(calls,2);assert.deepEqual(g.tasks[1].sourceSelection,draft.deliverables[1].sourceSelection);assert.deepEqual(g.tasks[1].dependsOn,[0]);
});
test('stage1 evidence candidates are exact Unicode spans; separate excerpts remain separate',()=>{
 const m={role:'user',messageId:'m',content:'第一条🌱。中间资料。最后一条！'};
 for(const c of evidenceCandidates(m))assert.equal(m.content.slice(c.start,c.end),c.text);
 const spans=[0,2].map(i=>{const {messageId,start,end}=evidenceCandidates(m)[i];return{messageId,start,end};});
 const d=contract([textItem({requestEvidenceSpans:spans})]);bindRequestEvidence(d,{query:m.content,currentMessage:m});assert.equal(d.deliverables[0].requestEvidence,'');assert.equal(d.deliverables[0].evidenceSegments.length,2);
 assert.throws(()=>bindRequestEvidence(contract([textItem({requestEvidence:'第一条🌱。最后一条！'})]),{query:m.content,currentMessage:m}),/不匹配/);
});
test('stage1 repeated unsupported evidence patch stops without changing the correct selection',async()=>{
 const draft=rawDraft('01-dep-casual'),query=archived('01-dep-casual','result').query;let calls=0;
 await assert.rejects(understandGoal({respond:async()=>reply(++calls===1?draft:{field_0:draft.deliverables[1].requestEvidence})},catalog,{query,actionMode:'core',strictControl:true},signal()),/证据|补丁|schema|Schema/);assert.ok(calls<=3);
});
test('stage1 archived missing original is valid but not executable and produces no artifact',async()=>{
 const f=fixture({draft:rawDraft('20-empty-formal')});await f.run(archived('20-empty-formal','result').query);
 assert.equal(currentTask(f.state).status,'NEEDS_INPUT');assert.equal(taskArtifacts(f.state).length,0);assert.ok(!f.calls.some(c=>c.phase==='text_generation'));assert.equal(f.submissions(),0);
});
test('stage1 deferred readiness does not hide invalid topology, methods or specifications',()=>{
 const good={id:'i',operation:'rewrite',requiredMethods:[],references:[],dependsOn:[],spec:{selectedDirectionIndex:2},activation:{timing:'after_user_input',condition:'等待用户提供原文'}};
 assert.doesNotThrow(()=>assertWorkflow(good,[good],catalog));
 for(const delta of [{dependsOn:[0]},{references:['task:0']},{requiredMethods:['invented']},{spec:{selectedDirectionIndex:2,directionCount:1}},{spec:{shotCount:4,secondsPerShot:2,durationSeconds:5}},{activation:{timing:'after_user_input',condition:''}}]){const bad={...good,...delta};assert.throws(()=>assertWorkflow(bad,[bad],catalog));}
 const missing={...good,activation:undefined};assert.throws(()=>assertWorkflow(missing,[missing],catalog),/前置生产/);
});
test('stage1 media obligations cannot silently become plain prompt review',()=>{
 for(const id of ['15-image-casual','16-image-formal'])assert.throws(()=>applyStages(rawDraft(id)),e=>e.code==='media_obligation');
 const review=contract([textItem({form:'prompt'})],{approval:{required:true,reason:'只审核文字',scope:'text_review'}});applyStages(review);assert.equal(review.approval.required,false);assert.equal(review.reviewIntent.required,true);
});
for(const kind of ['image','video'])test('stage1 '+kind+' executable plan is saved and waits for exact-plan approval with zero submissions',async()=>{
 const query='先保存执行方案，批准后生成',draft=contract([{description:'静物媒体',kind,action:'create',count:1,spec:kind==='image'?{ratio:'9:16'}:{ratio:'9:16',durationSeconds:5}}],{approval:{required:true,reason:query,scope:'media_submission'}});
 const validate=new Ajv({strict:false}).compile(operationInputSchema(semanticSchema));assert.ok(validate(draft),JSON.stringify(validate.errors));
 const f=fixture({draft});await f.run(query);const task=currentTask(f.state);assert.equal(task.status,'WAIT_CONFIRM');assert.ok(task.approval.planHash);assert.ok(task.approval.payload);assert.equal(task.items.length,1);assert.equal(f.submissions(),0);
});
test('stage1 prompt-only completes without introducing media obligations',async()=>{
 const f=fixture({draft:contract([textItem({form:'prompt'})])});await f.run('只写一段图片提示词');assert.equal(currentTask(f.state).status,'COMPLETED');assert.equal(f.submissions(),0);assert.equal(currentTask(f.state).items.length,1);
});
