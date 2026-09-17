// Offline protocol/storage proofs. Scripted decisions are NOT model-semantic evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSession,appendRecord,HistoryStore,currentSummary,readHistory,searchHistory,baselineSnapshot} from '../server/context-agent/history.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {buildContext,estimateTokens} from '../server/context-agent/context.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {createContextServer} from '../server/context-agent/http.mjs';
import {assembleAgentTools,assembleMemoryOptions} from '../server/context-agent/runtime.mjs';
import {resultView} from '../server/context-agent/result-view.mjs';
import {DeepSeek} from '../server/adapters.mjs';
import {displayedProposals,proposalDisplay} from '../server/context-agent/confirmation.mjs';

const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(id,name,args)=>({type:'function_call',call_id:id,name,arguments:JSON.stringify(args)});
const data=input=>JSON.parse(input.filter(x=>x.type==='function_call_output').at(-1).output);
const message=(state,content,role='user',extra={})=>appendRecord(state,{kind:'message',role,content,...extra});
async function evidence(name,value){if(process.env.CHORIFY_CONTEXT_UNIFIED_EVIDENCE_DIR){await mkdir(process.env.CHORIFY_CONTEXT_UNIFIED_EVIDENCE_DIR,{recursive:true});await writeFile(join(process.env.CHORIFY_CONTEXT_UNIFIED_EVIDENCE_DIR,name+'.json'),JSON.stringify({verification:'offline scripted model; mock provider; no real model/media',...value},null,2)+'\n');}}
const context=(state,extra={})=>({state,ownerId:state.ownerId,save:async()=>{},turnId:'prepare',callId:'p',signal:new AbortController().signal,maxMediaCalls:4,...extra});
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'chorify-unified-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new HistoryStore(directory),state=await store.create('offline');
  return {directory,store,state,save:()=>store.save(state,'offline')};
}
async function proposals(tools,state,count=2,save=async()=>{}){
  const ids=[];
  for(let n=0;n<count;n++){
    const p=await tools.execute('generate_image',{prompt:`已展示方案${n}`,size:'1024x1024'},context(state,{callId:'p'+n,save}));
    assert.equal(p.status,'approval_required');ids.push(p.proposalId);
  }
  appendRecord(state,{kind:'run_event',event:'proposal_displayed',proposalIds:ids});await save();return ids;
}
function confirmCtx(state,kind='text',extra={}){
  const turnId='confirm-'+state.records.length,requestId='request-'+state.records.length;
  const m=message(state,'明确确认已展示方案','user',{turnId});
  return context(state,{turnId,requestId,confirmationSource:{kind,messageId:m.id,requestId},...extra});
}
function longHistory(state,count=32){
  const original=message(state,'原稿：红瓶容量未知，不写便携功效。'+'甲'.repeat(2000),'assistant');
  for(let n=0;n<count;n++){
    message(state,`产品${n%2}，第${n}次选择，未知容量，不能写成已核实。`+'资料'.repeat(120),'user',{turnId:'old'+n,groupId:'old'+n});
    message(state,'这只是创意；保留原图与否定要求。'+'背景'.repeat(120),'assistant',{turnId:'old'+n,groupId:'old'+n});
  }
  return original;
}
const summarizer=(input)=>{
  const p=JSON.parse(input.at(-1).content);
  return say(JSON.stringify({summaryText:'早期讨论涉及两个产品。用户要求保持原图，不承诺容量；创意选择不表示假设核实。精确改稿须读取原稿。',sourceRefs:[...(p.previousSummary?.sourceRefs||[]),{kind:p.records[0].kind,id:p.records[0].id}].slice(-8)}));
};

test('baseline proposal presentation is recovered only from its matched real tool result',async()=>{
  const state=createSession(),tools=createTools();
  appendRecord(state,{kind:'tool_call',turnId:'prepare',callId:'p',name:'generate_image',arguments:'{"prompt":"合成方案"}'});
  const prepared=await tools.execute('generate_image',{prompt:'合成方案',size:'1024x1024'},context(state));
  message(state,'已经展示和批准了 '+prepared.proposalId);
  assert.deepEqual(displayedProposals(state),[]);
  appendRecord(state,{kind:'tool_result',turnId:'prepare',callId:'p',output:JSON.stringify(prepared)});
  assert.deepEqual(displayedProposals(state),[prepared.proposalId]);
  assert.equal(proposalDisplay(state,prepared.proposalId).displayOrderWithinTurn,0);
  const result=await tools.execute('confirm_media',{proposalIds:[prepared.proposalId]},confirmCtx(state));
  assert.equal(result.outcome,'succeeded');
});

