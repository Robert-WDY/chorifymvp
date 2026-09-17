// These are scripted model/adapter trajectories. They prove protocol and data
// plumbing, never the semantic skill of a real model or real visual quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
import {estimateTokens} from '../server/context-agent/context.mjs';
import {createTools,approveProposals} from '../server/context-agent/tools.mjs';
import {loadCorpus} from '../evals/context-agent-corpus.mjs';
import {runCaseTurns} from '../evals/context-agent-driver.mjs';

const corpus=await loadCorpus();
const original=id=>corpus.cases.find(c=>c.id===id);
const message=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(name,args,id)=>({type:'function_call',name,arguments:JSON.stringify(args),call_id:id});
const outputs=input=>input.filter(x=>x.type==='function_call_output').map(x=>({callId:x.call_id,...JSON.parse(x.output).data}));
const body=input=>JSON.stringify(input);
const setup=(extra={})=>({state:createSession(),...extra});
const ctx=state=>({state,ownerId:state.ownerId,turnId:'setup',callId:'setup',save:async()=>{},maxMediaCalls:4,signal:new AbortController().signal});
function brainFor(fn){let step=0;return{async respond(input,definitions){return fn(input,step++,definitions);}};}
async function trace(name,state){if(!process.env.CHORIFY_CONTEXT_TRACE_DIR)return;await mkdir(process.env.CHORIFY_CONTEXT_TRACE_DIR,{recursive:true});await writeFile(join(process.env.CHORIFY_CONTEXT_TRACE_DIR,`${name}.json`),JSON.stringify({evidenceKind:'scripted_model_protocol_only',realModel:false,realMedia:false,state},null,2)+'\n');}
const textAsset=(id,content,extra={})=>({id,type:'text',content,title:id,version:1,...extra});
const imageAsset=(id,extra={})=>({id,type:'image',name:id,url:`https://fixtures.example.test/${id}.png`,version:1,...extra});

test('context behavior: all original 23 cases, expected and fixed inputs retain their frozen hashes',()=>{
  assert.equal(corpus.cases.length,23);assert.equal(corpus.manifest.files.length,27);
  assert.equal(original('USER_STYLE_01').conversation[0].user,'我是电商运营，帮我做一个产品广告方向。');
  assert.equal(original('USER_STYLE_06').setup_turns.length,1);
  assert.equal(original('EDIT_001').conversation[1].action.type,'confirm_batch');
});

for(const variation of ['finished','processing','parameter_error'])test(`context behavior scripted: identical query branches on actual ${variation} feedback`,async()=>{
  const {state}=setup();const invoked=[];
  // Deliberately fake, network-free adapter tests the native result-return loop.
  const tools={definitions:['generate_image','read_media_result'].map(name=>({type:'function',name,parameters:{type:'object'}})),async execute(name,args){
    invoked.push({name,args});
    if(name==='read_media_result')return {ok:true,status:'succeeded',assets:[{id:'result',type:'image',simulated:true}]};
    if(variation==='finished')return {ok:true,status:'succeeded',assets:[{id:'result',type:'image',simulated:true}]};
    if(variation==='processing')return {ok:true,status:'running',receiptId:'receipt-test'};
    if(args.size==='999x999')return {ok:false,error:{code:'unsupported_size',message:'Use 1024x1024'},submitted:false};
    return {ok:true,status:'approval_required',submitted:false,proposalId:'revised-parameters'};
  }};
  const brain=brainFor((input,step)=>{
    if(step===0)return[call('generate_image',{prompt:'白色护肤瓶，纯白背景',size:'999x999'},'initial')];
    const feedback=outputs(input).at(-1);assert.ok(feedback,'Tool feedback must appear in the next model request');
    if(feedback.status==='succeeded')return message('模拟协议测试已取得产物记录；未进行真实视觉验收。');
    if(feedback.status==='running')return[call('read_media_result',{receiptId:feedback.receiptId},'query-result')];
    if(feedback.error?.code==='unsupported_size')return[call('generate_image',{prompt:'白色护肤瓶，纯白背景',size:'1024x1024'},'correct-parameters')];
    assert.equal(feedback.status,'approval_required');return message('参数已修正，新的具体方案待批准，尚未提交。');
  });
  const agent=new ContextAgent({brain,tools});const result=await agent.run(state,original('TOOL_001').conversation[0].user);
  assert.equal(result.status,'completed');
  if(variation==='finished')assert.equal(invoked.length,1);
  if(variation==='processing')assert.equal(invoked[1].name,'read_media_result');
  if(variation==='parameter_error')assert.equal(invoked[1].args.size,'1024x1024');
  assert.equal(state.taskStore,undefined);await trace(`feedback-${variation}`,state);
});

