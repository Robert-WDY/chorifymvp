import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {reconcileContinuation} from '../server/task-control.mjs';
import {canonicalReferences,resolveSources} from '../server/sources.mjs';
import {understandGoal} from './intake-compat.mjs';
import {intentPrompt} from '../server/intent.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {evidenceContext} from '../server/model-context.mjs';
import {reconcileFixedSpec} from '../server/fixed-spec.mjs';
const fixtures=JSON.parse(await readFile(new URL('./fixtures/state-control-failures.json',import.meta.url),'utf8'));
const message=v=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(v)}]}];
const sig=()=>new AbortController().signal;
test('recorded image edit labelled continue becomes a revision without mutating old state',()=>{
 const f=fixtures[0],before=JSON.stringify(f);const result=reconcileContinuation(f.value,f.snapshot);
 assert.equal(result.continuation.mode,'revise');assert.deepEqual(result.deliverables,f.value.deliverables);assert.equal(JSON.stringify(f),before);
});
test('recorded prefixed references resolve to actual IDs and duplicate URL/ID collapses',()=>{
 for(const id of ['S017-r1','S018-r1']){const f=fixtures.find(f=>f.id===id),inventory=[...f.assets,...(f.snapshot?.artifacts||[])];const refs=canonicalReferences(f.value.deliverables[0].references,inventory);assert.equal(refs.length,1);assert.ok(!refs[0].startsWith('artifact:')&&!refs[0].startsWith('asset:'));}
 assert.throws(()=>canonicalReferences(['asset:unknown'],[{assetId:'real'}]),/不存在/);
});
test('NEEDS_INPUT with a complete replacement recompiles and inherits missing fixed spec and approval',()=>{
 const f=fixtures[0],snapshot=structuredClone(f.snapshot);snapshot.status='NEEDS_INPUT';snapshot.approval.required=true;snapshot.goal.semantic.deliverables[0].action='modify';snapshot.goal.semantic.deliverables[0].spec={ratio:'1:1'};
 const v=structuredClone(f.value);delete v.deliverables[0].spec;v.deliverables[0].constraints=structuredClone(snapshot.goal.semantic.deliverables[0].constraints);
 const out=reconcileContinuation(v,snapshot);assert.equal(out.continuation.mode,'clarify');assert.equal(out.approval.required,true);assert.equal(out.deliverables[0].spec.ratio,'1:1');
});
test('changed unfinished constraints cannot silently reuse the old goal; unchanged resume remains valid',()=>{
 const f=fixtures[0],snapshot=structuredClone(f.snapshot);snapshot.artifacts=[];snapshot.status='WAITING';
 const v=structuredClone(f.value);assert.throws(()=>reconcileContinuation(v,snapshot),/不能直接复用/);
 v.deliverables=structuredClone(snapshot.goal.semantic.deliverables);assert.equal(reconcileContinuation(v,snapshot).continuation.mode,'continue');
});
test('recorded sequential script/video plan loses invented approval through independent raw-query gate',async()=>{
 const f=fixtures.find(f=>f.id==='C024-r1');let calls=0;
 const brain={respond:async input=>{calls++;if(input[0].content.includes('需求理解器'))return message(f.value);if(input[0].content.includes('确认义务判定器')){assert.deepEqual(JSON.parse(input[1].content),{query:f.query});return message({required:false,evidence:''});}return message({routes:[{deliverableIndex:0,operation:'storyboard',skills:[]},{deliverableIndex:1,operation:'generate_video',skills:[]}]});}};
 const g=await understandGoal(brain,await loadCatalog(),{query:f.query,strictControl:true},sig());assert.equal(calls,2);assert.equal(g.semantic.approval.required,false);assert.deepEqual(g.tasks[1].dependsOn,[0]);
});
test('source alias never selects a different session or invents an asset',()=>{
 const state={taskStore:{artifacts:{a:{id:'a',type:'text',content:'original'}},inputs:{},tasks:{}}};
 assert.equal(resolveSources(state,{references:['artifact:a']})[0].content,'original');
 assert.throws(()=>resolveSources(state,{references:['artifact:other-session']}),/不存在/);
});