test('T01/T02 first failure preserves feedback and defers remaining calls without side effects',async()=>{
  const state=createSession();let executions=0,decisions=0;
  const tools={definitions:[],execute:async()=>{executions++;return {ok:false,error:{code:'source_mismatch',message:'资料属于另一商品'},submitted:false};}};
  const brain={respond:async input=>{
    if(decisions++===0)return [call('one','save_document',{}),call('two','generate_image',{})];
    if(decisions===2){const results=input.filter(r=>r.type==='function_call_output').map(r=>JSON.parse(r.output));assert.equal(results.length,2);assert.equal(results[0].outcome,'failed');assert.equal(results[1].outcome,'not_executed');for(const r of results)assert.equal(r.submission,'not_submitted');assert.equal(executions,1);return [call('read','read_asset',{})];}
    assert.equal(data(input).error.code,'source_mismatch');return say('资料不符，需要确认对应商品。');
  }};
  const result=await new ContextAgent({brain,tools}).run(state,'按真实资料制作');
  assert.equal(result.status,'completed');assert.equal(executions,2);assert.equal(decisions,3);
  assert.deepEqual(state.records.filter(r=>r.kind==='tool_call').map(r=>r.callId),state.records.filter(r=>r.kind==='tool_result').map(r=>r.callId));
});

test('T01 outcome projection preserves receipt, critical error, source and simulation under truncation',()=>{
  const raw={ok:false,status:'unknown',submitted:'unknown',receiptId:'receipt-real',proposalId:'proposal-real',simulated:false,error:{code:'timeout',message:'提交结果未知'},assets:[{id:'img',type:'image',version:2,parentId:'original'}],long:'原文'.repeat(5000)};
  const r={kind:'tool_result',id:'record-real',callId:'actual-call',output:JSON.stringify(raw)};
  const p=resultView(r,{tool:'edit_image',maxDataChars:40});
  assert.equal(p.outcome,'unknown');assert.equal(p.receiptId,'receipt-real');assert.equal(p.submission,'unknown');assert.equal(p.rawResultRef.id,'record-real');assert.equal(p.resultRefs[0].parentId,'original');assert.equal(p.error.code,'timeout');assert.equal(p.simulated,false);assert.equal(p.truncated,true);assert.equal(JSON.parse(r.output).long,raw.long);
});

test('T05/T06/T07 automatic pre-trim summary is bounded, persisted and retains exact early originals after restart',async t=>{
  const f=await fixture(t),original=longHistory(f.state);let summaries=0;
  const brain={respond:async(input,tools)=>{
    if(!tools.length&&input[0].content.includes('压缩较早')){summaries++;return summarizer(input);}
    assert.match(JSON.stringify(input),/sessionSummary/);assert.match(JSON.stringify(input),/最新纠正/);return say('保留最新纠正，容量仍未知。');
  }};
  const result=await new ContextAgent({brain,tools:createTools(),save:f.save}).run(f.state,'最新纠正：只选第一方向，第二个作废；容量仍未知');
  assert.equal(result.status,'completed');assert.ok(summaries>0&&summaries<=2);assert.equal(result.modelAccounting.summary.calls,summaries);
  const summary=currentSummary(f.state);assert.ok(summary);assert.ok(summary.coveredToSeq<f.state.records.length-1);assert.equal(summary.coveredFromSeq>=0,true);
  const restored=await new HistoryStore(f.directory).load(f.state.id,'offline');assert.deepEqual(currentSummary(restored),summary);
  let text='',offset=0;do{const p=readHistory(restored,{messageId:original.id,offset,limit:90});text+=p.records[0].content;offset=p.pagination.nextOffset;}while(offset!==null);
  assert.equal(text,original.content);
  const exported=await f.store.exportSession(f.state.id,'offline');assert.equal(exported.records.find(r=>r.id===original.id).content,original.content);assert.deepEqual(exported.summaries,restored.summaries);
  const attempts=f.state.records.filter(r=>r.event==='summary_attempt');assert.equal(new Set(attempts.map(r=>r.sourceHash)).size,attempts.length);
  await evidence('summary-restart',{result,state:exported});
});

