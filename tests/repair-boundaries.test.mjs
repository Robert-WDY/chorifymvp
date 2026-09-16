import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonicalDocument,acceptanceRecord,digest} from '../server/document-contract.mjs';
import {renderStage,selectStageSources} from '../server/text-stage.mjs';
import {planSpecs,normalizeMethodPlan,ensureMethodDefaults,assertWorkflow,revisionMediaScope,auditedDeliveryScope,inheritMediaObligations,discardInheritanceForNewTask} from '../server/planning-boundary.mjs';
import {resolveTaskReferenceAliases} from '../server/sources.mjs';
import {normalizeSemanticMetadata,parseStructured,normalizeOutputMetadata} from '../server/structured-codec.mjs';
import {DeepSeek} from '../server/adapters.mjs';
import {tracedBrain,withTrace} from '../server/trace-context.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {understandGoal} from './intake-compat.mjs';
import {semanticSchema} from '../server/intent.mjs';
import {structuredOutput,textSchema} from '../server/goal-compiler.mjs';
import {createTask,currentTask,addArtifact,reconcileTask,taskSnapshot} from '../server/task-state.mjs';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
import {reconcileFixedSpec} from '../server/fixed-spec.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=x=>[{type:'message',role:'assistant',content:[{type:'output_text',text:typeof x==='string'?x:JSON.stringify(x)}]}];
const state=()=>({id:'repair',messages:[],events:[]});
const pass=()=>({passed:true,uncertain:false,issues:[],evaluationPolicy:'procedure_only_not_quality'});
const semantic=(overrides={})=>({summary:'文字任务',deliverables:[{description:'两句标题',kind:'text',count:2,action:'create',purpose:'marketing',form:'title',executionShape:'direct',requiredEvidence:'none',references:[],dependsOn:[],constraints:[],requestEvidence:'两句标题'}],gaps:[],assumptions:[],deferred:[],facts:[],globalConstraints:[],safety:{disposition:'allow',reason:'',untrustedInstructions:false},approval:{required:false,reason:''},continuation:{mode:'new',taskId:''},...overrides});
const goal=items=>({summary:'goal',tasks:items.map(i=>({operation:'answer',output:'text',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none',spec:{},...i})),skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow'},semantic:{approval:{required:false},continuation:{mode:'new'},deliverables:items.map(i=>({description:i.description||'goal'}))}});
function fixture(g,respond){const s=state(),brain={respond},runtime=new ToolRuntime({catalog,brain,media:{config:{},image:async()=>{throw new Error('unexpected paid submission');},video:async()=>{throw new Error('unexpected paid submission');}}});return {s,brain,runtime,agent:new Agent({effectPolicy:'trusted_embedder',catalog,brain,runtime,intake:async()=>g,verifier:{verifyText:async()=>pass(),verifyPlan:async()=>pass(),verifyArtifact:async()=>pass()}})};}

test('747 captured raw content survives identity publication including table and video specs',async()=>{
 const trace=JSON.parse(await readFile(new URL('./fixtures/747-publication.json',import.meta.url)));
 const call=trace.calls.find(c=>c.id==='d7831ecf-d012-4686-9124-310ff3bdee95');
 const raw=JSON.parse(call.output.flatMap(o=>o.content||[]).map(p=>p.text||'').join('\n'));
 assert.equal(raw.content.length,1284);assert.equal(renderStage(raw.structure).length,383);
 const result=canonicalDocument(raw,'content',renderStage);assert.equal(result.content,raw.content);assert.equal(result.conversion.outputHash,digest(raw.content));
 const f=fixture(goal([{operation:'marketing_script',requiredMethods:['video-script-zh-v1']}]),async()=>reply(raw));
 await f.agent.run(f.s,'根据波音747生成宣传的视频脚本',()=>{},signal());
 const a=Object.values(f.s.taskStore.artifacts).find(a=>a.purpose==='deliverable');assert.equal(a.content,raw.content);assert.equal(currentTask(f.s).status,'COMPLETED');
 assert.equal(a.acceptance.inputHash,a.metadata.conversion.outputHash);a.content+='tampered';reconcileTask(f.s);assert.notEqual(currentTask(f.s).status,'COMPLETED');
});
test('pure prompt identity renderer does not inject template headings or duplicate metadata',()=>{
 const raw={content:'飞机缓缓滑行，镜头跟随。',structure:{prompt:'飞机缓缓滑行，镜头跟随。',preservedConstraints:['只给提示词']}};
 assert.equal(canonicalDocument(raw,'content',renderStage).content,raw.content);
});
test('structured document has one authority and retains supplementary sections',()=>{
 const raw={structure:{shots:[{content:'镜头内容',durationSeconds:5}],durationSeconds:5,sections:[{title:'规格',content:'16:9\n|镜号|旁白|\n|1|起飞|'}]}};
 const doc=canonicalDocument(raw,'structured',renderStage);assert.match(doc.content,/\|镜号\|旁白\|/);assert.match(doc.content,/16:9/);
 assert.throws(()=>canonicalDocument({...raw,content:'contradictory body'},'structured',renderStage),/不能同时/);
});
test('JSON missing-field replay is fixed at transport without changing original input',async()=>{
 const input=[{role:'system',content:'补齐事实与约束'},{role:'user',content:'背景变白'}],original=structuredClone(input);let body;
 const brain=new DeepSeek({key:'private',baseUrl:'https://test.invalid',model:'test'},async(_url,init)=>{body=JSON.parse(init.body);assert.match(JSON.stringify(body.input),/JSON/);return Response.json({output:reply({facts:[],globalConstraints:[]})});});
 await brain.respond(input,[],signal(),{json:true});assert.deepEqual(input,original);assert.deepEqual(body.input.slice(1),input);
});
test('protocol errors retain redacted body and do not retry as content repairs',async()=>{
 let calls=0;const s=state();const brain=tracedBrain(new DeepSeek({key:'private-token',baseUrl:'https://test.invalid',model:'test'},async()=>{calls++;return Response.json({error:{code:'invalid_request_error',message:'bad private-token sk-123456789012345 https://x.invalid/a?secret=yes'}},{status:400,headers:{'x-request-id':'request-400'}});}));
 await assert.rejects(withTrace(s,async()=>{},()=>structuredOutput(brain,'写文字',{},textSchema,signal())),e=>e.category==='request_protocol');assert.equal(calls,1);
 const record=s.modelCalls[0].providerResponse;assert.equal(record.requestId,'request-400');assert.equal(record.body.error.code,'invalid_request_error');assert.ok(!JSON.stringify(record).includes('private-token'));assert.ok(!JSON.stringify(record).includes('secret=yes'));
});
test('billing and authentication are distinguished even when both use HTTP403',async()=>{
 for(const [code,expected] of [['AccountOverdueError','billing'],['permission_denied','authentication']]){
  const b=new DeepSeek({key:'private',baseUrl:'https://test.invalid',model:'test'},async()=>Response.json({error:{code,message:'detail'}},{status:403}));await assert.rejects(b.respond([],[],signal()),e=>e.category===expected);
 }
});
test('normalization removes only proven redundant metadata, never a different business count',()=>{
 const v=semantic();v.type='object';v.artifactCount=1;v.contentCardinality=2;const d=structuredClone(v.deliverables);normalizeSemanticMetadata(v);assert.deepEqual(v.deliverables,d);assert.equal(v.type,undefined);assert.equal(v.artifactCount,undefined);
 const different=semantic();different.artifactCount=4;normalizeSemanticMetadata(different);assert.equal(different.artifactCount,4);
});
test('greeting metadata pollution completes intake without another understanding call',async()=>{
 const s=semantic();s.deliverables[0]={...s.deliverables[0],count:1,action:'respond',purpose:'general',form:'answer'};s.artifactCount=1;s.type='object';let calls=0;
 const result=await understandGoal({respond:async()=>reply(++calls===1?s:{routes:[{deliverableIndex:0,operation:'answer',skills:[]}]})},catalog,{query:'你好',strictControl:true},signal());assert.equal(calls,1);assert.equal(result.tasks[0].operation,'answer');
});
test('system-only 5x5!=5 is corrected before writing without changing user constraints',()=>{
 const d={spec:{shotCount:5,secondsPerShot:5,durationSeconds:5},constraints:['确认后生成']};planSpecs(d,{query:'先写咖啡店视频脚本，等我确认后生成'});assert.equal(d.spec.secondsPerShot,undefined);assert.equal(d.spec.durationSeconds,5);assert.equal(d.specOrigins.secondsPerShot.discardedValue,5);assert.deepEqual(d.constraints,['确认后生成']);
});
test('explicit or inherited contradictory timing is not silently loosened',()=>{
 assert.throws(()=>planSpecs({spec:{shotCount:5,secondsPerShot:5,durationSeconds:5}},{query:'5镜，每镜5秒，总长5秒'}),/规格冲突/);
 const previous={spec:{shotCount:5,secondsPerShot:5,durationSeconds:5}};assert.throws(()=>planSpecs(structuredClone(previous),{query:'继续',previous}),/规格冲突/);
});
test('missing direction count receives an attributable system default',()=>{
 const d={spec:{},count:1};ensureMethodDefaults(d,['direction-designer-zh-v1'],catalog);assert.equal(d.spec.directionCount,3);assert.equal(d.specOrigins.directionCount.origin,'system_default');assert.equal(d.count,1);
});
test('missing producer is repaired in method plan; corrupt graphs cannot run',()=>{
 const d={requiredMethods:['marketing-brief-zh-v1','video-script-zh-v1'],form:'directions',action:'create',kind:'text',purpose:'storyboard',executionShape:'workflow',spec:{directionCount:2,selectedDirectionIndex:2},dependsOn:[]};
 const r=normalizeMethodPlan({operation:'storyboard',skills:['marketing-brief-zh-v1','video-script-zh-v1']},d,catalog);
 assert.deepEqual(r.skills,['marketing-brief-zh-v1','direction-designer-zh-v1','video-script-zh-v1']);
 const item={...d,output:'text',requiredMethods:r.skills};assert.doesNotThrow(()=>assertWorkflow(item,[],catalog));
 assert.throws(()=>assertWorkflow({...item,requiredMethods:['video-script-zh-v1']},[],catalog),/前置生产/);
 assert.throws(()=>assertWorkflow({...item,requiredMethods:['video-script-zh-v1','direction-designer-zh-v1']},[],catalog),/前置生产/);
});
test('simple titles cannot acquire a video script; explicit requested methods survive',()=>{
 const d=semantic().deliverables[0],r={operation:'marketing_script',skills:['creative-cover-copy-v2','video-script-zh-v1']};assert.deepEqual(normalizeMethodPlan(r,d,catalog).skills,['creative-cover-copy-v2']);
 assert.deepEqual(normalizeMethodPlan(r,{...d,requiredMethods:r.skills},catalog).skills,r.skills);
});
test('scope revision keeps future video while current execution is paused; explicit removal is evidence-bound',()=>{
 const previous={goal:{requestContract:{media:{image:0,video:1,audio:0}}}};
 const r=revisionMediaScope({media:{image:0,video:0,audio:0},readOnly:true},previous,'改竖屏，先别生成');assert.equal(r.media.video,1);assert.equal(r.readOnly,false);assert.equal(r.currentPermission.mediaSubmission,'approval_gate');
 assert.equal(revisionMediaScope({media:{},mediaChanges:[{kind:'video',count:0,evidence:'取消视频'}]},previous,'取消视频，只要文字').media.video,0);
 assert.throws(()=>revisionMediaScope({mediaChanges:[{kind:'video',count:0,evidence:'取消视频'}]},previous,'暂停视频'),/原文证据/);
});
test('new task missing a source becomes NEEDS_INPUT despite empty clarify task ID',async()=>{
 const s=semantic({gaps:[{description:'缺源图片',level:'blocking',kind:'user_input',resolution:'提供图片'}],continuation:{mode:'clarify',taskId:''}});let calls=0;
 const g=await understandGoal({respond:async()=>{calls++;return reply(s);}},catalog,{query:'把这张图背景去掉',strictControl:true,auditContracts:true},signal());assert.equal(g.needsClarification,true);assert.equal(g.semantic.continuation.mode,'new');assert.equal(calls,1);
 const f=fixture(g,async()=>{throw new Error('must wait');});await f.agent.run(f.s,'把这张图背景去掉',()=>{},signal());assert.equal(currentTask(f.s).status,'NEEDS_INPUT');
});
test('unavailable explicit skill produces a preserved capability gap without planner retry',async()=>{
 const s=semantic();s.deliverables[0].requiredMethods=['super-director'];let calls=0;
 const g=await understandGoal({respond:async()=>{calls++;return reply(s);}},catalog,{query:'用super-director写两句标题',strictControl:true,auditContracts:true},signal());assert.equal(calls,1);assert.equal(g.capabilityGap.methods[0],'super-director');
 const f=fixture(g,async()=>{throw new Error('not executable');});await f.agent.run(f.s,'query',()=>{},signal());assert.equal(currentTask(f.s).status,'BLOCKED');assert.equal(currentTask(f.s).recovery.kind,'unsupported');
});
test('test verifier can complete procedure without certifying factual support or quality',async()=>{
 const f=fixture(goal([{}]),async()=>reply({content:'正文'}));await f.agent.run(f.s,'正文',()=>{},signal());const t=currentTask(f.s),a=Object.values(f.s.taskStore.artifacts)[0];assert.equal(t.status,'COMPLETED');assert.equal(t.verification.quality,'not_evaluated');assert.equal(a.acceptance.factualSupport,'not_checked');assert.equal(a.acceptance.quality.status,'not_evaluated');
 const v=await new Verifier({respond:async()=>reply({outcome:'passed',issues:[]})}).verifyText(t.items[0],a.content,f.s,signal());assert.equal(acceptanceRecord(v,a.content).quality.status,'passed');
});
test('image observation reaches actual visual input and is bound to the observed source',async()=>{
 let visual=0;const f=fixture(goal([{operation:'analyze_image',requiredEvidence:'image',references:['source']}]),async input=>{
  const parts=input.flatMap(m=>Array.isArray(m.content)?m.content:[]);if(parts.some(p=>p.type==='input_image')){visual++;assert.equal(parts.find(p=>p.type==='input_image').image_url,'https://test.invalid/source.png');return reply('画面观察结果');}const payload=JSON.parse(input[1].content);assert.equal(payload.observations[0].result.text,'画面观察结果');return reply({content:'根据实际观察回答'});
 });f.s.assets=[{assetId:'source',kind:'image',url:'https://test.invalid/source.png'}];await f.agent.run(f.s,'看这张图',()=>{},signal());assert.equal(visual,1);assert.equal(currentTask(f.s).status,'COMPLETED');assert.equal(currentTask(f.s).items[0].observations[0].source.id,'source');
});
test('visual observation failure cannot fabricate a completed analysis or paid generation',async()=>{
 const f=fixture(goal([{operation:'analyze_image',requiredEvidence:'image',references:['source']}]),async()=>{throw new Error('vision unavailable');});f.s.assets=[{assetId:'source',kind:'image',url:'https://test.invalid/source.png'}];await f.agent.run(f.s,'看图',()=>{},signal());assert.equal(currentTask(f.s).status,'BLOCKED');assert.equal(Object.keys(f.s.taskStore.executions).length,0);
});
test('selector role preserves contract in producer inputs and binds consumers to stable versions',()=>{
 const source={id:'directions',version:4,structure:{directions:[{id:'one',content:'one'},{id:'two',content:'two',version:999,artifactId:'forged'}]}};
 const producer=selectStageSources([source],{selectionRole:'producer',spec:{selectedDirectionIndex:2}})[0];assert.equal(producer.selectedDirection,undefined);
 const bound=selectStageSources([source],{selectionRole:'consumer',spec:{selectedDirectionIndex:2}})[0];assert.equal(bound.selectedDirection.version,4);assert.equal(bound.selectedDirection.artifactId,'directions');assert.equal(bound.selectedDirection.index,2);
});
test('general script skill has no locked-grid prerequisites and does not ask for additional generated media',async()=>{
 const text=await readFile('skills/video-script-zh-v1/instructions.md','utf8');assert.ok(!text.includes('前序已锁定五张'));assert.match(text,/普通宣传/);assert.match(text,/不调用生成工具/);
});
test('orientation labels compile to valid tool ratios without overriding an explicit compatible ratio',()=>{
 const portrait={spec:{ratio:'竖屏'},specOrigins:{},constraints:[]};reconcileFixedSpec(portrait);assert.equal(portrait.spec.ratio,'9:16');assert.equal(portrait.specOrigins.ratio.originalRepresentation,'竖屏');
 const exact={spec:{ratio:'竖屏'},constraints:['比例3:4']};reconcileFixedSpec(exact);assert.equal(exact.spec.ratio,'3:4');
 assert.throws(()=>reconcileFixedSpec({spec:{ratio:'横屏'},constraints:['9:16']}),/冲突/);
});
test('a title-only delivery renders its verified body without adding status templates or assumptions',async()=>{
 const g=goal([{form:'title',executionShape:'direct'}]);g.assumptions=['普通样稿'];const f=fixture(g,async()=>reply({content:'标题一\n标题二'}));let final;
 await f.agent.run(f.s,'只要标题',e=>{if(e.type==='final')final=e;},signal());assert.equal(final.text,'标题一\n标题二');
});
test('captured premature JSON root is repaired without losing future media or approval fields',async()=>{
 const x=JSON.parse(await readFile(new URL('./fixtures/premature-json-approval.json',import.meta.url)));
 const raw=x.state.modelCalls[0].output.flatMap(o=>o.content||[]).map(p=>p.text||'').join('\n');
 assert.throws(()=>JSON.parse(raw));const recovered=parseStructured(raw,semanticSchema);assert.equal(recovered.deliverables[1].kind,'video');assert.equal(recovered.approval.required,true);assert.equal(recovered.continuation.mode,'new');
});
test('syntax repair refuses separate objects, duplicate business keys and unknown suffix fields',()=>{
 for(const raw of ['{"content":"one"}{"content":"two"}','{"content":"one"},"content":"two"}','{"content":"one"},"surprise":true}','{"content":"one"},"known":1,"known":2}'])assert.throws(()=>parseStructured(raw,{properties:{content:{},known:{}}}));
 assert.deepEqual(parseStructured('{"content":"a } , \\"literal\\""}',textSchema),{content:'a } , "literal"'});
});
test('scope sums pending deliveries independently of immediately permitted media',()=>{
 const query='先写脚本，确认后生成视频';const result=auditedDeliveryScope({finalDeliverables:[{kind:'text',count:1,timing:'now',evidence:'先写脚本'},{kind:'video',count:1,timing:'after_approval',evidence:'确认后生成视频'}]},query);assert.equal(result.media.video,1);assert.equal(result.currentPermission.mediaBudget.video,0);
 assert.throws(()=>auditedDeliveryScope({finalDeliverables:[{kind:'image',count:1,timing:'now',evidence:'额外生成图片'}]},query),/依据/);
});
test('revision preserves omitted future video and rebinds its dependency to updated text',()=>{
 const previous={approval:{required:true},goal:{semantic:{deliverables:[{kind:'text',count:1},{kind:'video',count:1,dependsOn:[0],references:['task:0'],spec:{durationSeconds:5}}]}}};
 const s={continuation:{mode:'revise'},approval:{required:false},deliverables:[{kind:'text',count:1,spec:{durationSeconds:10,ratio:'9:16'}}]};inheritMediaObligations(s,previous);assert.equal(s.deliverables[1].kind,'video');assert.deepEqual(s.deliverables[1].dependsOn,[0]);assert.equal(s.deliverables[1].spec.durationSeconds,10);assert.equal(s.approval.required,true);
 s.continuation.mode='new';discardInheritanceForNewTask(s);assert.equal(s.deliverables.length,1);assert.equal(s.approval.required,false);
 const cancelled={continuation:{mode:'revise'},approval:{required:true},deliverables:[{kind:'text'}]};inheritMediaObligations(cancelled,previous,{image:0,video:0,audio:0});assert.equal(cancelled.deliverables.length,1);assert.equal(cancelled.approval.required,false);
});
test('task slot aliases resolve only inside the named task and only to one accepted version',()=>{
 const snapshot={id:'11111111-1111-1111-1111-111111111111',items:[{id:'item'}],artifacts:[{id:'artifact',itemId:'item',purpose:'deliverable',version:2,verification:{technical:'passed',semantic:'passed'}}]};const alias='task:'+snapshot.id+':0';assert.deepEqual(resolveTaskReferenceAliases([alias],snapshot),['artifact']);
 snapshot.artifacts.push({...snapshot.artifacts[0],id:'another'});assert.throws(()=>resolveTaskReferenceAliases([alias],snapshot),/唯一/);
 assert.deepEqual(resolveTaskReferenceAliases(['task:22222222-2222-2222-2222-222222222222:0'],snapshot),['task:22222222-2222-2222-2222-222222222222:0']);
});
test('proposal preparation checks executable parameters without asking a model to certify user approval',async()=>{
 const g=goal([{operation:'generate_video',output:'video',spec:{durationSeconds:5,ratio:'9:16'}}]);g.semantic.approval.required=true;
 const f=fixture(g,async()=>reply({concept:'咖啡',preservedConstraints:[],safety:{passed:true,reason:'普通创作'},items:[{prompt:'咖啡',duration:5,ratio:'9:16'}]}));f.runtime.media.config.videoModel='test';let judges=0;
 f.agent.verifier.verifyPlan=async()=>{judges++;throw new Error('用户还没批准');};await f.agent.run(f.s,'先展示方案',()=>{},signal());assert.equal(judges,0);assert.equal(currentTask(f.s).status,'WAIT_CONFIRM');assert.equal(Object.keys(f.s.taskStore.executions).length,0);assert.equal(Object.values(currentTask(f.s).planChecks)[0].checker.kind,'program');
});
test('media planning syntax repair preserves literal newlines and known JSON-mode metadata',async()=>{
 const x=JSON.parse(await readFile(new URL('./fixtures/media-plan-newlines.json',import.meta.url)));const calls=x.state.modelCalls.filter(c=>c.methodId==='video_creation_skill');
 const raw=calls[0].output.flatMap(o=>o.content||[]).map(p=>p.text||'').join('\n');const parsed=parseStructured(raw,{type:'object',properties:{concept:{},preservedConstraints:{},safety:{},items:{}}});assert.ok(parsed.items[0].prompt.includes('\n'));
 const metadata={type:'json_object',content:'preserved'};normalizeOutputMetadata(metadata,textSchema);assert.deepEqual(metadata,{content:'preserved'});
 const discriminator={type:'json_object',content:'preserved'};normalizeOutputMetadata(discriminator,{type:'object',required:['type','content'],properties:{type:{},content:{}}});assert.equal(discriminator.type,'json_object');
});
test('a creative text deliverable cannot be replaced by its observation prerequisite',async()=>{
 const {validatePlan}=await import('../server/intent.mjs');const d=semantic().deliverables[0];d.form='script';d.requiredEvidence='web';assert.throws(()=>validatePlan({routes:[{deliverableIndex:0,operation:'search_web',skills:[]}]},{deliverables:[d]},catalog),/不能取代/);
});
