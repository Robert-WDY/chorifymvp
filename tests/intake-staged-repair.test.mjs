import test from 'node:test';
import assert from 'node:assert/strict';
import {understandGoal,intakeExamples,semanticSchema} from '../server/intent.mjs';
import {operationInputSchema} from '../server/turn-operation.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import Ajv from 'ajv';
import {createTask} from '../server/task-state.mjs';
import {acceptRevision} from '../server/task-contract.mjs';
import {compileGoal,prepareMediaPlan} from '../server/goal-compiler.mjs';
import {executeTextStage,renderStage} from '../server/text-stage.mjs';
import {assertIntakePointers} from '../server/intake-context.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const safety={disposition:'allow',untrustedInstructions:false,reason:''};
const reply=value=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}];
const candidate=(query,extra={})=>({summary:query,turnOperation:{kind:'create'},deliverables:[{description:query,kind:'text',action:'create',form:'copy',requestEvidence:query}],approval:{required:false,reason:''},safety,...extra});
async function capture(query,responses,options={}){
 const calls=[];let goal,error;
 try{goal=await understandGoal({respond:async(input,_tools,_signal,opts)=>{calls.push({input:structuredClone(input),options:opts});const value=typeof responses==='function'?responses(input,calls.length):responses[calls.length-1];if(value===undefined)throw Object.assign(Error('capture stop'),{repairTarget:'transport'});return reply(value);}},catalog,{query,actionMode:'core',strictControl:true,auditContracts:true,...options},signal());}catch(e){error=e;}
 return {calls,goal,error};
}
const payload=(result,n=0)=>JSON.parse(result.calls[n].input.findLast(m=>m.role==='user').content);

test('stage 1: actual core model request exposes one complete operation schema and no protocol election',async()=>{
 const query='写三个视频文字方向，不生成媒体',draft=candidate(query);Object.assign(draft.deliverables[0],{form:'directions',count:3,artifactCount:1});
 const result=await capture(query,[draft]);assert.ok(result.goal,result.error?.message);assert.equal(result.calls.length,1);
 const system=result.calls[0].input[0].content,schema=JSON.parse(system.split('当前wire Schema：')[1]);
 assert.equal(schema.oneOf,undefined);assert.ok(schema.properties.turnOperation);assert.equal(schema.properties.businessActions,undefined);
 assert.ok(!system.includes('CREATE_IMAGE'));assert.ok(!system.includes('选择当前合同'));assert.equal(result.goal.requestContract.media.image,0);
 assert.equal(result.goal.tasks[0].artifactCount,1);assert.equal(result.goal.tasks[0].contentCardinality,3);
});
test('stage 1: all contrast examples satisfy the same existing operation wire schema',()=>{
 const validate=new Ajv({strict:false,allErrors:true}).compile(operationInputSchema(semanticSchema));
 for(const mode of ['core','shadow','image_edit'])for(const example of intakeExamples({nativeMode:mode!=='shadow',actionMode:mode}))assert.ok(validate(example),JSON.stringify(validate.errors));
 const examples=intakeExamples();assert.ok(examples.some(e=>e.deliverables.some(d=>d.kind==='image')));assert.ok(examples.some(e=>e.turnOperation.kind==='present'));assert.ok(examples.some(e=>e.turnOperation.kind==='revise_plan'));
});