test('T05 short conversation and reserved model quota never pay for summary',async()=>{
  for(const long of [false,true]){
    const state=createSession();if(long)longHistory(state);
    let calls=0;
    const result=await new ContextAgent({maxModelCalls:1,brain:{respond:async()=>{calls++;return say('原稿不足时按需回读。');}},tools:createTools()}).run(state,'你好');
    assert.equal(result.status,'completed');assert.equal(calls,1);assert.equal(result.modelAccounting.summary.calls,0);assert.equal(currentSummary(state),null);
  }
});

for(const fault of ['invalid_reference','timeout','oversize','save'])test(`T08 summary ${fault} preserves all originals and does not advance coverage`,async()=>{
  const state=createSession();longHistory(state);const originals=JSON.stringify(state.records);let failed=false;
  const brain={respond:async input=>{
    if(input[0].content.includes('压缩较早')){
      if(fault==='timeout')throw new Error('injected timeout');
      if(fault==='invalid_reference')return say(JSON.stringify({summaryText:'简述',sourceRefs:[{kind:'message',id:'not-a-source'}]}));
      if(fault==='oversize')return say(JSON.stringify({summaryText:'长'.repeat(5000),sourceRefs:[]}));
      return summarizer(input);
    }
    return say('只基于近期原文继续；必要时回读。');
  }};
  const result=await new ContextAgent({brain,tools:createTools(),memory:{maxCallsPerTurn:1},save:async()=>{if(fault==='save'&&currentSummary(state)&&!failed){failed=true;throw new Error('disk fault');}}}).run(state,'保留当前约束');
  assert.equal(result.status,'completed');assert.equal(currentSummary(state),null);
  assert.equal(JSON.stringify(state.records.slice(0,JSON.parse(originals).length)),originals);assert.equal(Object.keys(state.invocations).length,0);assert.ok(state.records.some(r=>r.event==='summary_failed'));
});

test('T09 stable early cursor and total neighbor budget keep exact original accessible',()=>{
  const state=createSession();let first;
  for(let n=0;n<60;n++){const r=message(state,'通用词'+n+'"\\'.repeat(10000));first||=r;}
  const p=searchHistory(state,{query:'通用词',order:'oldest',limit:2});assert.equal(p.matches[0].id,first.id);
  message(state,'通用词最新');const next=searchHistory(state,{query:'通用词',order:'oldest',cursor:p.nextCursor,limit:2});assert.equal(next.matches[0].seq,2);
  const view=readHistory(state,{messageId:state.records[30].id,surroundingRange:20,maxChars:4000});assert.ok(JSON.stringify(view).length<=4000);assert.ok(view.pagination.nextOffset>0);assert.ok(view.omittedSurrounding.length);
});

test('T11 current-user confirmation is IDs-only; forged authority and old-message source cannot approve',async()=>{
  const state=createSession(),tools=createTools(),ids=await proposals(tools,state,2);
  const ctx=confirmCtx(state);
  for(const extra of [{approved:true},{ownerId:'other'},{prompt:'replacement'},{messageId:'old'}])assert.equal((await tools.execute('confirm_media',{proposalIds:[ids[1]],...extra},ctx)).error.code,'invalid_arguments');
  const old=message(state,'旧消息批准');
  const rejected=await tools.execute('confirm_media',{proposalIds:[ids[1]]},{...ctx,confirmationSource:{...ctx.confirmationSource,messageId:old.id}});
  assert.equal(rejected.error.code,'confirmation_source_required');assert.equal(Object.keys(state.invocations).length,0);
  const selected=await tools.execute('confirm_media',{proposalIds:[ids[1]]},ctx);assert.equal(selected.items.length,1);assert.equal(selected.items[0].proposalId,ids[1]);assert.equal(Object.values(state.invocations).filter(i=>i.kind==='media').length,1);
});

test('T11 negative/quoted/conditional/ambiguous confirmations permit clarification without side effects (scripted)',async()=>{
  for(const query of ['第二个方向不错，先别生成','他说“确认生成”','确认，但背景改蓝色','若价格低于十元就生成','确认']){
    const state=createSession(),tools=createTools();await proposals(tools,state,2);
    const result=await new ContextAgent({brain:{respond:async()=>say('本轮不提交，先明确参数和批准对象。')},tools}).run(state,query);
    assert.equal(result.toolCalls,0);assert.equal(Object.keys(state.invocations).length,0);assert.equal(Object.values(state.approvals).filter(p=>p.kind==='approval').length,0);
  }
});