test('context behavior scripted: one direction and known facts can be delivered as text without creating media',async()=>{
  const {state}=setup();const tools=createTools();
  state.assets.product=textAsset('product','白色瓶身；容量未知；无医学功效依据。');
  const direction='方向一：留白中的日常。以白色瓶身和简洁留白作为电商详情页主视觉；不添加容量或功效承诺。';
  const brain=brainFor((input,step)=>{
    assert.ok(body(input).includes(original('USER_STYLE_01').conversation[0].user));
    if(step===0)return[call('read_asset',{id:'product'},'product-read')];
    if(step===1){assert.match(outputs(input).at(-1).asset.content,/容量未知/);return[call('save_document',{content:direction,title:'一个电商广告方向',sourceIds:['product']},'direction-save')];}
    assert.equal(outputs(input).at(-1).asset.content,direction);return message(direction);
  });
  const result=await new ContextAgent({brain,tools}).run(state,original('USER_STYLE_01').conversation[0].user);
  assert.equal(result.status,'completed');assert.equal(result.text,direction);
  assert.equal(Object.values(state.assets).filter(a=>a.title==='一个电商广告方向').length,1);
  assert.equal(Object.values(state.invocations).filter(x=>x.kind==='media').length,0);
  assert.equal(Object.keys(state.approvals).length,0);await trace('one-direction-text-only',state);
});

test('context behavior scripted: local edit retains the exact source image and creates a parent version after approval',async()=>{
  const {state}=setup();const tools=createTools();state.assets.cup=imageAsset('cup',{version:3});
  const args={imageId:'cup',instruction:original('EDIT_001').conversation[2].user,size:'1024x1024'};
  const proposal=await tools.execute('edit_image',args,ctx(state));
  assert.equal(proposal.status,'approval_required');
  const approval=await approveProposals(state,{proposalIds:[proposal.proposalId],ownerId:state.ownerId},async()=>{});
  const brain=brainFor((input,step)=>{
    if(step===0)return[call('read_asset',{id:'cup'},'read-cup')];
    if(step===1){assert.equal(outputs(input).at(-1).asset.version,3);return[call('execute_approved',{proposalId:proposal.proposalId,approvalId:approval.approvalId},'edit-cup')];}
    const result=outputs(input).at(-1);assert.equal(result.status,'succeeded');assert.equal(result.assets[0].parentId,'cup');return message('模拟编辑已保存新版本；没有真实画面可供视觉验收。');
  });
  const result=await new ContextAgent({brain,tools,maxMediaCalls:1}).run(state,args.instruction);
  assert.equal(result.status,'completed');const created=Object.values(state.assets).find(a=>a.parentId==='cup');
  assert.equal(created.version,4);assert.ok(created.sourceIds.includes('cup'));assert.equal(created.simulated,true);
  assert.equal(state.assets.cup.version,3);await trace('edit-parent-version',state);
});

test('context behavior scripted: second direction consumes stored original text and product image without regenerating directions',async()=>{
  const {state}=setup();const tools=createTools();const text='1. 晨光与瓶身\n2. 海外旅行中的轻装日常：米白台面，白瓶与旅行手账同框。\n3. 夜色中的陈列';
  state.assets.directions=textAsset('directions',text);state.assets.product=imageAsset('product');
  let proposal;
  const brain=brainFor((input,step)=>{
    if(step===0)return[call('read_asset',{id:'directions'},'read-directions')];
    if(step===1)return[call('read_asset',{id:'product'},'read-image')];
    if(step===2){const results=outputs(input);assert.equal(results.find(x=>x.callId==='read-directions').asset.content,text);assert.equal(results.find(x=>x.callId==='read-image').observed,false);return[call('generate_image',{prompt:'沿用第二方向“海外旅行中的轻装日常”：米白台面，白瓶与旅行手账同框。',size:'1024x1024',referenceImages:['product'],sourceIds:['directions']},'prepare-selected')];}
    proposal=outputs(input).at(-1);assert.equal(proposal.status,'approval_required');return message('已沿用第二方向准备图片方案；等待批准。');
  });
  const result=await new ContextAgent({brain,tools}).run(state,'用第二个方向做一张广告图，产品外观沿用原图，先给我确认。');
  assert.equal(result.status,'completed');assert.deepEqual(proposal.args.referenceImages,['product']);assert.deepEqual(proposal.args.sourceIds,['directions']);
  assert.match(proposal.args.prompt,/海外旅行中的轻装日常/);assert.equal(Object.values(state.invocations).filter(x=>x.kind==='media').length,0);await trace('selected-direction-and-image',state);
});