async function pendingVideo(){
 const query='准备一条5秒16:9视频方案，等我确认';
 const r=await capture(query,[candidate(query,{deliverables:[{description:query,kind:'video',action:'create',count:1,spec:{durationSeconds:5,ratio:'16:9'}}],approval:{required:true,reason:'等我确认'}})]);
 assert.ok(r.goal,r.error?.message);const state={id:'delta',messages:[],events:[]},task=createTask(state,r.goal,query);acceptRevision(task,'initial');
 task.status='WAIT_CONFIRM';task.executionPlan=compileGoal(task);task.executionPlan.nodes[0].skillArtifactId='saved-plan';
 task.approval={required:true,status:'pending',planHash:'saved-hash',payload:{itemId:task.items[0].id,items:[{prompt:'源方案完整正文，无字无人',duration:5,ratio:'16:9'}]}};
 task.artifacts=[{id:'saved-plan',type:'prompt',version:3,content:'源方案完整正文，无字无人',purpose:'support',taskId:task.id}];return task;
}
test('stage 2: ratio-only request binds persisted version and from value without model copying old fields',async()=>{
 const old=await pendingVideo(),before=JSON.stringify(old),query='只把旧方案画幅改为9:16，仍不生成';
 const r=await capture(query,[candidate(query,{turnOperation:{kind:'revise_plan',targetTaskId:old.id},deliverables:[],revisionDelta:{changes:[{field:'ratio',to:'9:16'}]}})],{taskSnapshot:old,taskCandidates:[old]});
 assert.ok(r.goal,r.error?.message);assert.equal(r.calls.length,1);assert.equal(JSON.stringify(old),before);
 assert.equal(r.goal.revisionDelta.targetVersion,3);assert.equal(r.goal.revisionDelta.changes[0].from,'16:9');
 assert.equal(r.goal.tasks[0].spec.durationSeconds,5);assert.equal(r.goal.tasks[0].spec.ratio,'9:16');assert.equal(r.goal.semantic.approval.required,true);
 assert.equal(r.goal.planRevision.parameters[0].prompt,'源方案完整正文，无字无人');
 const stale=await capture(query,[candidate(query,{turnOperation:{kind:'revise_plan',targetTaskId:old.id},deliverables:[],revisionDelta:{targetVersion:2,changes:[{field:'ratio',to:'9:16'}]}})],{taskSnapshot:old,taskCandidates:[old]});
 assert.equal(stale.goal,undefined);assert.match(stale.error.message,/绑定|版本/);
});
test('stage 2: one bound direction reaches actual script model input without other directions',async()=>{
 const structure={directions:[{id:'d1',content:'不应重新选择的第一方向'},{id:'d2',content:'指定第二方向：无字静物'}],sections:[{content:'容量未知'}]};
 const source={id:'directions',type:'text',version:2,content:renderStage(structure),metadata:{structure}},query='用第二个方向写脚本';
 const draft=candidate(query);Object.assign(draft.deliverables[0],{form:'script',references:[source.id],sourceSelection:{source:source.id,unitType:'directions',mode:'selected',unitIds:['d2'],layout:'unspecified'}});
 const r=await capture(query,[draft],{assets:[source]});assert.ok(r.goal,r.error?.message);
 const state={id:'binding',messages:[],events:[],assets:[source]},task=createTask(state,r.goal,query);acceptRevision(task,'binding');let input;
 await assert.rejects(executeTextStage({state,catalog,save:async()=>{},brain:{respond:async request=>{input=JSON.parse(request[1].content);throw Object.assign(Error('captured'),{repairTarget:'transport'});}}},task.items[0],signal()),/captured/);
 assert.equal(input.sources[0].selectedDirection.index,2);assert.equal(input.sources[0].selectedDirection.version,2);assert.ok(!JSON.stringify(input).includes('不应重新选择'));assert.ok(JSON.stringify(input).includes('容量未知'));
});
test('stage 2: image edit keeps image target and separately consumes an actual selected text direction',async()=>{
 const structure={directions:[{id:'d1',content:'不能进入第二方向输入的红色'},{id:'d2',content:'选定蓝色背景'}]},source={id:'directions',type:'text',version:2,content:renderStage(structure),metadata:{structure}};
 const image={id:'image',type:'image',version:3,url:'https://test.invalid/image.png'},query='按第二方向改这张图，主体不变，先方案';
 const draft=candidate(query,{turnOperation:{kind:'modify'},deliverables:[{description:query,kind:'image',action:'modify',count:1,references:[image.id],supportingSources:[source.id],sourceSelection:{source:source.id,unitType:'directions',mode:'selected',unitIds:['d2'],layout:'unspecified'},spec:{ratio:'1:1'},changeContract:{change:['按第二方向改背景'],preserve:['主体不变']}}],approval:{required:true,reason:'先方案'}});
 const r=await capture(query,[draft],{assets:[image,source]});assert.ok(r.goal,r.error?.message);assert.equal(r.goal.tasks[0].referenceBindings[0].id,image.id);assert.equal(r.goal.tasks[0].selectorBinding.sourceId,source.id);
 const state={id:'edit-binding',messages:[],events:[],assets:[image,source]},task=createTask(state,r.goal,query);state.taskStore.inputs={image, directions:source};acceptRevision(task,'edit-binding');const graph=compileGoal(task);let input;
 await assert.rejects(prepareMediaPlan({state,catalog,brain:{respond:async request=>{input=JSON.parse(request[1].content);throw Object.assign(Error('captured'),{repairTarget:'transport'});}}},task.items[0],graph.nodes[0],signal()),/captured/);
 assert.equal(input.supportingSources[0].selectedDirection.index,2);assert.deepEqual(input.goal.references,[image.url]);assert.ok(!JSON.stringify(input).includes('不能进入第二方向输入'));assert.equal(input.executionPhase,'prepare_only');
});

