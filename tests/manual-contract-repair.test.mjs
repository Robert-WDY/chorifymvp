import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ReferenceCatalog,referenceInventory,verifyReferenceBinding} from '../server/reference-catalog.mjs';
import {sourceUnits,bindCoverage,coverageStatus,coverageAssignments,assertCoverageSource} from '../server/source-coverage.mjs';
import {messageEvidence,resolveMessage,queryGoal,resolveSkillName} from '../server/conversation-query.mjs';
import {resolveSources} from '../server/sources.mjs';
import {understandGoal} from './intake-compat.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Agent} from './runtime-model-fixture.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
import {TaskExecutor} from '../server/execution-engine.mjs';
import {createTask,addArtifact,currentTask,taskArtifacts,reconcileTask,storeOf} from '../server/task-state.mjs';
import {normalizeMethodPlan} from '../server/planning-boundary.mjs';
import {renderStage} from '../server/text-stage.mjs';
import {withTool,withTrace} from '../server/trace-context.mjs';
import {SessionStore} from '../server/session-store.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {queryChecks} from '../server/runtime-facts.mjs';
import {validatePrepared} from '../server/goal-compiler.mjs';
import {requireApproval,approveTask} from '../server/task-state.mjs';
const catalog=await loadCatalog(),sig=()=>new AbortController().signal;
const reply=v=>[{role:'assistant',type:'message',content:[{type:'output_text',text:JSON.stringify(v)}]}];
const source={id:'script',taskId:'old',version:2,type:'text',purpose:'deliverable',content:'完整三镜头',metadata:{structure:{shots:[{content:'第一镜：花开'},{content:'第二镜：杯口蒸汽'},{content:'第三镜：侧脸喝咖啡'}]}},verification:{technical:'passed',semantic:'passed'}};
const inventory=()=>new ReferenceCatalog([structuredClone(source)],{scope:'s',epoch:'run-1'});
const selection=(c,layout='separate_images',mode='all',ids=[])=>({source:c.entries[0].handle,unitType:'shots',mode,unitIds:ids,layout,evidence:'只生成第二镜'});
const deliverable=()=>({description:'每个镜头生成一张图',kind:'image',count:1,action:'create',purpose:'storyboard',requiredEvidence:'none',references:['script'],dependsOn:[],constraints:[],requestEvidence:'每镜一张',form:'composite',executionShape:'workflow',artifactCount:1});
function semantic(d){return {summary:'分镜出图',deliverables:[d],gaps:[],assumptions:[],deferred:[],facts:[],globalConstraints:[],requiredMethods:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''},continuation:{mode:'new',taskId:''}};}
function goal(d){const s=semantic(d);return {summary:s.summary,mode:'create',semantic:s,tasks:[{operation:'generate_image',output:d.kind,count:d.count,artifactCount:d.artifactCount,contentCardinality:d.contentCardinality,dependsOn:[],references:d.references,constraints:[],spec:{},requiredEvidence:'none',requiredMethods:[],coverage:d.coverage}],skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:s.safety};}
const coveredArtifact=(assignment,ids=assignment.unitIds)=>({purpose:'deliverable',verification:{technical:'passed',semantic:'passed'},metadata:{coverage:assignment},acceptance:{quality:{coverage:{passed:true,unitIds:ids}}}});
test('one catalog resolves historical artifacts beyond active focus and excludes another session',()=>{
 const c=new ReferenceCatalog(referenceInventory({taskCandidates:[{artifacts:[source]}],taskSnapshot:{artifacts:[]},assets:[{assetId:'foreign',sessionId:'someone-else',kind:'image'}]}),{scope:'s'});
 assert.equal(c.entries.length,1);assert.equal(c.select(c.entries[0].handle).source.id,'script');assert.throws(()=>c.select('foreign'),/不存在/);
});
test('handles expire on next run and revoked assets cannot be selected',()=>{
 const c=inventory(),next=new ReferenceCatalog([source],{scope:'s',epoch:'run-2'});assert.throws(()=>next.select(c.entries[0].handle),/过期/);
 assert.throws(()=>new ReferenceCatalog([{...source,revoked:true}]).select('script'),/撤销/);
});
test('historical reads allow superseded versions, production sources do not',()=>{
 const c=new ReferenceCatalog([{...source,publication:'superseded'}]);assert.equal(c.select('script',{purpose:'history'}).source.id,'script');assert.throws(()=>c.select('script'),/已被替代/);
});
test('source binding detects changed version, reordered content and revoked permission',()=>{
 const c=inventory(),binding=c.bind('script');verifyReferenceBinding(source,binding);
 assert.throws(()=>verifyReferenceBinding({...source,version:3},binding),/已变化/);
 const changed=structuredClone(source);changed.metadata.structure.shots.reverse();assert.throws(()=>verifyReferenceBinding(changed,binding),/已变化/);
 assert.throws(()=>verifyReferenceBinding({...source,revoked:true},binding),/权限/);
});
test('captured real ID from turn 6 resolves when focus changed',async()=>{
 const data=JSON.parse(fs.readFileSync(new URL('./fixtures/manual-turn6.json',import.meta.url)));
 const call=data.modelCalls.find(c=>c.id==='65d99fcd-2930-4ec0-bad6-ac9c7ff6b739'),input=JSON.parse(call.input[1].content),value=structuredClone(call.validations[0].parsed);let n=0;
 const result=await understandGoal({respond:async()=>reply(++n===1?value:{routes:[{deliverableIndex:0,operation:'answer',skills:[]}]})},catalog,{query:'请复述早先那条回答',taskSnapshot:input.taskSnapshot,taskCandidates:Object.values(data.taskStore.tasks).map(t=>({...t,artifacts:Object.values(data.taskStore.artifacts).filter(a=>a.taskId===t.id)}))},sig());
 assert.equal(n,1);assert.equal(result.tasks[0].references[0],'3af49f1f-aadc-4d04-8161-f137cc7614f7');
});
test('bad UUID repair changes only reference selection and rejects whole-goal replacement',async()=>{
 const d={...deliverable(),kind:'text',action:'inspect',purpose:'general',requiredEvidence:'image',references:['image-typo']},v=semantic(d);let n=0,locked;
 const run=allow=>understandGoal({respond:async input=>{n++;if(n===1)return reply(v);if(n===2){const p=JSON.parse(input.at(-1).content);locked=p.lockedDraft;return reply(allow?{'0':[p.candidates[0].handle]}:{...v,approval:{required:true,reason:'changed'}});}return reply({routes:[{deliverableIndex:0,operation:'analyze_image',skills:[]}]});}},catalog,{query:'分析这张图片',assets:[{assetId:'image-real',kind:'image',url:'https://test.invalid/img.png'}]},sig());
 const result=await run(true);assert.equal(result.tasks[0].references[0],'image-real');assert.equal(result.semantic.approval.required,false);assert.equal(result.tasks[0].count,1);assert.equal(locked.deliverables[0].description,d.description);
 n=0;await assert.rejects(run(false),/引用修复只能/);
});
test('ambiguous storyboard layout blocks before scope guessing or media planning',async()=>{
 let n=0;const result=await understandGoal({respond:async()=>{n++;return reply(semantic({...deliverable(),sourceSelection:{source:'script',unitType:'shots',mode:'all',layout:'unspecified'}}));}},catalog,{query:'给我生成分镜图',taskCandidates:[{id:'old',artifacts:[source]}]},sig());
 assert.equal(n,1);assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].activation.timing,'after_user_input');
});
test('three separate images and one storyboard sheet both cover all three units',()=>{
 for(const layout of ['separate_images','storyboard_sheet']){const c=inventory(),d=deliverable();d.sourceSelection=selection(c,layout);bindCoverage(d,c,layout==='separate_images'?'每镜一张':'一张三格故事板');assert.equal(d.count,layout==='separate_images'?3:1);assert.equal(d.coverage.unitIds.length,3);const a=coverageAssignments(d,[source]);assert.equal(a.length,d.count);assert.equal(coverageStatus(d,a.map(x=>coveredArtifact(x))).complete,true);}
});
test('selecting only second shot is bound to an actual source unit and user evidence',()=>{
 const c=inventory(),d=deliverable(),id=sourceUnits(source)[1].id;d.sourceSelection=selection(c,'separate_images','selected',[id]);bindCoverage(d,c,'只生成第二镜');assert.deepEqual(d.coverage.unitIds,[id]);assert.equal(d.count,1);assert.throws(()=>bindCoverage(d,c,'全部镜头'),/原话依据/);
});
test('three copies of first shot never satisfy all-unit coverage; unsupported claims do not count',()=>{
 const c=inventory(),d=deliverable();d.sourceSelection=selection(c);bindCoverage(d,c,'每镜一张');const a=coverageAssignments(d,[source]);assert.equal(coverageStatus(d,Array.from({length:3},()=>coveredArtifact(a[0]))).complete,false);assert.equal(coverageStatus(d,[coveredArtifact(a[0],d.coverage.unitIds)]).covered.length,0);
});
test('reordered or deleted source units invalidate a prepared coverage plan',()=>{
 const c=inventory(),d=deliverable();d.sourceSelection=selection(c);bindCoverage(d,c,'每镜一张');const changed=structuredClone(source);changed.metadata.structure.shots.reverse();assert.throws(()=>assertCoverageSource(d,[changed]),/已变化/);changed.metadata.structure.shots.pop();assert.throws(()=>assertCoverageSource(d,[changed]),/已变化/);
});
test('multi-panel method is excluded from separate images; explicit incompatible method fails',()=>{
 const c=inventory(),d=deliverable();d.sourceSelection=selection(c);bindCoverage(d,c,'每镜一张');const route={operation:'generate_image',skills:['image-prompt-gallery-director-v2','cinematic-shot-designer-zh-v5']};assert.deepEqual(normalizeMethodPlan(route,d,catalog).skills,['image-prompt-gallery-director-v2']);assert.throws(()=>normalizeMethodPlan(route,{...d,requiredMethods:['cinematic-shot-designer-zh-v5']},catalog),/不兼容/);
});
test('history retrieval uses message anchors and preserves original pronouns',()=>{
 const state={id:'s',messages:[{role:'user',content:'你是什么模型'},{role:'assistant',content:'当前模型 X'},{role:'user',content:'你有什么工具'},{role:'assistant',content:'图片工具'}]},m=messageEvidence(state);
 assert.equal(resolveMessage(m,{speaker:'user',position:'previous'}).content,'你有什么工具');assert.equal(resolveMessage(m,{speaker:'user',position:'first'}).content,'你是什么模型');assert.equal(resolveMessage(m,{speaker:'assistant',position:'anchor',messageId:m[0].messageId}).content,'当前模型 X');assert.equal(resolveMessage(m,{speaker:'assistant',position:'previous'}).content,'图片工具');
});
test('typed model tools and skill selections do not use natural-language shortcuts',()=>{
 for(const type of ['model_identity','tools','skills'])assert.equal(queryGoal('任意表述',{type}).tasks[0].runtimeQuery.type,type);
 assert.equal(resolveSkillName(catalog,'creative-prompt-rewrite').length,1);
});
test('query responses use one semantic model request and read the exact ledger',async()=>{
 let calls=0;const kinds=['model_identity','tools','skills','message'];
 const brain={config:{model:'deepseek-flash'},respond:async input=>{
  const query=JSON.parse(input.at(-1).content).query,kind=kinds[calls++];
  return reply({summary:query,deliverables:[],gaps:[],assumptions:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},facts:[],globalConstraints:[],approval:{required:false,reason:''},turnOperation:{kind:'inspect',query:{kind,...(kind==='message'?{speaker:'user',position:'first'}:{})}}});
 }},runtime=new ToolRuntime({catalog,brain,media:{config:{}}}),state={id:'s',messages:[],events:[]},a=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,verifier:new Verifier(brain)});
 for(const q of ['你是什么模型','你有什么工具','你有什么skill，展示一下','我第一个问你的是什么'])await a.run(state,q,()=>{},sig());
 assert.equal(calls,4);const replies=state.events.filter(e=>e.type==='final').map(e=>e.text);assert.match(replies[0],/deepseek-flash/);assert(!replies[0].includes('generate_image'));assert(!replies[1].includes('本地 Skill'));assert(!replies[2].includes('generate_image 参数'));assert.equal(replies[3],'你是什么模型');assert(replies.every(x=>!x.includes('验收通过')));
});
test('new reference and derived documents do not become versions; actual modification does',()=>{
 for(const action of ['respond','create','modify']){const d={...deliverable(),kind:'text',action,references:['script']},state={id:'s'};createTask(state,goal(d),'查询');storeOf(state).artifacts.script=structuredClone(source);const t=currentTask(state);t.items[0].operation='answer';const executor=new TaskExecutor({state});const parent=executor.parentFor(t.items[0],'text');assert.equal(parent,action==='modify'?'script':null);const a=addArtifact(state,{itemId:t.items[0].id,type:'text',content:'新内容',parentId:parent});assert.equal(a.version,action==='modify'?3:1);assert.equal(a.relationships[0].relation,action==='modify'?'revision_of':action==='respond'?'references':'derived_from');}
});
test('shot rendering translates internal keys without dropping sections',()=>{
 const text=renderStage({shots:[{content:'完整内容',durationSeconds:5}],sections:[{title:'补充',content:'保留说明'}]});assert(!text.includes('content：'));assert(!text.includes('durationSeconds：'));assert(text.includes('完整内容'));assert(text.includes('保留说明'));assert(text.includes('5'));
});
test('failed intake has terminal timestamp and context only, never old task ownership',async()=>{
 const brain={respond:async()=>{throw Error('bad input')}},runtime=new ToolRuntime({catalog,brain,media:{config:{}}}),state={id:'s',messages:[],events:[]};
 createTask(state,goal({...deliverable(),references:[]}),'旧任务');const old=currentTask(state).id,a=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog});
 await a.run(state,'不匹配快捷查询的测试',()=>{},sig());const t=state.turns[0];assert.equal(t.status,'failed');assert(t.finishedAt);assert.equal(t.taskId,null);for(const e of state.events){assert.equal(e.taskId,null);assert.equal(e.contextTaskId,old);}assert.equal(currentTask(state).id,old);
});
test('compiled media records bounded coverage per output and only marks complete after all units',async()=>{
 const c=inventory(),d=deliverable();d.sourceSelection=selection(c);bindCoverage(d,c,'每镜一张');let serial=0;
 const brain={respond:async input=>{const p=JSON.parse(input.at(-1).content);return reply({concept:'三镜头',preservedConstraints:[],safety:{passed:true,reason:'正常'},items:p.assignments.map(a=>({prompt:a.units.map(u=>u.value.content).join('；'),size:'2048x2048',sourceUnitIds:a.unitIds}))});}};
 const runtime=new ToolRuntime({catalog,brain,media:{config:{imageModel:'fake'},image:async()=>({status:'succeeded',images:[{url:'https://test.invalid/'+ ++serial+'.png'}]})}});
 const verifier={verifyArtifact:async(i,a)=>({passed:true,outcome:'passed',issues:[],coverage:{passed:true,unitIds:a.metadata.coverage.unitIds},checker:{kind:'model'}})};
 const state={id:'s',messages:[],events:[]};storeOf(state).artifacts.script=structuredClone(source);const agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,verifier,intake:async()=>goal(d)});await agent.run(state,'每镜一张',()=>{},sig());
 assert.equal(state.status,'completed');assert.equal(serial,3);assert.equal(currentTask(state).items[0].coverageProgress.covered.length,3);assert(Object.values(state.taskStore.toolCalls).every(c=>c.startedAt&&c.finishedAt));assert(!Object.values(state.taskStore.toolCalls).some(c=>c.name==='find_material'));
});