test('context behavior scripted: observation receives actual image identity plus material and unknown status',async()=>{
  const {state}=setup();state.assets.product=imageAsset('product');state.assets.facts=textAsset('facts','容量未知；功效未经证明；用户提供：白色瓶身。');
  let observed;
  const tools=createTools({observeImages:async input=>{observed=input;return {visible:'白色瓶状主体',unknown:['容量','医学功效'],evidenceKind:'injected_observer_fixture'};}});
  const brain=brainFor((input,step)=>{
    if(step===0)return[call('read_asset',{id:'facts'},'facts-read')];
    if(step===1)return[call('analyze_image',{imageIds:['product'],question:'描述可见外观，勿推断容量与功效',materials:[{sourceId:'facts',content:outputs(input).at(-1).asset.content,status:'user_provided'},{sourceId:'facts',content:'容量和医学功效未知',status:'unknown'},{sourceId:'facts',content:'错误附注：容量500ml，医学功效已证实。',status:'verified'}]},'observe-product')];
    if(step===2){
      const feedback=outputs(input).at(-1);assert.equal(feedback.materials[1].agentAnnotation.status,'unknown');
      for(const material of feedback.materials){assert.equal(material.content,state.assets.facts.content);assert.equal(material.provenance,'stored_original');assert.equal(material.version,1);assert.equal(material.status,undefined);}
      assert.equal(feedback.materials[2].agentAnnotation.status,'verified');assert.match(feedback.materials[2].agentAnnotation.content,/500ml/);assert.doesNotMatch(feedback.materials[2].content,/500ml/);
      return[call('save_document',{content:'以白色瓶身的简洁视觉作为广告表达。容量与医学功效未知，不能作承诺。',sourceIds:['facts','product']},'save-facts')];
    }
    return message(outputs(input).at(-1).asset.content);
  });
  const result=await new ContextAgent({brain,tools}).run(state,original('FACT_001').conversation[0].user);
  assert.equal(result.status,'completed');assert.equal(observed.images[0].id,'product');assert.equal(observed.materials[1].agentAnnotation.status,'unknown');
  assert.equal(observed.materials[2].content,'容量未知；功效未经证明；用户提供：白色瓶身。');assert.equal(observed.materials[2].provenance,'stored_original');assert.equal(observed.materials[2].status,undefined);
  assert.equal(state.assets.facts.content,observed.materials[2].content);assert.match(result.text,/未知/);assert.doesNotMatch(result.text,/500ml/);await trace('facts-and-observation',state);
});

test('context behavior scripted: across unrelated topics and a bounded model view the original version remains retrievable',async()=>{
  const {state}=setup();const tools=createTools();
  const old=appendRecord(state,{kind:'message',role:'assistant',content:'文案v1：山野茶香，留给日常一刻清静。预约要求未知，不得承诺无需预约。'});
  // Keep its original response group larger than the disposable view. Reading
  // the particular original message remains possible without that whole group.
  appendRecord(state,{kind:'message',role:'assistant',groupId:old.groupId,turnId:old.turnId,content:'当时的背景说明。'.repeat(1500)});
  for(let n=0;n<18;n++)appendRecord(state,{kind:'message',role:n%2?'assistant':'user',content:`无关话题${n}：${'周末天气与旅行计划。'.repeat(80)}`});
  let fetched;
  const brain=brainFor((input,step)=>{
    if(step===0){assert.ok(!body(input).includes('山野茶香，留给日常一刻清静。'));return[call('search_history',{query:'文案v1',limit:5},'locate-v1')];}
    if(step===1){const match=outputs(input).at(-1).matches.find(x=>x.messageId===old.id);assert.ok(match);return[call('read_history',{messageId:match.messageId},'fetch-v1')];}
    fetched=outputs(input).at(-1).records.find(r=>r.id===old.id);assert.equal(fetched.content,old.content);return message('已找到文案v1：“山野茶香，留给日常一刻清静。”请说明要修改哪部分；预约要求仍未确认。');
  });
  const budget=estimateTokens(tools.definitions)+6000+2300; // schema + output reserve + the same bounded history window
  const result=await new ContextAgent({brain,tools,systemPrompt:'使用真实工具结果；需要原稿时读取历史。',contextTokenBudget:budget}).run(state,original('USER_STYLE_06').conversation[0].user);
  assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(state.records.find(r=>r.id===old.id).content,old.content);assert.equal(Object.keys(state.assets).length,0);await trace('cross-topic-original-history',state);
});