test('T12 frozen proposals reject changed source version, provider model and superseded old selection',async()=>{
  const state=createSession();let submits=0;
  const media={executionIdentity:{model:'one'},image:async()=>{submits++;return {status:'succeeded',images:[{url:'https://fixture.test/new.png'}]};}};
  const tools=createTools({mode:'live',media});state.assets.original={id:'original',type:'image',version:1,url:'https://fixture.test/product.png'};
  const p=await tools.execute('generate_image',{prompt:'保持原商品',size:'2K',referenceImages:['original']},context(state));appendRecord(state,{kind:'run_event',event:'proposal_displayed',proposalIds:[p.proposalId]});
  const ctx=confirmCtx(state);state.assets.original={...state.assets.original,version:2};
  assert.equal((await tools.execute('confirm_media',{proposalIds:[p.proposalId]},ctx)).error.code,'approval_parameters_changed');
  state.assets.original={...state.assets.original,version:1};
  const changed=createTools({mode:'live',media:{...media,executionIdentity:{model:'two'}}});assert.equal((await changed.execute('confirm_media',{proposalIds:[p.proposalId]},ctx)).error.code,'approval_parameters_changed');
  const replacement=await tools.execute('generate_image',{prompt:'新的蓝背景',size:'2K',referenceImages:['original'],replacesProposalId:p.proposalId},context(state,{callId:'new'}));assert.equal(replacement.status,'approval_required');
  assert.equal((await tools.execute('confirm_media',{proposalIds:[p.proposalId]},ctx)).error.code,'proposal_withdrawn');assert.equal(submits,0);
});

for(const status of ['failed','unknown','cancelled','budget'])test(`T13/T14 batch ${status} stops unsubmitted members and repeated channels do not resubmit`,async t=>{
  const f=await fixture(t);let count=0;const controller=new AbortController();
  const tools=createTools({mode:'live',media:{image:async()=>{count++;if(status==='unknown')throw new Error('connection lost');if(status==='failed')return {status:'failed'};if(status==='cancelled')controller.abort();return {status:'succeeded',images:[{url:'https://fixture.test/actual.png'}]};}}});
  const ids=await proposals(tools,f.state,2,f.save),ctx=confirmCtx(f.state,'button',{save:f.save,signal:controller.signal,maxMediaCalls:status==='budget'?1:4});
  const result=await tools.approveAndExecute({proposalIds:ids},ctx);
  assert.equal(count,1);assert.equal(result.items[0].outcome,status==='unknown'?'unknown':status==='failed'?'failed':'succeeded');
  assert.ok(['not_executed','cancelled','failed'].includes(result.items[1].outcome));assert.equal(result.items[1].submission,'not_submitted');
  const restored=await f.store.load(f.state.id,'offline');
  const again=await tools.approveAndExecute({proposalIds:[ids[0]]},confirmCtx(restored,'text',{save:()=>f.store.save(restored,'offline')}));
  assert.equal(count,1);assert.equal(again.items[0].receiptId,result.items[0].receiptId);
});

test('T15/T16/T18 related hints do not consume materials; explicit comparison and frozen product image reach actual mock requests',async()=>{
  const state=createSession();state.assets.original={id:'original',type:'image',url:'https://fixture.test/original.png',version:1};state.assets.result={id:'result',type:'image',url:'https://fixture.test/result.png',version:2,parentId:'original',sourceIds:['facts']};state.assets.facts={id:'facts',type:'text',version:1,content:'容量未知'};
  const observations=[],requests=[];
  const tools=createTools({mode:'live',observeImages:async input=>{observations.push(input);return {text:'结果图颜色变化，主体保持未通过。'};},media:{image:async input=>{requests.push(input);return {status:'succeeded',images:[{url:'https://fixture.test/new.png'}]};}}});
  const c=context(state);const read=await tools.execute('read_asset',{id:'result'},c);assert.equal(read.relatedAvailable.length,2);assert.ok(read.relatedAvailable.every(r=>r.read===false));assert.ok(!JSON.stringify(read).includes('容量未知'));
  await tools.execute('analyze_image',{imageIds:['result'],question:'读图'},c);assert.deepEqual(observations[0].images.map(i=>i.id),['result']);assert.deepEqual(observations[0].materials,[]);
  const compared=await tools.execute('compare_images',{sourceImageId:'original',resultImageId:'result',question:'保持吗'},c);assert.deepEqual(observations[1].images.map(i=>i.id),['original','result']);assert.match(compared.observation.text,/未通过/);
  const missing=await tools.execute('compare_images',{sourceImageId:'missing',resultImageId:'result',question:'保持吗'},c);assert.equal(missing.error.code,'asset_not_found');assert.equal(observations.length,2);
  const p=await tools.execute('generate_image',{prompt:'根据卖点制作但保持原商品',size:'2K',referenceImages:['original'],sourceIds:['facts']},c);
  appendRecord(state,{kind:'run_event',event:'proposal_displayed',proposalIds:[p.proposalId]});
  const result=await tools.approveAndExecute({proposalIds:[p.proposalId]},confirmCtx(state));assert.equal(result.items[0].outcome,'succeeded');assert.deepEqual(requests[0].referenceImages,['https://fixture.test/original.png']);
});