test('stage 3: field repair includes dereferenceable source bodies and keeps repair permission narrow',async()=>{
 const query='按照资料写文案',content='容量未知，不能宣称精准控量',draft=candidate(query);draft.deliverables[0].supportingSources=['creative-cover-copy-v2'];
 const r=await capture(query,[draft],{assets:[{id:'brief',type:'text',version:2,content}]});const second=payload(r,1);
 assertIntakePointers(second);assert.ok(JSON.stringify(second).includes(content));assert.ok(second.referenceCatalog.entries[0].contentSource);
 assert.deepEqual(second.paths,['/deliverables/0/supportingSources','/deliverables/0/requiredMethods']);assert.equal(second.sourceDocuments[0].version,2);
});
test('stage 3: reference repair reads candidate tails instead of indistinguishable excerpts',async()=>{
 const query='选择尾注明确要求白瓶无字的资料',prefix='共同背景。'.repeat(80),draft=candidate(query);draft.deliverables[0].references=['missing'];
 const r=await capture(query,[draft],{assets:[{id:'a',type:'text',version:1,content:prefix+'尾注：白瓶无字'},{id:'b',type:'text',version:1,content:prefix+'尾注：蓝瓶有字'}]});
 const second=payload(r,1);assert.equal(second.candidates[0].excerpt,second.candidates[1].excerpt);assert.ok(JSON.stringify(second).includes('尾注：蓝瓶有字'));assert.ok(JSON.stringify(second).includes('尾注：白瓶无字'));assertIntakePointers(second);
});
test('stage 3: explicit old filename and reply anchor survive recency windows and summary repair',async()=>{
 const content='背景。'.repeat(100)+'旧文档尾部硬约束：无人无字';
 const assets=Array.from({length:10},(_,i)=>({id:'doc-'+i,type:'text',version:1,filename:'资料'+i+'.txt',content:i===0?content:'其他内容'+i}));
 const messages=Array.from({length:16},(_,i)=>({messageId:'message-'+i,role:'user',content:i===0?'早期锚点：甲品牌容量未知':'无关历史'+i}));
 const query='按资料0.txt和引用消息继续',draft=candidate(query);delete draft.summary;
 const r=await capture(query,[draft],{assets,messages,replyTo:'message-0'});
 for(const n of [0,1]){const p=payload(r,n);assert.ok(JSON.stringify(p).includes('旧文档尾部硬约束'));assert.ok(JSON.stringify(p).includes('早期锚点'));assert.equal(p.replyTo,'message-0');assertIntakePointers(p);}
});
test('stage 3: old pending plan is a versioned candidate even when another task is active',async()=>{
 const old=await pendingVideo(),newer={...structuredClone(old),id:'unrelated-task',query:'无关新任务',executionPlan:{nodes:[]},approval:{required:false,status:'not_required'},artifacts:[]};
 const r=await capture('修改旧视频方案',[],{taskSnapshot:newer,taskCandidates:[old,newer]});const p=payload(r);
 const selected=p.relevantEvidence.relatedTasks.find(t=>t.id===old.id);assert.equal(selected.revisionTarget.targetVersion,3);assert.equal(selected.revisionTarget.parameters[0].ratio,'16:9');assert.equal(selected.revisionTarget.planHash,'saved-hash');assert.equal(p.activeTaskState.id,'unrelated-task');
});
test('stage 3: canonical document and indexed units share one full body in actual intake',async()=>{
 const marker='独有镜头正文：白瓶、无人、无字',structure={shots:[{content:marker}]};
 const r=await capture('按分镜写脚本',[],{assets:[{id:'s',type:'text',version:2,content:renderStage(structure),metadata:{structure}}]});const p=payload(r);
 const entry=p.relevantEvidence.references[0];assert.equal(entry.units[0].value,undefined);assert.ok(entry.units[0].valueSource);assert.equal(p.relevantEvidence.sourceDocuments[0].content,undefined);assertIntakePointers(p);
 // A short excerpt may intentionally repeat part of a body; it is an index,
 // not another complete document/collection.
 assert.equal(p.relevantEvidence.sourceDocuments[0].structure.shots[0].content,marker);
});

