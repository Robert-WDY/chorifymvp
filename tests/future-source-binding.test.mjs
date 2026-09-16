import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import Ajv from 'ajv';
import {Agent} from './runtime-model-fixture.mjs';
import {understandGoal,semanticSchema} from '../server/intent.mjs';
import {operationInputSchema} from '../server/turn-operation.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
import {sourceUnits,bindCoverage,resolveDeferredSelection,resolveDeferredCoverage} from '../server/source-coverage.mjs';
import {ReferenceCatalog} from '../server/reference-catalog.mjs';
import {resolveSources} from '../server/sources.mjs';
import {selectStageSources,renderStage} from '../server/text-stage.mjs';
import {createTask} from '../server/task-state.mjs';
import {acceptRevision,assertContract} from '../server/task-contract.mjs';
import {compileGoal,prepareMediaPlan,validatePrepared} from '../server/goal-compiler.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/future-source-real-output.json',import.meta.url))),catalog=await loadCatalog();
const reply=v=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(v)}]}],signal=()=>AbortSignal.timeout(10000);
function draft(mode='selection'){
 const d=structuredClone(fixture.response);if(mode!=='captured'){delete d.deliverables[1].selector;
  if(mode==='index')d.deliverables[1].spec.selectedDirectionIndex=2;
  else if(mode==='selector')d.deliverables[1].selector={type:'direction',sourceArtifactId:'task:0',directionIndex:2};
  else d.deliverables[1].sourceSelection={source:'task:0',unitType:'directions',mode:'selected',unitIndexes:[2],layout:'unspecified'};
 }return d;
}
async function intake(value,options={}){let calls=0;const goal=await understandGoal({respond:async()=>{assert.equal(++calls,1,'must accept without a second understanding');return reply(value);}},catalog,{query:fixture.query,strictControl:true,auditContracts:true,actionMode:'core',...options},signal());return goal;}
const source=(id='source',version=3,dependencyIndex=0)=>({id,type:'text',version,dependencyIndex,structure:{directions:[{title:'一',content:'不应传给下游的红色快切方向'},{title:'二',content:'蓝色静物慢镜方向'}],sections:[{content:'容量未知；禁止增加字幕'}]}});
for(const mode of ['captured','selection','selector','index'])test('future selection: '+mode+' converges without fabricated identity or extra model call',async()=>{
 const d=draft(mode),validate=new Ajv({strict:false}).compile(operationInputSchema(semanticSchema));assert.ok(validate(d),JSON.stringify(validate.errors));const g=await intake(d),item=g.tasks[1];
 assert.deepEqual(item.sourceSelection,{source:'task:0',unitType:'directions',mode:'selected',unitIndexes:[2],layout:'unspecified'});assert.equal(item.selector,undefined);assert.equal(item.selectorBinding,undefined);
 const s=source(),binding=resolveDeferredSelection(item,[s]);assert.equal(binding.version,3);assert.equal(binding.sourceId,'source');assert.deepEqual(binding.unitIds,[sourceUnits(s)[1].id]);
});
test('future selection: ordinal intent validates dependency, producer type, bounds and conflicts',()=>{
 for(const mutate of [d=>d[1].dependsOn=[],d=>d[1].references=[],d=>d[0].kind='image',d=>d[1].sourceSelection.source='task:1',d=>d[1].sourceSelection.unitIndexes=[3],d=>d[1].sourceSelection.unitIndexes=[2,2],d=>d[1].sourceSelection.unitIds=['invented'],d=>d[1].spec.selectedDirectionIndex=1]){
  const peers=draft().deliverables;mutate(peers);assert.throws(()=>bindCoverage(peers[1],new ReferenceCatalog([]),fixture.query,peers));
 }
});
test('future selection: wrong ordinal receives a field repair path rather than a missing history error',()=>{
 const peers=draft().deliverables;peers[1].sourceSelection.unitIndexes=[9];assert.throws(()=>bindCoverage(peers[1],new ReferenceCatalog([]),fixture.query,peers),e=>e.issues?.[0]?.path==='/deliverables/1/sourceSelection'&&/数量/.test(e.message));
});
test('future selection: actual producing slot disambiguates multiple matching upstream documents',()=>{
 const item={sourceSelection:{source:'task:1',unitType:'directions',mode:'selected',unitIndexes:[2],layout:'unspecified'}},a=source('wrong',1,0),b=source('right',7,1);
 const binding=resolveDeferredSelection(item,[a,b]);assert.equal(binding.sourceId,'right');assert.equal(binding.version,7);assert.throws(()=>resolveDeferredSelection(item,[a]),/唯一绑定/);assert.throws(()=>resolveDeferredSelection(item,[b,{...b,id:'ambiguous'}]),/唯一绑定/);
});
test('future selection: runtime projection records the exact dependency index',()=>{
 const s=source(),state={id:'s',taskStore:{activeTaskId:'t',tasks:{t:{id:'t',items:[{id:'p'}]}},artifacts:{a:{id:'a',taskId:'t',itemId:'p',type:'text',version:3,purpose:'deliverable',metadata:{structure:s.structure},verification:{technical:'passed',semantic:'passed'}}}}};
 const resolved=resolveSources(state,{references:['task:0'],dependsOn:[0]});assert.equal(resolved[0].dependencyIndex,0);assert.equal(resolved[0].version,3);
});
test('future selection: missing, reordered, changed and forged bindings fail closed',()=>{
 const item={sourceSelection:draft().deliverables[1].sourceSelection},s=source();item.resolvedSelectorBinding=resolveDeferredSelection(item,[s]);
 for(const changed of [{...s,version:4},{...s,structure:{directions:[s.structure.directions[1],s.structure.directions[0]]}},{...s,structure:{directions:[s.structure.directions[0]]}}])assert.throws(()=>resolveDeferredSelection(item,[changed]),/变化|缺少/);
 item.resolvedSelectorBinding.index=1;assert.throws(()=>resolveDeferredSelection(item,[s]),/变化/);
});
test('future selection: directions, shots and products share ordinal binding and actual input filtering',()=>{
 for(const unitType of ['directions','shots','products']){const s={id:unitType,type:'text',version:2,dependencyIndex:0,structure:{[unitType]:[{content:'EXCLUDED_FIRST'},{content:'SELECTED_SECOND'}],sections:[{content:'PRESERVE_NEGATIVE'}]}};
  const item={spec:{},sourceSelection:{source:'task:0',unitType,mode:'selected',unitIndexes:[2],layout:'unspecified'}};item.resolvedSelectorBinding=resolveDeferredSelection(item,[s]);const projected=JSON.stringify(selectStageSources([s],item));assert.ok(projected.includes('SELECTED_SECOND'));assert.ok(projected.includes('PRESERVE_NEGATIVE'));assert.ok(!projected.includes('EXCLUDED_FIRST'));assert.equal(s.structure[unitType].length,2);
 }
});
test('future selection: existing source still requires real identity and correct version',()=>{
 const s=source(),c=new ReferenceCatalog([s]),id=sourceUnits(s)[1].id;
 const d={kind:'text',action:'create',references:[s.id],spec:{},selector:{type:'direction',sourceArtifactId:s.id,version:2,directionId:id,directionIndex:2}};assert.throws(()=>bindCoverage(d,c,'第二方向'),/版本/);
 assert.throws(()=>bindCoverage({...d,selector:undefined,sourceSelection:{source:s.id,unitType:'directions',mode:'selected',unitIndexes:[2],layout:'unspecified'}},c,'第二方向'),/已有来源/);
});
async function execute({mode='captured',noSkill=false,upstreamFails=false}={}){
 const candidate=draft(mode);if(noSkill)candidate.deliverables[1].requiredMethods=[];
 const state={id:'fresh-'+Math.random(),messages:[],events:[]},inputs=[];
 const brain={respond:async(input,_tools,_signal,opts)=>{
  const payload=JSON.parse(input.find(m=>m.role==='user').content);inputs.push({phase:opts?.tracePhase,payload});
  if(opts?.tracePhase==='understand')return reply(candidate);
  if(payload.methods?.some(m=>m.slug==='direction-designer-zh-v1'))return reply(upstreamFails?{structure:{directions:[]}}:{structure:{directions:source().structure.directions,recommendation:'推荐第二方向',sections:source().structure.sections}});
  assert.ok(payload.sources?.[0]?.selectedDirection);assert.equal(payload.sources[0].selectedDirection.index,2);assert.ok(!JSON.stringify(payload).includes('不应传给下游的红色快切方向'));assert.ok(JSON.stringify(payload).includes('容量未知'));
  // Selection integration needs an actual script; the former summary-only
  // outputs remain negative acceptance fixtures in contract-boundary-stage2.
  const shots=['蓝色静物全景','蓝色杯沿特写','蓝色桌面光影','蓝色静物收束'].map(content=>({content,durationSeconds:2}));
  return reply({structure:{...(!noSkill?{hook:'蓝色静物',body:'四镜各2秒',cta:'收尾'}:{}),shots}});
 }};
 const runtime=new ToolRuntime({catalog,brain,media:{config:{},image:async()=>{throw Error('No media');}}}),verifier=new Verifier(brain,{policy:'delivery_only'}),agent=new Agent({catalog,brain,runtime,verifier,actionMode:'core'});
 await agent.run(state,fixture.query,()=>{},signal());return {state,inputs};
}
for(const noSkill of [false,true])test('future selection: original query completes both artifacts with selected-only actual input, skill='+!noSkill,async()=>{
 const {state,inputs}=await execute({noSkill}),task=Object.values(state.taskStore.tasks)[0];assert.equal(task.status,'COMPLETED',task.reason);assertContract(task);
 const outputs=Object.values(state.taskStore.artifacts).filter(a=>a.purpose==='deliverable');assert.equal(outputs.length,2);assert.equal(outputs[0].metadata.structure.directions.length,2);assert.equal(outputs[1].metadata.sourceSelectionBinding.index,2);assert.equal(task.items[1].resolvedSelectorBinding.sourceId,outputs[0].id);assert.equal(task.goal.tasks[1].resolvedSelectorBinding,undefined);
 assert.equal(inputs.filter(i=>i.phase==='understand').length,1);assert.equal(inputs.filter(i=>i.phase==='text_generation').length,2);
});
test('future selection: failed upstream never runs downstream with an imagined direction',async()=>{
 const {state,inputs}=await execute({upstreamFails:true});assert.notEqual(Object.values(state.taskStore.tasks)[0].status,'COMPLETED');assert.equal(inputs.filter(i=>i.phase==='text_generation'&&!i.payload.methods?.some(m=>m.slug==='direction-designer-zh-v1')).length,0);
});
test('future selection: media selected units keep count and reapproval gates',async()=>{
 const d=draft();d.deliverables[1]={description:'只用第二方向准备一张图片，先方案',kind:'image',action:'create',count:1,references:['task:0'],dependsOn:[0],requestEvidence:fixture.query,sourceSelection:{source:'task:0',unitType:'directions',mode:'selected',unitIndexes:[2],layout:'separate_images'}};
 const g=await intake(d),state={id:'future-media',messages:[],events:[]},task=createTask(state,g,fixture.query),s=source('upstream',5);state.taskStore.artifacts[s.id]={...s,taskId:task.id,itemId:task.items[0].id,purpose:'deliverable',content:renderStage(s.structure),metadata:{structure:s.structure},verification:{technical:'passed',semantic:'passed'}};
 // Apply the same explicit-approval boundary as Agent.run before accepting.
 task.effectPolicy='explicit_approval';task.approval={required:true,status:'pending',source:'explicit_control'};acceptRevision(task,'test');task.items[0].status='COMPLETED';const node=compileGoal(task).nodes.find(n=>n.itemId===task.items[1].id);let input;
 await assert.rejects(prepareMediaPlan({state,catalog,save:async()=>{},brain:{respond:async req=>{input=JSON.parse(req[1].content);throw Object.assign(Error('captured'),{repairTarget:'transport'});}}},task.items[1],node,signal()),/captured/);
 assert.equal(input.assignments.length,1);assert.equal(input.assignments[0].units[0].index,2);assert.equal(input.sources[0].selectedDirection.index,2);assert.equal(input.executionPhase,'prepare_only');assert.equal(input.authorization.required,true);assert.ok(!JSON.stringify(input).includes('不应传给下游的红色快切方向'));assertContract(task);
 assert.throws(()=>resolveDeferredCoverage({...task.items[1],count:2},resolveSources(state,task.items[1])),/数量/);
});
test('future selection: prepared media pins the binding and cannot submit after receipt removal',async()=>{
 const query='先写两个茶饮创意方向保存，然后按第二方向准备一张9:16图片，先方案，等待我确认。',candidate=draft();candidate.summary=query;candidate.deliverables[0].requestEvidence=query;
 candidate.deliverables[1]={description:'按第二方向准备图片',kind:'image',action:'create',count:1,spec:{ratio:'9:16'},references:['task:0'],dependsOn:[0],requestEvidence:query,sourceSelection:{source:'task:0',unitType:'directions',mode:'selected',unitIndexes:[2],layout:'separate_images'}};
 let submissions=0;const state={id:'media-gate',messages:[],events:[]},brain={respond:async(input,_tools,_signal,opts)=>{
  if(opts.tracePhase==='understand')return reply(candidate);
  const p=JSON.parse(input.find(m=>m.role==='user').content);
  if(opts.tracePhase==='text_generation')return reply({structure:{directions:source().structure.directions,recommendation:'第二方向'}});
  if(opts.tracePhase==='media_plan')return reply({concept:'蓝色静物',preservedConstraints:['9:16'],safety:{passed:true,reason:'普通茶饮静物'},items:[{prompt:'蓝色静物',size:'1440x2560',sourceUnitIds:p.assignments[0].unitIds}]});
  throw Error('Unexpected model phase '+opts.tracePhase);
 }},runtime=new ToolRuntime({catalog,brain,media:{config:{imageModel:'fixture'},image:async()=>{submissions++;throw Error('NO_SUBMIT');}}}),agent=new Agent({catalog,brain,runtime,verifier:new Verifier(brain,{policy:'delivery_only'}),actionMode:'core'});
 await agent.run(state,query,()=>{},signal());const task=Object.values(state.taskStore.tasks)[0];assert.equal(task.status,'WAIT_CONFIRM',task.reason);assert.equal(submissions,0);
 const item=task.items[1],node=task.executionPlan.nodes.find(n=>n.itemId===item.id);assert.ok(validatePrepared(task,node,state));const binding=item.resolvedSelectorBinding;delete item.resolvedSelectorBinding;assert.throws(()=>validatePrepared(task,node,state),/绑定缺失/);item.resolvedSelectorBinding=binding;
 node.selectionBinding.index=1;assert.throws(()=>validatePrepared(task,node,state),/绑定缺失|变化/);assert.equal(submissions,0);
});
test('future selection: image target and a future supporting direction bind in separate namespaces',async()=>{
 const candidate=draft();candidate.deliverables[1]={description:'只改原图背景为第二方向，主体不变',kind:'image',action:'modify',count:1,references:['original-image'],supportingSources:['task:0'],dependsOn:[0],selector:{type:'artifact',artifactId:'original-image',version:4},changeContract:{change:['改背景'],preserve:['主体不变']},requestEvidence:fixture.query,sourceSelection:{source:'task:0',unitType:'directions',mode:'selected',unitIndexes:[2],layout:'unspecified'}};
 const goal=await intake(candidate,{assets:[{id:'original-image',type:'image',version:4,url:'https://test.invalid/image.png'}]}),item=goal.tasks[1];assert.deepEqual(item.references,['original-image']);assert.deepEqual(item.supportingSources,['task:0']);assert.equal(item.referenceBindings[0].version,4);assert.deepEqual(item.sourceSelection.unitIndexes,[2]);assert.equal(item.supportingSourceBindings.length,0);
});
test('future selection: invalid joined quotation repairs only evidence and preserves dependency selection',async()=>{
 const candidate=draft();candidate.deliverables[1].requestEvidence=fixture.response.deliverables[1].requestEvidence+'……你直接采用第二个方向，不用等我选择。';let calls=0,patchRequest;
 const goal=await understandGoal({respond:async input=>{if(++calls===1)return reply(candidate);assert.equal(calls,2);patchRequest=JSON.parse(input.find(m=>m.role==='user').content);assert.deepEqual(patchRequest.paths,['/deliverables/1/requestEvidence']);return reply({[patchRequest.fieldKeys[patchRequest.paths[0]]]:fixture.response.deliverables[1].requestEvidence});}},catalog,{query:fixture.query,actionMode:'core',strictControl:true,auditContracts:true},signal());
 assert.deepEqual(goal.tasks[1].dependsOn,[0]);assert.deepEqual(goal.tasks[1].sourceSelection.unitIndexes,[2]);assert.equal(goal.tasks.length,2);assert.ok(goal.semantic.deliverables[1].requestEvidenceSpans.length);
});
