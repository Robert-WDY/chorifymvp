import test from 'node:test';
import assert from 'node:assert/strict';
import {understandGoal} from './intake-compat.mjs';
import {semanticSchema} from '../server/intent.mjs';
import {missingFieldPlan,applyMissingFields} from '../server/structured-repair.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {verifyArtifactOnce} from '../server/verification-attempt.mjs';
import {withTrace,tracedBrain} from '../server/trace-context.mjs';
import {usableReferences} from '../server/sources.mjs';
const catalog=await loadCatalog();
const sig=()=>new AbortController().signal;
const reply=v=>[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(v)}]}];
const query='给这个化妆品精油写一个品牌营销的视频脚本，面向巴西市场';
const partial=()=>({summary:query,deliverables:[{description:query,kind:'text',count:1,action:'create',purpose:'marketing',requiredEvidence:'none',references:['product'],dependsOn:[],constraints:['面向巴西市场'],requestEvidence:query}]});
const missing=()=>({gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},facts:[],globalConstraints:[],approval:{required:false,reason:''},continuation:{mode:'new',taskId:''}});
const strictSchema=()=>{const s=structuredClone(semanticSchema);s.required.push('approval','continuation','facts','globalConstraints');return s;};

test('partial script intake only fills missing fields and preserves original source and text scope',async()=>{
 let n=0;const original=partial(),state={currentRunId:'intake'};
 const brain=tracedBrain({respond:async(input)=>{
  n++;if(n===1)return reply(original);
  if(n===2){const p=JSON.parse(input[1].content);assert.deepEqual(p.lockedDraft,original);assert.equal(p.query,query);assert.ok(p.missingPaths.includes('/approval'));assert.ok(!p.missingPaths.includes('/deliverables'));assert.match(input[0].content,/turnOperation/);assert.match(input[0].content,/不能伪造ID/);return reply(missing());}
  if(n===3)return reply({media:{image:0,video:0,audio:0},requiredMethods:[],systemFacts:[],readOnly:false,evidence:query});
  return reply({routes:[{deliverableIndex:0,operation:'marketing_script',skills:[]}]});
 }});
 const g=await withTrace(state,async()=>{},()=>understandGoal(brain,catalog,{query,assets:[{id:'product',type:'image',url:'https://test.invalid/product.png'}],strictControl:true,auditContracts:true},sig()));
 assert.equal(n,2);assert.equal(g.semantic.deliverables.length,1);for(const [key,value] of Object.entries(original.deliverables[0]))assert.deepEqual(g.semantic.deliverables[0][key],value);assert.deepEqual(g.tasks[0].references,['product']);assert.equal(g.tasks[0].output,'text');assert.equal(g.semantic.approval.required,false);assert.equal(g.semantic.continuation.mode,'new');
 assert.ok(state.modelCalls[1].validations.some(v=>v.phase==='fill_missing_fields'&&v.merged));
});

test('missing-field patches cannot replace locked deliverables or introduce unlisted fields',()=>{
 const draft=partial(),plan=missingFieldPlan(draft,strictSchema()),patch=missing();
 for(const path of ['deliverables','summary','/deliverables/0/references','newField'])assert.throws(()=>applyMissingFields(draft,{...patch,[path]:[]},plan),/限定Schema/);
 assert.deepEqual(draft,partial());assert.deepEqual(applyMissingFields(draft,patch,plan),{...draft,...missing()});
});

test('an incorrect scope auditor rechecks itself before rewriting the understood script or source',async()=>{
 let n=0;const s={...partial(),...missing()};
 const g=await understandGoal({respond:async input=>{
  n++;if(n===1)return reply(s);
  if(n===2||n===3){if(n===3)assert.match(input[1].content,/任一方都可能出错/);return reply({media:{image:0,video:n===2?1:0,audio:0},requiredMethods:[],systemFacts:[],textFileCount:null,readOnly:false,evidence:query});}
  return reply({routes:[{deliverableIndex:0,operation:'marketing_script',skills:[]}]});
 }},catalog,{query,assets:[{id:'product',type:'image',url:'https://test.invalid/product.png'}],strictControl:true,auditContracts:true},sig());
 assert.equal(n,1);assert.deepEqual(g.tasks[0].references,['product']);assert.equal(g.tasks[0].output,'text');assert.equal(g.requestContract.media.video,0);
 assert.ok(!g.intakeTrace.some(t=>t.phase==='extract_request_contract'));assert.ok(!g.intakeTrace.some(t=>t.phase==='repair_request_scope'));
});