for(const order of [['a','b'],['b','a']])test(`context behavior scripted: grouped independent reads return both call IDs for order ${order.join(',')}`,async()=>{
  const {state}=setup();const tools=createTools();state.assets.a=textAsset('a','产品事实：白瓶');state.assets.b=textAsset('b','未知信息：容量');
  const brain=brainFor((input,step)=>{
    if(step===0)return order.map(id=>call('read_asset',{id},`read-${id}`));
    const results=outputs(input);assert.equal(results.find(x=>x.callId==='read-a').asset.content,'产品事实：白瓶');assert.equal(results.find(x=>x.callId==='read-b').asset.content,'未知信息：容量');
    return message('已读取白瓶事实和容量未知项。');
  });
  const result=await new ContextAgent({brain,tools}).run(state,'同时读取产品事实与未知项，再总结。');assert.equal(result.status,'completed');
  const calls=state.records.filter(r=>r.kind==='tool_call'),results=state.records.filter(r=>r.kind==='tool_result');assert.equal(calls.length,2);assert.equal(results.length,2);assert.deepEqual(new Set(results.map(r=>r.callId)),new Set(calls.map(r=>r.callId)));
});

test('context behavior scripted: actual wire rejection is visible and model can correct arguments without replacing the user request',async()=>{
  const {state}=setup();const tools=createTools();const query='写一句广告文案，只需要文字。';
  const brain=brainFor((input,step)=>{
    assert.ok(body(input).includes(query));
    if(step===0)return[call('save_document',{content:'清简日常。',businessTask:'forbidden'},'invalid-wire')];
    if(step===1){const feedback=outputs(input).at(-1);assert.equal(feedback.ok,false);assert.equal(feedback.error.code,'invalid_arguments');return[call('save_document',{content:'清简日常。'},'correct-wire')];}
    assert.equal(outputs(input).at(-1).asset.content,'清简日常。');return message('清简日常。');
  });
  const result=await new ContextAgent({brain,tools}).run(state,query);assert.equal(result.status,'completed');assert.equal(Object.keys(state.assets).length,1);assert.equal(Object.keys(state.approvals).length,0);await trace('wire-feedback-correction',state);
});

test('context behavior scripted: original EDIT_001 driver preserves all queries and exposes real approval receipt before submitting',async()=>{
  const {state}=setup();const tools=createTools();const originalCase=original('EDIT_001');let originalImage,firstProposal;
  const brain=brainFor((input,step)=>{
    const results=outputs(input);
    if(step===0)return[call('generate_image',{prompt:'一只咖啡杯广告图',size:'1024x1024'},'first-plan')];
    if(step===1){firstProposal=results.at(-1);assert.equal(firstProposal.status,'approval_required');return message('方案：一只咖啡杯，1024x1024，一张图片；尚未生成，等待批准。');}
    if(step===2){
      const observation=input.filter(x=>typeof x.content==='string'&&x.content.startsWith('Context reference')).map(x=>JSON.parse(x.content.split('\n')[1])).find(x=>x.kind==='system_observation');
      assert.ok(observation);assert.equal(observation.data.items[0].outcome,'succeeded');
      assert.ok(input.some(x=>x.role==='user'&&x.content===originalCase.conversation[1].user));
      originalImage=observation.data.items[0].data.assets[0];assert.equal(originalImage.simulated,true);return message('模拟产物记录已保存，未生成真实图片。');
    }
    if(step===3)return[call('read_asset',{id:originalImage.id},'read-for-edit')];
    if(step===4){assert.equal(results.at(-1).asset.id,originalImage.id);return[call('edit_image',{imageId:originalImage.id,instruction:originalCase.conversation[2].user,size:'1024x1024'},'edit-plan')];}
    assert.equal(results.at(-1).status,'approval_required');return message('编辑方案：把背景改成蓝色，杯子保持不变。新方案等待批准，尚未提交编辑。');
  });
  const agent=new ContextAgent({brain,tools,maxMediaCalls:2});
  const {rounds}=await runCaseTurns({caseData:originalCase,agent,state});
  assert.deepEqual(rounds.map(r=>r.user),originalCase.conversation.map(t=>t.user));
  assert.deepEqual(rounds.map(r=>r.result.status),['completed','completed','completed']);
  assert.deepEqual(state.records.filter(r=>r.kind==='message'&&r.role==='user').map(r=>r.content),originalCase.conversation.map(t=>t.user));
  assert.equal(Object.values(state.invocations).filter(i=>i.kind==='media').length,1,'The unapproved revision must not be silently submitted');
  assert.equal(Object.values(state.approvals).filter(a=>a.kind==='approval').length,1);
  await trace('original-case-driver-approval',state);
});
