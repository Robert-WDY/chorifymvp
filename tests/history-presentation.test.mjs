import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Agent} from './runtime-model-fixture.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {messageEvidence} from '../server/conversation-query.mjs';
import {ReferenceCatalog} from '../server/reference-catalog.mjs';
import {resolvePresentationReference} from '../server/presentation-reference.mjs';
import {inspectFacts,renderFacts} from '../server/runtime-facts.mjs';
import {understandGoal} from '../server/intent.mjs';
import {businessStateSnapshot} from '../server/trace-state.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures/history-presentation-real.json',import.meta.url),'utf8'));
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=x=>[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(x)}]}];
const raw=targets=>({...structuredClone(fixture.candidate),turnOperation:{kind:'present',presentation:{targets}}});
const fresh=()=>({id:'session',messages:[{messageId:'arbitrary-history-anchor',role:'assistant',content:'原话\n保留全部内容'}],events:[],taskStore:{version:1,activeTaskId:null,tasks:{},artifacts:{},executions:{},inputs:{}}});
const context=s=>({references:new ReferenceCatalog(Object.values(s.taskStore.artifacts),{scope:s.id}),messages:messageEvidence(s),sessionId:s.id});
const image={id:'image',type:'image',version:2,url:'https://test.invalid/image.png',purpose:'deliverable',publication:'current',verification:{semantic:'passed',technical:'passed'}};
async function run(state,value,query='任意用户表述',control={}){
 let calls=0,submissions=0;
 const brain={respond:async()=>{calls++;return reply(value);}},runtime=new ToolRuntime({catalog,brain,media:{config:{},image:async()=>{submissions++;throw Error('unexpected media');}}});
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog}).run(state,query,()=>{},signal(),control);
 return {calls,submissions};
}
test('real rejected draft replays through Agent with one intake and exact prior answer',async()=>{
 const state=fresh();state.id=fixture.provenance.sessionId;state.messages=structuredClone(fixture.messages);
 assert.match(fixture.originalError,/源素材引用ID不存在/);
 assert.throws(()=>context(state).references.bind(fixture.candidate.turnOperation.presentation.targets[0],{purpose:'history'}),/不存在/);
 const {calls,submissions}=await run(state,fixture.candidate,fixture.query);
 assert.equal(calls,1);assert.equal(submissions,0);assert.equal(state.lastTurn.status,'completed');
 assert.equal(state.events.at(-1).text,fixture.messages.at(-1).content);
 assert.equal(Object.keys(state.taskStore.tasks).length,0);assert.equal(Object.keys(state.taskStore.artifacts).length,0);
 assert.equal(state.turns[0].queryReceipt.facts.messages.length,1);
 assert.equal(state.turns[0].queryReceipt.facts.artifacts.length,0);
 if(process.env.CHORIFY_P0_TRACE_DIR){await mkdir(process.env.CHORIFY_P0_TRACE_DIR,{recursive:true});await writeFile(join(process.env.CHORIFY_P0_TRACE_DIR,'history-presentation-replay.json'),JSON.stringify({mode:'saved_real_intake_output_offline_replay',providerCalls:0,mediaSubmissions:0,state},null,2));}
});
test('typed message selection works without keywords or msg prefix and keeps media permission denied',async()=>{
 const state=fresh(),value=raw([{type:'message',messageId:state.messages[0].messageId}]);
 const goal=await understandGoal({respond:async()=>reply(value)},catalog,{query:'Repeat the cited reply',messages:messageEvidence(state),sessionId:state.id},signal());
 assert.equal(goal.tasks[0].output,'text');assert.deepEqual(goal.requestContract.artifactReferences,[]);
 assert.deepEqual(goal.requestContract.messageReferences,['arbitrary-history-anchor']);assert.equal(goal.requestContract.currentPermission.mediaSubmission,'denied');
});
test('mixed message and artifact presentation preserves listed order without new objects',async()=>{
 const state=fresh();state.taskStore.artifacts.image=structuredClone(image);state.assets=[{...image,assetId:'image',kind:'image',source:'用户提供'}];
 const {calls,submissions}=await run(state,raw([{type:'message',messageId:state.messages[0].messageId},{type:'artifact',artifactId:'image',version:2}]));
 assert.equal(calls,1);assert.equal(submissions,0);assert.equal(state.events.at(-1).text,'原话\n保留全部内容\n\n![图片 v2](https://test.invalid/image.png)');
 assert.equal(Object.keys(state.taskStore.artifacts).length,1);
});
test('message target cannot be silently coerced into an artifact',()=>{
 const s=fresh();s.taskStore.artifacts.image=structuredClone(image);
 assert.throws(()=>resolvePresentationReference({type:'message',messageId:'image'},context(s)),/历史消息锚点不存在/);
 assert.throws(()=>resolvePresentationReference({type:'artifact',artifactId:s.messages[0].messageId,version:1},context(s)),/不存在/);
});
test('legacy target collision requires explicit type',()=>{
 const s=fresh();s.taskStore.artifacts.collision={...image,id:s.messages[0].messageId};
 assert.throws(()=>resolvePresentationReference(s.messages[0].messageId,context(s)),/同时匹配/);
 assert.equal(resolvePresentationReference({type:'message',messageId:s.messages[0].messageId},context(s)).binding.referenceType,'message');
});
test('deleted or foreign message bindings fail closed at execution',()=>{
 const s=fresh(),id=s.messages[0].messageId,binding=resolvePresentationReference(id,context(s)).binding;
 const other=fresh();other.id='other-session';
 assert.throws(()=>resolvePresentationReference(id,{...context(other),binding}),/不属于当前会话/);
 s.messages=[];assert.throws(()=>resolvePresentationReference({type:'message',messageId:id},{...context(s),binding}),/不存在/);
});
test('message content hash is rechecked after persistence and cannot drift',()=>{
 const s=fresh(),id=s.messages[0].messageId,binding=resolvePresentationReference(id,context(s)).binding;
 const restored=JSON.parse(JSON.stringify(s));assert.equal(resolvePresentationReference(id,{...context(restored),binding}).entry.content,s.messages[0].content);
 restored.messages[0].content='被替换的原文';
 assert.throws(()=>resolvePresentationReference(id,{...context(restored),binding}),/内容已变化/);
});
test('artifact version and content validation remain mandatory for presentation',()=>{
 const s=fresh();s.taskStore.artifacts.image=structuredClone(image);
 assert.throws(()=>resolvePresentationReference({type:'artifact',artifactId:'image',version:1},context(s)),/版本/);
 const binding=resolvePresentationReference('image',context(s)).binding;s.taskStore.artifacts.image.url='https://test.invalid/changed.png';
 assert.throws(()=>resolvePresentationReference('image',{...context(s),binding}),/来源版本或内容/);
});
test('message references never enter the production artifact catalog',()=>{
 const s=fresh(),b=resolvePresentationReference(s.messages[0].messageId,context(s)).binding;
 assert.throws(()=>context(s).references.resolveReference(b.id,{purpose:'production'}),/不存在/);
});
test('unknown message remains failed and does not receive a fabricated answer',async()=>{
 const s=fresh();await run(s,raw([{type:'message',messageId:'missing'}]));
 assert.equal(s.lastTurn.status,'failed');assert.equal(s.turns[0].queryReceipt,undefined);
 assert.equal(Object.keys(s.taskStore.artifacts).length,0);
});
test('new turns persist independent before and after State, failed intake included',async()=>{
 const s=fresh();await run(s,raw([s.messages[0].messageId]));
 const t=s.turns[0];assert.equal(t.stateBefore.data.messageCount,1);assert.equal(t.stateAfter.data.messageCount,3);
 assert.equal(t.stateAfter.data.lastTurn.status,'completed');
 await run(s,raw([{type:'message',messageId:'missing'}]));
 assert.equal(s.turns[1].stateAfter.data.lastTurn.status,'failed');
 assert.equal(t.stateAfter.data.messageCount,3);assert.equal(s.turns[1].stateBefore.data.messageCount,3);
});
test('global snapshot excludes recursive traces and is not injected into model context',()=>{
 const s=fresh();s.modelCalls=[{secret:'trace'}];s.turns=[{stateAfter:{}}];
 const snap=businessStateSnapshot(s);s.taskStore.artifacts.new=structuredClone(image);
 assert.deepEqual(snap.data.artifacts,{});assert.equal(snap.data.turns,undefined);assert.equal(snap.data.modelCalls,undefined);assert.equal(snap.data.messages,undefined);
});