test('nested fields repair in place and unexpected fields use explicit removal patches',()=>{
 const draft={...partial(),...missing()};delete draft.deliverables[0].requiredEvidence;
 const plan=missingFieldPlan(draft,strictSchema());assert.deepEqual(plan.paths,['/deliverables/0/requiredEvidence']);
 assert.equal(applyMissingFields(draft,{field_0:'none'},plan).deliverables[0].requiredEvidence,'none');
 draft.deliverables[0].kind='bogus';const repair=missingFieldPlan(draft,strictSchema());assert.ok(repair.replacePaths.includes('/deliverables/0/kind'));assert.equal(draft.deliverables.length,1);
 const extra=partial();extra.unexpected=true;assert.deepEqual(missingFieldPlan(extra,strictSchema()).removePaths,['/unexpected']);assert.equal(extra.unexpected,true);
});

test('planned text methods reach the workflow in order instead of truncating the final script method',async()=>{
 let n=0;const methods=['product-understanding-zh-v1','marketing-brief-zh-v1','video-script-zh-v1'];
 const g=await understandGoal({respond:async()=>reply(++n===1?{...partial(),...missing(),requiredMethods:methods}:{routes:[{deliverableIndex:0,operation:'marketing_script',skills:methods}]})},catalog,{query,assets:[{id:'product',type:'image',url:'https://test.invalid/product.png'}]},sig());
 assert.deepEqual(g.tasks[0].requiredMethods,methods);assert.equal(g.tasks.length,1);assert.equal(g.tasks[0].artifactCount,1);
});

test('new task sources reject unaccepted optional artifacts before execution, retaining accepted originals',()=>{
 const source={id:'original',taskId:'old',purpose:'deliverable',type:'image',url:'https://test.invalid/original.png',verification:{technical:'passed',semantic:'passed'}};
 const rejected={...source,id:'rejected',url:'https://test.invalid/rejected.png',verification:{technical:'passed',semantic:'unverified'}};
 const inventory=[source,rejected,{assetId:'upload',type:'image'}];
 assert.deepEqual(usableReferences(['original','upload'],inventory),['original','upload']);
 for(const ref of ['rejected',rejected.url])assert.throws(()=>usableReferences(['original',ref],inventory),e=>e.discardDraft&&e.message.includes('尚未通过验收'));
});

test('failed patch preserves the locked draft without accepting a replacement goal',async()=>{
 let n=0;await assert.rejects(()=>understandGoal({respond:async()=>reply(++n===1?partial():{...partial(),...missing()})},catalog,{query,strictControl:true,auditContracts:true},sig()),e=>{
  assert.match(e.message,/限定Schema/);assert.deepEqual(e.partialSemantic,partial());return true;
 });assert.equal(n,3);
});

const comparison={sourceObserved:true,resultObserved:true,requestedChanges:'passed',preservedRegions:'passed'};
function images(){
 const source={id:'source',type:'image',url:'https://test.invalid/source.png',version:1};
 const item={id:'i',operation:'generate_image',description:'女人拿着参考图里的精油',constraints:['保持同一精油产品'],spec:{},references:['source'],dependsOn:[]};
 const artifact={id:'result',taskId:'t',type:'image',url:'https://test.invalid/result.png',version:1,metadata:{args:{referenceImages:[source.url]}}};
 const state={currentRunId:'r1',taskStore:{activeTaskId:'t',tasks:{t:{id:'t',items:[item]}},artifacts:{source,result:artifact}}};
 return {source,item,artifact,state};
}