test('stage 4: readonly source errors receive a local repair before candidate acceptance',async()=>{
 const query='解释这份资料',draft=candidate(query,{turnOperation:{kind:'answer'},deliverables:[{description:query,kind:'text',action:'respond',references:['missing'],requestEvidence:query}]});
 const r=await capture(query,(input,n)=>n===1?draft:{'0':[JSON.parse(input[1].content).candidates[0].handle]},{assets:[{id:'actual-doc',type:'text',version:2,content:'完整真实资料'}]});
 assert.ok(r.goal,r.error?.message);assert.equal(r.calls.length,2);assert.equal(r.goal.intakeTrace[0].ok,false);assert.equal(r.goal.intakeTrace[0].failureStage,'reference');assert.equal(r.goal.intakeTrace[1].ok,true);assert.equal(r.goal.readOnlyTurn,true);
 assert.equal(r.goal.tasks[0].runtimeQuery.sourceBindings[0].id,'actual-doc');assert.equal(r.goal.tasks[0].runtimeQuery.sourceBindings[0].version,2);assert.equal(payload(r,1).field,'references');
});
test('stage 4: compilation prerequisite failure repairs the source before accepting a text change',async()=>{
 const query='把文档第一句改为你好',draft=candidate(query,{turnOperation:{kind:'modify'},deliverables:[{description:query,kind:'text',action:'modify',references:['image'],requestEvidence:query}]});
 const r=await capture(query,(input,n)=>n===1?draft:{field_0:['document']},{assets:[{id:'image',type:'image',version:1,url:'https://test.invalid/a.png'},{id:'document',type:'text',version:2,content:'第一句。其余正文。'}]});
 assert.ok(r.goal,r.error?.message);assert.equal(r.calls.length,2);assert.deepEqual(payload(r,1).paths,['/deliverables/0/references']);assert.equal(r.goal.tasks[0].changeContract.source.id,'document');assert.equal(r.goal.tasks[0].changeContract.source.version,2);
});
test('stage 4: patch feedback contains only latest rejected patch and still locks unrelated fields',async()=>{
 const query='写一条文案',draft=candidate(query);delete draft.summary;
 const r=await capture(query,(input,n)=>{if(n===1)return draft;if(n===2)return {summary:7};const p=JSON.parse(input[1].content);assert.deepEqual(p.rejectedPatch,{summary:7});assert.deepEqual(p.lockedDraft,draft);assert.match(p.error,/string/);assert.equal(input.length,2);return {summary:query};});
 assert.ok(r.goal,r.error?.message);assert.equal(r.calls.length,3);assert.equal(r.goal.tasks[0].count,1);
});
test('stage 4: identical unsupported source with identical next request stops without a third model call',async()=>{
 const query='参考资料写文案',draft=candidate(query);draft.deliverables[0].references=['revoked'];
 const r=await capture(query,()=>draft,{assets:[{id:'revoked',type:'text',version:1,content:'失效来源',revoked:true}]});
 assert.equal(r.goal,undefined);assert.equal(r.calls.length,2);assert.equal(r.error.repairStopReason,'no_progress');assert.match(r.error.message,/撤销|删除/);assert.equal(r.error.intakeTrace.length,2);
});
test('stage 4: ambiguous repeated quote is repaired to a unique continuous excerpt by the program binder',async()=>{
 const query='甲产品写标题；乙产品也写标题',draft=candidate(query);draft.deliverables[0].requestEvidence='写标题';
 const r=await capture(query,[draft,{field_0:'甲产品写标题'}]);assert.ok(r.goal,r.error?.message);assert.equal(r.calls.length,2);
 assert.deepEqual(payload(r,1).paths,['/deliverables/0/requestEvidence']);assert.equal(r.goal.semantic.deliverables[0].requestEvidenceSpans[0].start,0);assert.equal(r.goal.semantic.deliverables[0].requestEvidenceSpans[0].end,6);
});
test('cross-stage: selected direction is the actual primary media input as well as the coverage assignment',async()=>{
 const structure={directions:[{id:'d1',content:'绝不应成为本轮画面的第一方向'},{id:'d2',content:'选中的蓝色静物方向'}],sections:[{content:'容量未知'}]},source={id:'media-directions',type:'text',version:4,content:renderStage(structure),metadata:{structure}};
 const query='只用第二方向准备一张图片，先方案',draft=candidate(query,{deliverables:[{description:query,kind:'image',action:'create',count:1,references:[source.id],sourceSelection:{source:source.id,unitType:'directions',mode:'selected',unitIds:['d2'],layout:'separate_images'}}],approval:{required:true,reason:'先方案'}});
 const r=await capture(query,[draft],{assets:[source]});assert.ok(r.goal,r.error?.message);const state={id:'primary-media',messages:[],events:[]},task=createTask(state,r.goal,query);state.taskStore.inputs={source};acceptRevision(task,'cross-stage');const graph=compileGoal(task);let input;
 await assert.rejects(prepareMediaPlan({state,catalog,brain:{respond:async request=>{input=JSON.parse(request[1].content);throw Object.assign(Error('captured'),{repairTarget:'transport'});}}},task.items[0],graph.nodes[0],signal()),/captured/);
 assert.equal(input.sources[0].selectedDirection.index,2);assert.equal(input.sources[0].selectedDirection.version,4);assert.equal(input.assignments.length,1);assert.equal(input.assignments[0].units[0].index,2);assert.ok(!JSON.stringify(input).includes('绝不应成为'));assert.ok(JSON.stringify(input).includes('容量未知'));assert.equal(source.metadata.structure.directions.length,2);
});