test('bound shots validate typed source IDs without claiming to verify ordinal semantics',()=>{
 const c=inventory(),d=deliverable();d.requestEvidence='只生成第二镜的分镜图';d.sourceSelection=selection(c,'separate_images','selected',[sourceUnits(source)[1].id]);delete d.sourceSelection.evidence;
 bindCoverage(d,c,d.requestEvidence);assert.deepEqual(d.coverage.unitIds,[sourceUnits(source)[1].id]);
 d.sourceSelection.unitIds=['nonexistent-unit'];assert.throws(()=>bindCoverage(d,c,d.requestEvidence),/未知/);
});
test('media source scope cannot create an unrelated direction workflow',()=>{
 const c=inventory(),d=deliverable();d.sourceSelection=selection(c);d.form='directions';d.spec={directionCount:1,selectedDirectionIndex:2,ratio:'16:9'};
 bindCoverage(d,c,'每镜一张');assert.deepEqual(d.spec,{ratio:'16:9'});assert.deepEqual(normalizeMethodPlan({operation:'generate_image',skills:['image-prompt-gallery-director-v2']},d,catalog).skills,['image-prompt-gallery-director-v2']);
});
test('real verifier interface rejects missing and mismatched coverage even when outcome says passed',async()=>{
 const c=inventory(),d=deliverable();d.sourceSelection=selection(c);bindCoverage(d,c,'每镜一张');const assignment=coverageAssignments(d,[source])[0];
 for(const verdict of [{outcome:'passed',issues:[]},{outcome:'passed',issues:[],coverage:{passed:true,unitIds:[sourceUnits(source)[1].id]}}]){
  const v=new Verifier({respond:async()=>reply(verdict)});
  if(!verdict.coverage)await assert.rejects(v.judge('media',{coverage:assignment},sig(),{type:'input_image',image_url:'https://test.invalid/a.png'}),/合同/);
  else assert.equal((await v.judge('media',{coverage:assignment},sig(),{type:'input_image',image_url:'https://test.invalid/a.png'})).passed,false);
 }
});
test('one accepted image leaves the three-unit task incomplete',()=>{
 const c=inventory(),d=deliverable();d.sourceSelection=selection(c);bindCoverage(d,c,'每镜一张');const state={id:'s'};createTask(state,goal(d),'每镜一张');const task=currentTask(state),assignment=coverageAssignments(d,[source])[0];
 const a=addArtifact(state,{itemId:task.items[0].id,type:'image',url:'https://test.invalid/a.png',metadata:{coverage:assignment},verification:{technical:'passed',semantic:'passed'}});a.acceptance={quality:{coverage:{passed:true,unitIds:assignment.unitIds}}};reconcileTask(state);assert.notEqual(task.status,'COMPLETED');assert.equal(task.items[0].coverageProgress.missing.length,2);
});
test('tool exception persists start end and no ownership of old focus',async()=>{
 const state={id:'s',currentRunId:'run',turns:[{runId:'run',taskId:null}],taskStore:{activeTaskId:'old',toolCalls:{}}};let saves=0;
 await assert.rejects(withTrace(state,async()=>saves++,()=>withTool('analyze_image',{},async()=>{throw Error('offline');})),/offline/);
 const call=Object.values(state.taskStore.toolCalls)[0];assert.equal(call.status,'failed');assert(call.startedAt&&call.finishedAt);assert.equal(call.taskId,null);assert.equal(call.contextTaskId,'old');assert.equal(saves,2);
});
test('session recovery closes interrupted spans while active reads preserve running state',async()=>{
 const directory=fs.mkdtempSync(join(tmpdir(),'mvp-recovery-')),store=new SessionStore(directory),id=randomUUID(),state={id,currentRunId:'run',turns:[{runId:'run',status:'running'}],modelCalls:[{startedAt:'now'}]};storeOf(state).toolCalls.a={status:'running'};storeOf(state).executions.a={status:'pending'};
 try{await store.save(state);const active=await store.load(id,{recover:false});assert.equal(active.turns[0].status,'running');assert.equal(active.taskStore.executions.a.status,'pending');const recovered=await store.load(id);assert.equal(recovered.turns[0].status,'interrupted');assert(recovered.turns[0].finishedAt);assert.equal(recovered.taskStore.toolCalls.a.status,'unknown');assert.equal(recovered.taskStore.executions.a.status,'unknown');assert.equal(recovered.modelCalls[0].status,'interrupted');}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('missing facts and ambiguous names never claim answer coverage',()=>{
 assert.equal(queryChecks({query:{type:'history'},message:null}).answerCovered,false);
 assert.equal(queryChecks({query:{type:'model_identity'},modelIdentity:{configuredModel:null}}).queryResolved,false);
 assert.equal(queryChecks({query:{type:'skill_detail'},resolved:false,skills:[]}).answerCovered,false);
 assert.equal(resolveSkillName(catalog,'提示词改写skill是什么，顺便生成一张图').length,0);
});
test('partitioned deliverables cover each source once and reject three first-shot copies',()=>{
 const c=inventory(),units=sourceUnits(source),ds=units.map(u=>({...deliverable(),sourceSelection:{...selection(c,'separate_images','selected',[u.id]),evidence:'每镜一张'}}));
 for(const d of ds){assert.equal(bindCoverage(d,c,'每镜一张',ds),undefined);assert.equal(d.count,1);}
 for(const d of ds)d.sourceSelection.unitIds=[units[0].id];assert.throws(()=>bindCoverage(ds[0],c,'每镜一张',ds),/覆盖重复/);
});
test('explicit source scope missing in model output is repaired locally rather than asked again',async()=>{
 const d=deliverable();d.requestEvidence='只生成第二镜的分镜图';let calls=0;
 const result=await understandGoal({respond:async input=>{calls++;if(calls===1)return reply(semantic(d));if(calls===2){const p=JSON.parse(input.at(-1).content);assert.deepEqual(p.missingPaths,['/deliverables/0/sourceSelection']);return reply({field_0:{source:'script',unitType:'shots',mode:'selected',unitIds:[sourceUnits(source)[1].id],layout:'separate_images'}});}return reply({routes:[{deliverableIndex:0,operation:'generate_image',skills:[]}]});}},catalog,{query:d.requestEvidence,taskCandidates:[{id:'old',artifacts:[source]}]},sig());
 assert.equal(result.needsClarification,false);assert.equal(result.tasks[0].coverage.unitIds[0],sourceUnits(source)[1].id);assert.equal(calls,2);
});
test('model supplied coverage without a real source never becomes a binding',()=>{
 const d={...deliverable(),references:[],coverage:{unitIds:['invented']}};bindCoverage(d,inventory(),'生成一张图');assert.equal(d.coverage,undefined);
});
test('prepared batch detects coverage and source tampering; changed coverage invalidates approval',async()=>{
 const c=inventory(),d=deliverable();d.sourceSelection=selection(c);bindCoverage(d,c,'每镜一张');const g=goal(d);g.semantic.approval={required:true,reason:'先确认'};
 const brain={respond:async input=>{const p=JSON.parse(input.at(-1).content);return reply({concept:'三镜',preservedConstraints:[],safety:{passed:true,reason:'正常'},items:p.assignments.map(a=>({prompt:'完整画面',size:'2048x2048',sourceUnitIds:a.unitIds}))});}},runtime=new ToolRuntime({catalog,brain,media:{config:{imageModel:'fake'},image:async()=>{throw Error('MUST_NOT_SUBMIT');}}}),state={id:'s',messages:[],events:[]};storeOf(state).artifacts.script=structuredClone(source);
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,intake:async()=>g}).run(state,'每镜一张，先确认',()=>{},sig());const task=currentTask(state),node=task.executionPlan.nodes[0],batch=task.batches[node.batchId];assert.equal(task.status,'WAIT_CONFIRM');validatePrepared(task,node,state);
 batch.coverage[0].source.version++;assert.throws(()=>validatePrepared(task,node,state),/映射已变化/);batch.coverage[0].source.version--;validatePrepared(task,node,state);
 const payload=structuredClone(task.approval.payload);approveTask(state,task.id,task.approval.planHash);payload.coverage[0].unitIds=['wrong'];assert.equal(requireApproval(state,payload),false);
 state.taskStore.artifacts.script.metadata.structure.shots.reverse();assert.throws(()=>validatePrepared(task,node,state),/已变化/);assert.equal(Object.keys(storeOf(state).executions).length,0);
});