test('legacy contradictory verdict becomes uncertain in one call and is traced with the artifact node',async()=>{
 const {item,artifact,state}=images();let calls=0;
 const brain=tracedBrain({respond:async()=>{calls++;return reply({passed:true,uncertain:true,issues:[],comparison});}});
 const v=await withTrace(state,async()=>{},()=>verifyArtifactOnce(new Verifier(brain),item,artifact,state,sig()));
 assert.equal(v.outcome,'uncertain');assert.equal(v.passed,false);assert.equal(v.uncertain,true);assert.ok(v.issues.length);assert.equal(calls,1);
 assert.equal(state.modelCalls[0].nodeId,'i');assert.equal(state.modelCalls[0].methodId,'artifact_verification');
 assert.ok(state.modelCalls[0].validations.some(v=>v.accepted&&v.verdict.outcome==='uncertain'));
});

test('reference generation compares actual submitted images, excluding unrelated dependency products',async()=>{
 const {item,artifact,state,source}=images();item.dependsOn=[0];
 state.taskStore.tasks.t.items=[{id:'dependency'},item];state.taskStore.artifacts.unrelated={id:'unrelated',itemId:'dependency',taskId:'t',type:'image',url:'https://test.invalid/unrelated.png',verification:{technical:'passed',semantic:'passed'}};
 let input;const v=await new Verifier({respond:async i=>{input=i;return reply({outcome:'passed',issues:[],comparison});}}).verifyArtifact(item,artifact,state,sig());
 assert.equal(v.passed,true);assert.deepEqual(input[1].content.filter(p=>p.type==='input_image').map(p=>p.image_url),[source.url,artifact.url]);
 assert.equal(JSON.parse(input[1].content[0].text).comparisonMode,'reference_generation');assert.match(input[0].content,/不要求新人物、场景/);
});

test('a passed outcome without comparison evidence cannot accept referenced generation',async()=>{
 const {item,artifact,state}=images();let calls=0;
 const v=await withTrace(state,async()=>{},()=>verifyArtifactOnce(new Verifier(tracedBrain({respond:async()=>{calls++;return reply({outcome:'passed',issues:[]});}})),item,artifact,state,sig()));
 assert.equal(v.passed,false);assert.equal(v.uncertain,true);assert.equal(v.errorKind,'verdict_format');assert.equal(calls,2);
 assert.equal(state.modelCalls.filter(c=>c.validations.some(v=>v.accepted===false)).length,2);
});

test('verification shares concurrent work and survives same-run reload, but new runs and changed evidence retry',async()=>{
 const {item,artifact,state}=images();let calls=0,release;const gate=new Promise(r=>release=r);
 const verifier={verifyArtifact:async()=>{calls++;await gate;return {passed:false,uncertain:true,issues:['看不清标签']};}};
 const first=verifyArtifactOnce(verifier,item,artifact,state,sig()),second=verifyArtifactOnce(verifier,item,artifact,state,sig());release();await Promise.all([first,second]);assert.equal(calls,1);
 const restored=structuredClone(state),result=restored.taskStore.artifacts.result;
 restored.taskStore.artifacts.extra={id:'extra',type:'image',url:'https://test.invalid/extra.png'};
 await verifyArtifactOnce(verifier,item,result,restored,sig());assert.equal(calls,1);
 restored.taskStore.artifacts.source.version=2;await verifyArtifactOnce(verifier,item,result,restored,sig());assert.equal(calls,2);
 restored.currentRunId='r2';await verifyArtifactOnce(verifier,item,result,restored,sig());assert.equal(calls,3);assert.equal(result.verificationAttempts.length,3);
});

test('transport errors do not cause a second model request within one verification attempt',async()=>{
 const {item,artifact,state}=images();let calls=0;
 const v=await new Verifier({respond:async()=>{calls++;throw new Error('HTTP 503');}}).verifyArtifact(item,artifact,state,sig());
 assert.equal(calls,1);assert.equal(v.errorKind,'observation_error');assert.equal(v.uncertain,true);
});