test('approval cannot authorize changed frozen parameters',()=>{
 const f=fixtures[0],snapshot=structuredClone(f.snapshot),v=structuredClone(f.value);
 snapshot.status='WAIT_CONFIRM';snapshot.artifacts=[];snapshot.items=[{output:'image',count:1,status:'WAIT_CONFIRM',spec:{ratio:'1:1'},constraints:['白背景']}];
 v.continuation.mode='approve';v.deliverables[0].spec={ratio:'16:9'};
 assert.throws(()=>reconcileContinuation(v,snapshot),/不能批准旧参数/);
});

test('support artifacts do not authorize an automatic revision',()=>{
 const f=fixtures[0],snapshot=structuredClone(f.snapshot);snapshot.artifacts.forEach(a=>a.purpose='support');
 assert.throws(()=>reconcileContinuation(f.value,snapshot),/不能直接复用/);
});

test('recorded continue edit passes intake as a newly compiled edit instead of old-task resume',async()=>{
 const f=fixtures[0];let calls=0;
 const brain={respond:async()=>message(++calls===1?f.value:{routes:[{deliverableIndex:0,operation:'edit_image',skills:[]}]})};
 const goal=await understandGoal(brain,await loadCatalog(),{query:f.query,assets:f.assets,taskSnapshot:f.snapshot,strictControl:true},sig());
 assert.equal(calls,1);assert.equal(goal.resumeTaskId,undefined);assert.equal(goal.semantic.continuation.mode,'revise');assert.equal(goal.tasks[0].operation,'edit_image');assert.ok(goal.tasks[0].constraints.includes('背景改为海边'));
});

test('revision receives original user data for its direct sources without unrelated history',()=>{
 const state={taskStore:{activeTaskId:'new',tasks:{new:{query:'改成口语'},old:{query:'品牌资料 CTX_RIVER_731'},unrelated:{query:'irrelevant noise'}}}};
 const ctx=evidenceContext(state,{},[{id:'a',taskId:'old'},{id:'b',taskId:'old'}]);
 assert.deepEqual(ctx.sourceRequests,[{taskId:'old',query:'品牌资料 CTX_RIVER_731'}]);assert.ok(!JSON.stringify(ctx).includes('irrelevant noise'));
});

test('pure approval restores durable goal without regenerating a dependency graph',async()=>{
 const f=fixtures[0],snapshot=structuredClone(f.snapshot),v=structuredClone(f.value);snapshot.status='WAIT_CONFIRM';v.continuation.mode='approve';v.deliverables=[];
 const brain={respond:async input=>message(input[0].content.includes('独立核对本轮任务操作')?{operation:'approve',evidence:'确认'}:v)};
 const goal=await understandGoal(brain,await loadCatalog(),{query:'确认，按当前方案生成',taskSnapshot:snapshot,strictControl:true},sig());
 assert.equal(goal.resumeTaskId,snapshot.id);assert.deepEqual(goal.semantic.deliverables,snapshot.goal.semantic.deliverables);
});

test('explicit clarification cannot silently drop original constraints or quantities',()=>{
 const f=fixtures[0],snapshot=structuredClone(f.snapshot),v=structuredClone(f.value);snapshot.status='NEEDS_INPUT';v.continuation.mode='clarify';v.deliverables=structuredClone(snapshot.goal.semantic.deliverables);
 v.deliverables[0].constraints=[];assert.throws(()=>reconcileContinuation(v,snapshot),/不能丢失/);
 v.deliverables=structuredClone(snapshot.goal.semantic.deliverables);v.deliverables[0].count=2;assert.throws(()=>reconcileContinuation(v,snapshot),/不能丢失/);
 v.deliverables=[];v.gaps=[];assert.equal(reconcileContinuation(v,snapshot).continuation.mode,'clarify');
});

