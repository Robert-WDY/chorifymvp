import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadCatalog} from '../server/catalog.mjs';
import {understandGoal} from '../server/intent.mjs';
import {Agent} from '../server/agent-loop.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {resolveMessage} from '../server/conversation-query.mjs';
import {assertQueryTopic} from '../server/query-registry.mjs';
import {composeFinalResponse,responseContext} from '../server/final-response.mjs';
import {renderFinalReply} from '../dist/reply-view.js';
import {Verifier} from '../server/verification.mjs';
const samples=JSON.parse(await readFile(new URL('./fixtures/intake-failures-20260915.json',import.meta.url),'utf8'));
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=value=>[{type:'message',content:[{type:'output_text',text:typeof value==='string'?value:JSON.stringify(value)}]}];
const image={id:'fixture_image',assetId:'fixture_image',type:'image',kind:'image',url:'https://example.com/bottle.png',version:3};
const message={messageId:'fixture_message',role:'assistant',content:'上一轮没有执行图片观察，只读取了文字记录。'};
async function intake(index,extra={},transform=x=>x){
 let calls=0;const sample=samples[index];
 const goal=await understandGoal({respond:async()=>{calls++;assert.equal(calls,1,'no fresh planning during captured replay');return reply(transform(structuredClone(sample.draft)));}},catalog,{query:sample.query,assets:[image],messages:[message],strictControl:true,auditContracts:true,...extra},signal());
 return goal;
}
test('captured image analysis requires observation despite text output and evidence=none',async()=>{
 const goal=await intake(0);
 assert.equal(goal.readOnlyTurn,true);assert.equal(goal.requestContract.newArtifacts,0);
 assert.equal(goal.tasks[0].runtimeQuery.observations.length,1);
 assert.equal(goal.tasks[0].runtimeQuery.observations[0].sourceId,image.id);
 assert.equal(goal.semantic.readSourceBindings[0].version,3);
 assert.equal(goal.intentSnapshot.deliverables.length,1);
});
test('captured message query uses its exact message identity without a redundant position',async()=>{
 const goal=await intake(1);
 assert.equal(goal.readOnlyTurn,true);assert.equal(goal.tasks[0].runtimeQuery.message.content,message.content);
 assert.deepEqual(goal.semantic.readSourceBindings,[]);assert.equal(goal.semantic.readMessageBindings[0].messageId,message.messageId);
});
test('captured script preference without kind is accepted and keeps its skill obligation',async()=>{
 const goal=await intake(2);
 assert.equal(goal.needsClarification,false);assert.equal(goal.tasks.length,1);
 assert.deepEqual(goal.tasks[0].requiredMethods,['video-script-zh-v1']);
 assert.equal(goal.semantic.gaps[0].level,'preference');assert.equal(goal.intentSnapshot.deliverables.length,1);
});
test('explicit optional preference cannot block execution; essential missing input still does',async()=>{
 const optional=await intake(2,{},d=>{d.gaps[0].kind='preference';d.gaps[0].level='blocking';return d;});
 assert.equal(optional.needsClarification,false);
 const required=await intake(2,{},d=>{d.gaps[0]={scope:'global',kind:'user_input',level:'blocking',description:'目标产品存在多个候选，尚未选定',resolution:'请选定目标'};return d;});
 assert.equal(required.needsClarification,true);
});
test('message resolution does not guess missing selectors, mismatch roles or cross sessions',()=>{
 assertQueryTopic('任意问题',{query:{kind:'message',messageId:message.messageId}});
 assert.throws(()=>assertQueryTopic('任意问题',{query:{kind:'message'}}),/不能猜测/);
 assert.throws(()=>resolveMessage([],{messageId:message.messageId}),/本会话/);
 assert.throws(()=>resolveMessage([message],{messageId:message.messageId,speaker:'user'}),/不一致/);
 assert.equal(resolveMessage([message],{messageId:message.messageId}).content,message.content);
});
async function runAnalysis(fail=false){
 const state={id:'readonly-observation',messages:[],assets:[image],events:[]};let observations=0,submissions=0,finalContext;
 const brain={respond:async(input,tools,_signal,options)=>{
  assert.equal(tools.length,0);
  if(options?.tracePhase==='understand')return reply(samples[0].draft);
  if(options?.tracePhase==='observe_image'){
   observations++;assert.ok(input[1].content.some(p=>p.type==='input_image'&&p.image_url===image.url));
   if(fail)throw Error('fixture vision endpoint unavailable');return reply('画面为深绿色瓶身和浅蓝背景。');
  }
  assert.equal(options.tracePhase,'final_response');finalContext=JSON.parse(input[1].content);
  return reply(fail?'图片读取未成功，可稍后重新读取。':'画面为深绿色瓶身和浅蓝背景，可以加强轮廓光。');
 }};
 const runtime=new ToolRuntime({brain,catalog,media:{config:{},image:async()=>{submissions++;throw Error('unauthorized media generation');}}});
 await new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog}).run(state,samples[0].query,()=>{},signal());
 return {state,observations,submissions,finalContext};
}
test('readonly analysis executes typed image input, records receipt and creates no task/artifact',async()=>{
 const {state,observations,submissions,finalContext}=await runAnalysis();
 assert.equal(observations,1);assert.equal(submissions,0);assert.equal(state.events.at(-1).status,'completed');
 assert.equal(Object.keys(state.taskStore.tasks).length,0);assert.equal(Object.keys(state.taskStore.artifacts).length,0);
 const call=Object.values(state.taskStore.toolCalls).find(c=>c.name==='analyze_image');assert.ok(call);assert.equal(call.taskId,null);assert.equal(call.status,'completed');
 assert.equal(finalContext.facts.observations[0].status,'observed');assert.equal(finalContext.selectedSources[0].version,3);
 assert.equal(finalContext.facts.sources,undefined);assert.deepEqual(finalContext.state.selectedTasks,[]);
});
test('observation provider failure yields a readable answer and failed receipt without resubmission',async()=>{
 const {state,observations,submissions,finalContext}=await runAnalysis(true);
 assert.equal(observations,1);assert.equal(submissions,0);assert.equal(state.events.at(-1).status,'blocked');
 assert.match(state.events.at(-1).text,/图片读取未成功/);assert.equal(finalContext.facts.observations[0].status,'unavailable');
 assert.equal(state.turns.at(-1).responseReceipt.status,'composed');assert.equal(state.turns.at(-1).queryReceipt.checks.completionAllowed,false);
});
test('presentation and history do not acquire visual observation just because images exist',async()=>{
 const history=await intake(1);assert.deepEqual(history.tasks[0].runtimeQuery.observations,[]);
 const present=await intake(0,{},d=>({...d,turnOperation:{kind:'present',presentation:{targets:[{type:'artifact',artifactId:image.id,version:3}]}},deliverables:[]}));
 assert.deepEqual(present.tasks[0].runtimeQuery.observations,[]);assert.equal(present.requestContract.currentPermission.mediaSubmission,'denied');
});
test('failure composer gets exact failed contract and optional gaps, without appending technical error',async()=>{
 const turn={rawInput:samples[2].query,failureReceipt:{origin:'system_intake',message:'fixture schema failure',partialIntent:samples[2].draft,accepted:false,executed:false}};
 const state={messages:[]},before=JSON.stringify(state);let context;
 const text=await composeFinalResponse({respond:async(input,tools)=>{assert.deepEqual(tools,[]);context=JSON.parse(input[1].content);assert.match(input[0].content,/普通解释不列required/);return reply('请求已收到，系统整理时遇到错误，尚未生成脚本。');}},state,turn,{status:'failed',artifacts:[],text:'fixture schema failure'},signal());
 assert.equal(context,undefined);assert.equal(turn.failureReceipt.partialIntent.gaps[0].level,'preference');assert.equal(turn.responseReceipt.source,'saved_artifact_projection');
 assert.doesNotMatch(text,/fixture schema failure/);assert.equal(JSON.stringify(state),before);
});
test('delivery acceptance is exposed separately from quality and missing content still fails',async()=>{
 const context=responseContext({messages:[]},{rawInput:'生成图片'},{artifacts:[{id:'a',type:'image',acceptance:{delivery:{passed:true},quality:{status:'not_evaluated'}}}]});
 assert.equal(context.acceptance[0].qualityStatus,'not_evaluated');
 const verifier=new Verifier({respond:async()=>{throw Error('no quality model call allowed');}},{policy:'delivery_only'});
 assert.equal((await verifier.verifyText({constraints:['style unspecified']},'正文',{},signal())).passed,true);
 assert.equal((await verifier.verifyText({},'',{},signal())).passed,false);
});
test('final answer rendering stays a normal bubble for failed, blocked and completed histories',()=>{
 const previous=globalThis.document;
 const element=()=>({children:[],className:'',append(...nodes){this.children.push(...nodes);},prepend(node){this.children.unshift(node);},replaceChildren(){this.children=[];}});
 globalThis.document={createTextNode:text=>({textContent:text}),createElement:element};
 try{for(const status of ['failed','blocked','needs_input','waiting','completed']){
  const node=element();node.className='notice';renderFinalReply(node,'正常回答\\n下一行',status);
  assert.equal(node.className,'bubble assistant');assert.ok(node.children.some(n=>n.textContent==='正常回答\n下一行'));
  assert.equal(node.children.some(n=>n.className==='reply-status'),status!=='completed');
 }}finally{globalThis.document=previous;}
});
