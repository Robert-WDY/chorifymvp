import test from 'node:test';import assert from 'node:assert/strict';
import {Verifier} from '../server/verification.mjs';import {factBoundary} from '../server/fact-boundary.mjs';
import {evidenceContext,projectModelInput} from '../server/model-context.mjs';
import {currentTask,taskArtifacts,reconcileTask} from '../server/task-state.mjs';
import {resolveSources} from '../server/sources.mjs';
import {digest,acceptanceRecord} from '../server/document-contract.mjs';
import {fixture,contract,textItem,archived,reply,signal} from './contract-boundary-fixture.mjs';
test('stage3 fact identities survive projection, inheritance, deduplication and source version changes',()=>{
 const state={taskStore:{activeTaskId:'t',tasks:{t:{id:'t',revision:1,contract:{facts:['活动免费']},goal:{semantic:{assumptions:['暂按室内设计草案'],gaps:[{level:'factual',description:'预约条件待确认'}]}}}}}};
 const first=factBoundary(state,{},[]);assert.deepEqual(first.entries.map(e=>e.status),['user_provided','assumption','unknown']);
 const source={id:'a',version:2,type:'text',content:'是否预约待确认。',factBoundary:first,provenance:{origin:'model_artifact'}};
 const second=factBoundary(state,{},[source]);assert.equal(second.entries.length,3);assert.equal(second.entries[2].id,first.entries[2].id);assert.notEqual(second.hash,factBoundary(state,{},[{...source,version:3}]).hash);
 const projected=projectModelInput({sources:[source],evidenceContext:evidenceContext(state,{},[source])});assert.ok(JSON.stringify(projected).includes('预约条件待确认'));assert.ok(JSON.stringify(projected).includes('是否预约待确认'));assert.ok(!second.entries.some(e=>e.status==='verified'));
 assert.equal(projected.sources[0].factBoundary,undefined);assert.equal(projected.sources[0].factBoundaryRef,'/evidenceContext/factBoundary');assert.ok(projected.sources[0].factIdentityIds.every(id=>projected.evidenceContext.factBoundary.entries.some(e=>e.id===id)));assert.equal(source.factBoundary.entries.length,3);
});
for(const id of ['05-ordered-formal','06-ordered-casual'])test('stage3 archived '+id+' actual downstream assertions reach the scoped checker and cannot pass a rejection',async()=>{
 const state=archived(id,'state'),task=state.taskStore.tasks[state.taskStore.activeTaskId],item=task.items[1],a=Object.values(state.taskStore.artifacts).find(a=>a.itemId===item.id&&a.purpose==='deliverable');let calls=0;
 const forbidden=id.startsWith('05')?'没有领读人':'到店即参与';
 const verifier=new Verifier({respond:async input=>{calls++;const p=JSON.parse(input[1].content[0].text);assert.equal(p.content,a.content);assert.ok(p.content.includes(forbidden));assert.ok(p.sources.some(s=>s.content?.includes('确认')||s.content?.includes('核验')));assert.ok(p.boundary.required);return reply({outcome:'failed',issues:[forbidden+' 无依据，来源仍为待确认']});}},{policy:'delivery_only'});
 const v=await verifier.verifyText(item,a.content,state,signal());assert.equal(v.passed,false);assert.equal(calls,1);assert.equal(v.factualAcceptance.inputHash,digest(a.content));assert.equal(v.factualAcceptance.status,'failed');
});
test('stage3 unknown may be omitted or explicitly pending, but a disclaimer cannot cancel a promise (mock semantic judge)',async()=>{
 const state={taskStore:{activeTaskId:'t',tasks:{t:{id:'t',query:'预约方式未知',contract:{facts:[]},goal:{semantic:{gaps:[{level:'factual',description:'预约方式未知'}]}}}},artifacts:{}}};
 const verifier=new Verifier({respond:async input=>{const p=JSON.parse(input[1].content[0].text);assert.ok(input[0].content.includes('免责声明'));assert.ok(p.boundary.entries.some(e=>e.status==='unknown'));return reply(p.content.includes('无需预约')?{outcome:'failed',issues:['无需预约缺依据']}:{outcome:'passed',issues:[]});}},{policy:'delivery_only'});
 for(const [body,passed] of [['欢迎关注周末活动',true],['预约方式待确认',true],['无需预约，到店即可。具体以实际为准。',false]]){const v=await verifier.verifyText({references:[],dependsOn:[]},body,state,signal());assert.equal(v.passed,passed);const a=acceptanceRecord(v,body);assert.equal(a.quality.status,'not_evaluated');assert.equal(a.factualAcceptance.scope,'business_fact_boundary');}
});
test('stage3 no evidence check is reported as uncertain and never as content confirmed wrong',async()=>{
 const state={taskStore:{activeTaskId:'t',tasks:{t:{contract:{facts:['用户提供12元']},goal:{semantic:{}}}},artifacts:{}}};
 const verifier=new Verifier({respond:async()=>{throw Error('offline unavailable');}},{policy:'delivery_only'}),v=await verifier.verifyText({references:[]},'12元',state,signal());
 assert.equal(v.passed,false);assert.equal(v.uncertain,true);assert.equal(v.factualAcceptance.status,'uncertain');assert.match(v.issues[0],/未完成核验/);
});
test('stage3 scoped factual failure repairs only the copy; Brief, identity and bound version survive',async()=>{
 const draft=contract([textItem({description:'Brief',requiredMethods:['marketing-brief-zh-v1']}),textItem({description:'文案',requiredMethods:['creative-cover-copy-v2'],dependsOn:[0],references:['task:0']})],{facts:['周日10点，免费，限15人'],gaps:[{level:'factual',description:'是否预约待确认',resolution:'用户后续提供'}]});let copyCalls=0;const seen=[];
 const f=fixture({draft,generate:p=>{if(p.item.description==='Brief')return {content:'周日10点，免费，限15人。是否预约待确认。',structure:{audience:'来店用户',hook:'周末试饮',brief:'免费试饮，预约条件未知'}};copyCalls++;assert.ok(p.sources[0].content.includes('是否预约待确认'));assert.ok(p.evidenceContext.factBoundary.entries.some(e=>e.status==='unknown'));return {content:copyCalls===1?'到店即参与，具体以实际为准。':'周日10点，免费试饮，限15人。预约方式待确认。',structure:{headline:'试饮',body:'活动文案',cta:''}};},judge:(p,phase)=>{assert.equal(phase,'verify_facts');seen.push(p);return p.content.includes('到店即参与')?{outcome:'failed',issues:['到店即参与将未知预约条件变成承诺']}:{outcome:'passed',issues:[]};}});
 await f.run('先Brief，再基于Brief写文案。活动周日10点，免费，限15人；预约条件不知道。');const task=currentTask(f.state),artifacts=taskArtifacts(f.state);assert.equal(task.status,'COMPLETED');assert.equal(f.calls.filter(c=>c.phase==='text_generation').length,3);assert.equal(copyCalls,2);assert.equal(seen.length,3);
 const brief=artifacts.find(a=>a.itemId===task.items[0].id&&a.purpose==='deliverable'),copies=artifacts.filter(a=>a.itemId===task.items[1].id&&a.purpose==='deliverable');assert.equal(copies.length,2);assert.equal(brief.publication,'current');assert.ok(copies.some(a=>a.publication==='audit'&&a.acceptance.factualAcceptance.status==='failed'));
 const accepted=copies.find(a=>a.publication==='current');assert.equal(accepted.acceptance.factualAcceptance.sourceVersions[0].sourceId,brief.id);assert.equal(accepted.acceptance.factualAcceptance.sourceVersions[0].version,brief.version);assert.equal(accepted.acceptance.factualSupport,'fact_boundary_checked');assert.equal(accepted.acceptance.quality.status,'not_evaluated');
 assert.equal(resolveSources(f.state,task.items[1])[0].factBoundary.entries.find(e=>e.status==='unknown').text,'是否预约待确认');accepted.acceptance.factualAcceptance.boundaryHash='changed';reconcileTask(f.state);assert.notEqual(task.status,'COMPLETED');
});
test('stage3 ordinary text with no factual material does not introduce a review call',async()=>{
 const f=fixture({draft:contract([textItem()])});await f.run('写一句虚构的雨景');assert.equal(currentTask(f.state).status,'COMPLETED');assert.equal(f.calls.filter(c=>c.phase==='verify_facts').length,0);
});