test('literal ratio clauses fill missing spec and detect contradictory structured input',()=>{
 for(const clause of ['输出1:1图片','输出比例 1:1','输出 1:1 比例','画幅16:9','比例：3:4','9:16'])assert.ok(reconcileFixedSpec({constraints:[clause]}).spec.ratio);
 assert.equal(reconcileFixedSpec({constraints:['输出1:1图片']}).spec.ratio,'1:1');
 assert.throws(()=>reconcileFixedSpec({constraints:['1:1','16:9']}),/冲突/);
 assert.throws(()=>reconcileFixedSpec({constraints:['1:1'],spec:{ratio:'16:9'}}),/不一致/);
 for(const clause of ['不要16:9','参考图是1:1，输出16:9','改为16:9或者1:1'])assert.equal(reconcileFixedSpec({constraints:[clause]}).spec,undefined);
});

test('pending control corrects approval and routes read-only inspection to its own goal',async()=>{
 for(const operation of ['approve','inspect']){
  const f=fixtures[0],snapshot=structuredClone(f.snapshot),v=structuredClone(f.value);snapshot.status='WAIT_CONFIRM';v.deliverables=[];v.continuation.mode=operation==='approve'?'continue':'approve';let calls=0;
  const query=operation==='approve'?'确认，按当前已展示方案生成。':'只看进度，不要生成';
  const brain={respond:async input=>{calls++;if(input[0].content.includes('独立核对本轮任务操作')){assert.equal(JSON.parse(input[1].content).query,query);return message({operation,evidence:query});}if(calls===3)return message({...v,continuation:{mode:'new',taskId:''},deliverables:[{description:query,kind:'text',count:1,action:'query',purpose:'general',requiredEvidence:'task',references:[],dependsOn:[],constraints:[],requestEvidence:query}]});if(calls===4)return message({routes:[{deliverableIndex:0,operation:'query_task',skills:[]}]});return message(v);}};
  const goal=await understandGoal(brain,await loadCatalog(),{query,taskSnapshot:snapshot,strictControl:true},sig());assert.equal(goal.resumeTaskId,operation==='approve'?snapshot.id:undefined);assert.equal(goal.semantic.continuation.mode,operation==='approve'?'approve':'new');
 }
});

test('assetId aliases resolve only known assets and invalid references discard the misleading draft',()=>{
 assert.deepEqual(canonicalReferences(['assetId:real','https://example.test/a'],[{assetId:'real',url:'https://example.test/a'}]),['real']);
 assert.throws(()=>canonicalReferences(['CTX_RIVER_731'],[]),e=>e.discardDraft===true);
});

test('strict intake prompt advertises required controls and bad source IDs are not echoed during recovery',async()=>{
 const prompt=intentPrompt({strictControl:true}),schema=JSON.parse(prompt.split('当前wire Schema：')[1]);assert.ok(schema.required.includes('approval'));assert.ok(schema.required.includes('turnOperation'));assert.equal(schema.properties.continuation,undefined);
 const f=fixtures[0],bad=structuredClone(f.value);bad.deliverables[0].references=['CTX_RIVER_731'];let calls=0;
 const brain={respond:async input=>{calls++;if(calls===1)return message(bad);if(calls===2){assert.ok(!input.some(m=>m.role==='assistant'));const payload=JSON.parse(input.at(-1).content);return message({'0':[payload.candidates.find(c=>c.id===f.assets.find(a=>a.url===f.value.deliverables[0].references[0]).assetId).handle]});}return message({routes:[{deliverableIndex:0,operation:'edit_image',skills:[]}]});}};
 const goal=await understandGoal(brain,await loadCatalog(),{query:f.query,assets:f.assets,taskSnapshot:f.snapshot,strictControl:true},sig());assert.equal(calls,2);assert.equal(goal.tasks[0].operation,'edit_image');
});