test('T10/T19 button submits before any Agent call; reply failure still exposes durable assets and observations',async t=>{
  const f=await fixture(t),timeline=[];
  const tools=createTools({mode:'live',media:{image:async()=>{timeline.push('provider');return {status:'succeeded',images:[{url:'https://fixture.test/actual.png'}]};}}});
  const ids=await proposals(tools,f.state,1,f.save);
  let fail=true;
  const brain={respond:async input=>{timeline.push('agent');assert.match(JSON.stringify(input),/system_observation/);if(fail)throw new Error('reply failure');return say('已查询到先前真实文件，无需再提交。');}};
  const app=createContextServer({brain,tools,store:f.store,ownerId:'offline',modelEnabled:true,agentOptions:{maxMediaCalls:2}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const base='http://127.0.0.1:'+app.server.address().port,config=await(await fetch(base+'/api/config')).json();
  const send=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','x-context-token':config.csrf},body:JSON.stringify({sessionId:f.state.id,...body})}).then(r=>r.text());
  const response=await send('/api/approve',{proposalIds:ids,requestId:'button-one'});assert.match(response,/system_observation/);assert.match(response,/reply failure/);assert.deepEqual(timeline,['provider','agent']);
  const visible=await(await fetch(base+'/api/session/'+f.state.id)).json();assert.equal(visible.assets.length,1);assert.equal(visible.observations.length,1);assert.equal(visible.observations[0].callId,undefined);
  fail=false;await send('/api/chat',{message:'刚才的结果在哪',requestId:'recover'});assert.deepEqual(timeline,['provider','agent','agent']);
  const recovered=await f.store.exportSession(f.state.id,'offline');assert.equal(recovered.records.filter(r=>r.kind==='system_observation').length,1);
  assert.equal(recovered.records.filter(r=>r.kind==='tool_call').length,0,'button must not invent a model function call');
  const baseline=baselineSnapshot(recovered);assert.equal(baseline.summaries,undefined);assert.deepEqual(baseline.assets,recovered.assets);assert.deepEqual(baseline.approvals,recovered.approvals);assert.deepEqual(baseline.invocations,recovered.invocations);
  assert.equal(baseline.records.find(r=>r.event==='system_observation_compat').output,recovered.records.find(r=>r.kind==='system_observation').output);
  await evidence('button-reply-failure',{timeline,state:recovered,baseline});
});

test('T20 same budget meters summary, vision and main model; provider call policy only uses declared capability',async()=>{
  const state=createSession();longHistory(state,18);state.assets.img={id:'img',type:'image',version:1,url:'https://fixture.test/image.png'};
  const brain={respond:async(input,tools)=>{
    if(input[0].content.includes('压缩较早'))return summarizer(input);
    if(input[0].content.startsWith('只观察'))return say('白色瓶身，容量未知');
    if(input.some(x=>x.type==='function_call_output'))return say('观察完成，容量仍未知');
    return [call('vision','analyze_image',{imageIds:['img'],question:'外观'})];
  }};
  const tools=assembleAgentTools({visionEnabled:true,visionBrain:brain});
  const result=await new ContextAgent({brain,tools,maxModelCalls:4,memory:{...assembleMemoryOptions(),maxCallsPerTurn:1}}).run(state,'看图');
  assert.ok(result.modelCalls<=4);assert.equal(result.modelCalls,Object.values(result.modelAccounting).reduce((sum,p)=>sum+p.calls,0));assert.equal(result.modelAccounting.image_observation.calls,1);assert.equal(result.modelAccounting.summary.calls,1);
  await evidence('combined-budget',{result,state});
  for(const supported of [false,true]){
    let wire;
    const adapter=new DeepSeek({key:'offline',model:'offline',baseUrl:'https://fixture.test',supportsParallelToolCalls:supported},async(_u,options)=>{wire=JSON.parse(options.body);return new Response(JSON.stringify({output:say('done')}));});
    await adapter.respond([{role:'user',content:'读资料'}],[{type:'function',name:'read',parameters:{type:'object'}}],new AbortController().signal,{singleToolCall:true});
    assert.equal(wire.parallel_tool_calls,supported?false:undefined);
  }
});

test('T05/T08 summaries preserve interleaved tool groups and respect one summary quota across the whole turn',async()=>{
  const state=createSession();
  message(state,'早期约束','user',{groupId:'old',turnId:'old'});
  appendRecord(state,{kind:'tool_call',callId:'old-vision',name:'analyze_image',arguments:'{}',groupId:'vision',turnId:'old'});
  appendRecord(state,{kind:'run_event',event:'model_request',phase:'image_observation',input:[{role:'user',content:'old trace'}],turnId:'old'});
  appendRecord(state,{kind:'tool_result',callId:'old-vision',output:'{"observation":"容量未知"}',groupId:'vision',turnId:'old'});
  longHistory(state,36);let main=0;
  const result=await new ContextAgent({tools:createTools(),memory:{maxCallsPerTurn:1},brain:{respond:async input=>{
    if(input[0].content.includes('压缩较早')){const source=JSON.parse(input.at(-1).content).records;assert.ok(source.some(r=>r.kind==='tool_call'&&r.callId==='old-vision'));assert.ok(source.some(r=>r.kind==='tool_result'&&r.callId==='old-vision'));return summarizer(input);}
    if(main++===0)return [call('measure','measure_text',{text:'正文',unit:'characters'})];return say('两字正文。');
  }}}).run(state,'继续原需求');
  assert.equal(result.status,'completed');assert.equal(result.modelAccounting.summary.calls,1);assert.equal(result.modelAccounting.agent.calls,2);
  const active=currentSummary(state);assert.ok(active.coveredToSeq>=3);assert.equal(active.coveredFromSeq,0);
});

test('T17 all active methods retain substantive professional concepts, examples and license references',async()=>{
  const {loadAgentCatalog,readAgentSkill}=await import('../server/context-agent/skills.mjs');
  const catalog=await loadAgentCatalog();
  const concepts={
    'actor-realism-v2':['微表情','对白','呼吸'], 'asset-lock-generator-lite-v2':['人物资产','环境锁','产品锁'],
    'creative-cover-copy-v2':['传播主张','证据','CTA'],'creative-prompt-rewrite':['Transformation Arc','Before / After','Prompt Density'],
    'cinematic-shot-designer-zh-v5':['连续性','景别','布局'],'cinematic-style-optimizer-v2':['风格','人物','冲突'],
    'direction-designer-zh-v1':['方向','数量','假设'],'image-prompt-gallery-director-v2':['MIT License','Curated','精确文字'],
    'marketing-brief-zh-v1':['受众','事实','假设'],'product-understanding-zh-v1':['容量','推断','依据'],
    'storyboard-one-shot-zh':['时长','旁白','字幕'],'storyboard-one-shot-zh-v2':['时长','旁白','字幕'],
    'video-decomposition-zh-v1':['时间戳','推断','复刻'],'video-prompt-safety-zh-v1':['合法创意','替代提示词'],
    'video-script-zh-v1':['时长','事实','脚本正文']};
  assert.equal(catalog.skills.length,Object.keys(concepts).length);
  let references=0;
  for(const {slug}of catalog.skills){
    const text=await readFile(new URL(`../server/context-agent/methods/v1/${slug}/method.md`,import.meta.url),'utf8');
    for(const concept of concepts[slug])assert.ok(text.includes(concept),`${slug}: ${concept}`);
    assert.doesNotMatch(text,/当前 item|item\/goal|sourceSelection|selectedDirection|structure\.shots|交付完整可读正文，保存为文稿/);
    const refs=JSON.parse(await readFile(new URL(`../server/context-agent/methods/v1/${slug}/references.json`,import.meta.url),'utf8'));
    for(let i=0;i<refs.length;i++){
      let contents='',offset=0;do{const page=await readAgentSkill(catalog,slug,`${slug}:${i}`,offset);contents+=page.content;offset=page.nextOffset;}while(offset!==null);
      assert.equal(contents,refs[i].content??refs[i].text??'');references++;
    }
  }
  assert.equal(references,95);
});
