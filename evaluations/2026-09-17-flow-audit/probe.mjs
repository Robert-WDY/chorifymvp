// Read-only product audit. All model/provider outputs below are injected offline.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createSession,appendRecord,searchHistory} from '../../server/context-agent/history.mjs';
import {ContextAgent} from '../../server/context-agent/loop.mjs';
import {createTools} from '../../server/context-agent/tools.mjs';
import {measureDelivery,finalDeliveryCheck} from '../../server/context-agent/delivery-check.mjs';
import {buildContext,estimateTokens} from '../../server/context-agent/context.mjs';
import {loadAgentCatalog} from '../../server/context-agent/skills.mjs';

const dir=new URL('./',import.meta.url), findings=[];
const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(name,args,id)=>[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}];
const msg=(state,text,role='user')=>appendRecord(state,{kind:'message',role,content:text});
const ctx=(state,id='c')=>({state,ownerId:state.ownerId,turnId:'turn',callId:id,fromModel:true,save:async()=>{}});
function measured(state,args,id){
 const result={ok:true,...measureDelivery(args,{state,turnId:'turn'})};
 appendRecord(state,{kind:'tool_call',turnId:'turn',callId:id,name:'measure_text',arguments:JSON.stringify(args)});
 appendRecord(state,{kind:'tool_result',turnId:'turn',callId:id,output:JSON.stringify(result)});
 return result;
}
{
 const state=createSession();
 const result=await new ContextAgent({memory:{enabled:false},tools:createTools(),brain:{respond:async()=>say('方案一：白瓶。\n\n方案二：红瓶。')}}).run(state,'只给一个方向，不要备选');
 assert.equal(result.status,'completed');
 findings.push({id:'P1_measurement_omitted',kind:'injected_model_loop',user:'只给一个方向，不要备选',result,explanation:'No declared measure_text receipt means no deterministic delivery gate. This is not proof a live model will omit it.'});
}
{
 const state=createSession();msg(state,'正文40到60字');
 const first=measured(state,{text:'甲'.repeat(80),unit:'characters',requirements:{min:80,max:120}},'mistaken');
 const corrected=measured(state,{text:'甲'.repeat(50),unit:'characters',requirements:{min:40,max:60}},'correction');
 assert.equal(first.deliveryCheck.status,'passed');assert.equal(corrected.deliveryCheck.status,'failed');
 findings.push({id:'P2_wrong_declaration_cannot_correct',kind:'real_validation_functions',first,corrected,final:finalDeliveryCheck(state,'turn','甲'.repeat(50))});
}
{
 const state=createSession();
 measured(state,{text:'标题',unit:'characters',items:['标题'],requirements:{itemCount:1}},'title');
 const body=measured(state,{text:'甲\n\n乙\n\n丙',unit:'characters',items:['甲','乙','丙'],requirements:{itemCount:3}},'directions');
 assert.equal(body.deliveryCheck.status,'failed');
 findings.push({id:'P3_different_deliverables_share_constraints',kind:'real_validation_functions',body,explanation:'One title and three directions measured separately in one turn produce incompatible global itemCounts=[1,3].'});
}
{
 const state=createSession(),tools=createTools();let n=0;
 const draft='桂花落进杯中，午后慢慢舒展。';
 const result=await new ContextAgent({maxSteps:4,memory:{enabled:false},tools,brain:{respond:async()=>{
  n++;if(n===1)return call('measure_text',{text:draft,unit:'characters',requirements:{min:10,max:30}},'measure');
  if(n===2)return call('save_document',{content:draft,title:'午后文案'},'save');
  return say('文稿已保存。');
 }}}).run(state,'写10到30字文案，保存独立文稿，最后告诉我已保存');
 assert.equal(Object.keys(state.assets).length,1);assert.equal(result.status,'budget_exceeded');
 findings.push({id:'P4_saved_asset_vs_final_chat',kind:'injected_model_loop',result,assets:Object.values(state.assets),failures:state.records.filter(r=>r.name==='delivery_check').map(r=>JSON.parse(r.output)),explanation:'Saved work passed measurement; final status sentence is compared with work hash and rejected.'});
}
{
 const state=createSession(),tools=createTools();
 const long=msg(state,'桂花在午后的杯中舒展。花香与茶香慢慢交织，预约规则仍待确认。','assistant');
 const short=msg(state,'桂花入茶，午后慢饮。','assistant');
 msg(state,'保存短版，原来的长版也保留，两个版本可追溯。');
 const result=await tools.execute('save_document',{parentMessageId:short.id,sourceText:short.content,content:short.content,title:'短版'},ctx(state));
 assert.equal(result.ok,true);assert.equal(result.parentEvidence.sourceMessageId,short.id);
 assert.equal(Object.values(state.assets).some(a=>a.sourceMessageId===long.id),false);
 findings.push({id:'P5_consistently_wrong_parent',kind:'real_tool_with_injected_choice',longMessageId:long.id,shortMessageId:short.id,result,explanation:'Exact sourceText guards ID/text agreement, not semantic selection of long vs short original.'});
}
{
 const state=createSession();let providerInput;
 state.assets.facts={id:'facts',type:'text',version:1,content:'实际商品事实：白色软管；容量未知。',ownerId:state.ownerId};
 state.assets.photo={id:'photo',type:'image',version:1,url:'https://fixture.invalid/product.png',ownerId:state.ownerId};
 const tools=createTools({mode:'live',media:{image:async args=>{providerInput=args;return {status:'succeeded',images:[{url:'https://fixture.invalid/result.png'}]};}}});
 const prep=await tools.execute('generate_image',{prompt:'商品广告图',size:'1024x1024',sourceIds:['facts','photo']},ctx(state,'prepare'));
 appendRecord(state,{kind:'run_event',event:'proposal_published',proposalIds:[prep.proposalId]});
 const user=appendRecord(state,{kind:'message',role:'user',content:'批准这份方案',turnId:'turn'});
 const executed=await tools.approveAndExecute({proposalIds:[prep.proposalId]},{...ctx(state,'confirm'),requestId:'request',maxMediaCalls:1,confirmationSource:{kind:'text',messageId:user.id,requestId:'request'}});
 assert.equal(executed.ok,true);assert.deepEqual(providerInput.referenceImages,[]);
 findings.push({id:'P6_lineage_is_not_provider_context',kind:'injected_provider_no_network',prepared:prep.args,actualProviderInput:providerInput,savedSources:Object.values(state.assets).find(a=>a.receiptId)?.sourceIds,explanation:'sourceIds are provenance only. Text must enter prompt; source photos must enter referenceImages/imageId.'});
}

const historic=new URL('../2026-09-17-multiturn-real/',import.meta.url),inventory=[];
{
 const state=createSession();msg(state,'方向二：手的介入。选择后展开成15秒脚本。','assistant');
 const broad=searchHistory(state,{query:'方案 脚本 方向 15秒'}),exact=searchHistory(state,{query:'脚本'});
 assert.equal(broad.totalMatches,0);assert.equal(exact.totalMatches,1);
 findings.push({id:'P9_search_conjunction_not_semantic_retrieval',kind:'real_search_function',broad,exact,explanation:'The extra term 方案 excludes the existing direction. Empty search result does not mean absent source.'});
}
{
 const state=createSession(),tools=createTools();
 const original='原稿'.repeat(2000);state.assets.original={id:'original',type:'text',version:1,content:original,ownerId:state.ownerId};
 let n=0;
 const result=await new ContextAgent({maxSteps:3,memory:{enabled:false},tools,brain:{respond:async()=>!n++?call('save_document',{parentId:'original',sourceText:original,content:original+'。'},'save-long'):say('已保存')}}).run(state,'在这份原稿末尾添加句号并保存新版本');
 assert.equal(Object.keys(state.assets).length,2);assert.equal(result.code,'CONTEXT_BUDGET_EXCEEDED');
 findings.push({id:'P7_full_original_arguments_exceed_next_context',kind:'injected_model_loop',originalCharacters:original.length,savedVersions:Object.values(state.assets).map(a=>({id:a.id,version:a.version,characters:a.content.length})),result,explanation:'Legal full sourceText + revised content arguments are protected whole. The next model input cannot fit even after tool result truncation. Injected model output does not test provider output length limits.'});
}
for(const group of ['primary','diagnostic']){
 for(const entry of await fs.readdir(new URL(group+'/',historic),{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const base=new URL(group+'/'+entry.name+'/',historic);
  let state;try{state=JSON.parse(await fs.readFile(new URL('session.json',base),'utf8'));}catch{continue;}
  const transport=JSON.parse(await fs.readFile(new URL('transport.json',base),'utf8'));
  const rounds=JSON.parse(await fs.readFile(new URL('rounds.json',base),'utf8'));
  const requests=state.records.filter(r=>r.event==='model_request');
  inventory.push({group,caseId:entry.name,turns:rounds.length,transportCalls:transport.length,phases:requests.reduce((m,r)=>(m[r.phase]=(m[r.phase]||0)+1,m),{}),summaryAttempts:state.records.filter(r=>r.event==='summary_attempt').length,summaryFailures:state.records.filter(r=>r.event==='summary_failed').map(r=>({id:r.id,message:r.message})),summaries:Object.keys(state.summaries||{}).length,assets:Object.keys(state.assets).length,proposals:Object.values(state.approvals).filter(a=>a.kind==='proposal').length,tools:state.records.filter(r=>r.kind==='tool_call').map(r=>({id:r.id,name:r.name,arguments:JSON.parse(r.arguments)})),roundResults:rounds.map(r=>({round:r.round,user:r.user,result:r.result?.text,status:r.result?.status,toolCalls:r.result?.toolCalls,skipped:r.skipped}))});
 }
}
const chat=JSON.parse(await fs.readFile(new URL('primary/CHAT_VERSION/session.json',historic),'utf8'));
const wrong=chat.records.find(r=>r.id==='525522bc-89f8-4917-b9db-dcf0377d9183');
const req=chat.records.slice(0,chat.records.indexOf(wrong)).filter(r=>r.event==='model_request'&&r.phase==='agent').at(-1);
const body=JSON.stringify(req.input);
const long=chat.records.find(r=>r.id==='46a959b4-c317-4721-bfd2-b5b5ef088513'),short=chat.records.find(r=>r.id==='e9a24e91-496a-4734-ac3f-0126c38ed37c');
const parentEvidence={requestRecordId:req.id,requestMetrics:req.metrics,longFullBodyPresent:body.includes(JSON.stringify(long.content).slice(1,-1)),shortFullBodyPresent:body.includes(JSON.stringify(short.content).slice(1,-1)),longIdPresent:body.includes(long.id),shortIdPresent:body.includes(short.id),summaryPresent:req.input.some(r=>r.role!=='system'&&JSON.stringify(r.content).includes('sessionSummary')),wrongCall:wrong};
assert.equal(parentEvidence.longFullBodyPresent,true);assert.equal(parentEvidence.shortFullBodyPresent,true);

const catalog=await loadAgentCatalog(),tools=createTools({mode:'live',media:{image:async()=>{throw new Error('No network allowed');}},observeImages:async()=>({text:'offline'})});
const prompt=await fs.readFile(new URL('../../server/context-agent/prompt.md',import.meta.url),'utf8');
const state=createSession();const user=msg(state,'帮我准备一张白瓶白背景广告图，1:1，无文字。');
const current=buildContext(state,{systemPrompt:prompt,skillDirectory:catalog.skills,toolDefinitions:tools.definitions,currentTurnId:user.turnId,tokenBudget:24000,reservedTokens:6500});
const composition={unit:'conservative ceil(UTF8bytes/2)+4 estimate, not vendor tokens',systemCharacters:prompt.length,systemEstimate:estimateTokens(prompt),toolCount:tools.definitions.length,toolsEstimate:estimateTokens(tools.definitions),messages:current.input.map(r=>({role:r.role,characters:JSON.stringify(r.content).length,estimate:estimateTokens(r)})),metrics:current.metrics};
const empty=buildContext(createSession(),{systemPrompt:prompt,skillDirectory:catalog.skills,toolDefinitions:tools.definitions,tokenBudget:24000,reservedTokens:6000,untrimmed:true});
const floor=empty.metrics.estimatedInputTokens+empty.metrics.estimatedToolDefinitionTokens,target=(24000-6000-500)*0.55;
assert.ok(floor>target);
findings.push({id:'P8_summary_target_below_fixed_context_floor',kind:'actual_context_construction_no_model',fixedContextEstimate:floor,targetEstimate:target,triggerEstimate:(24000-6000-500)*0.75,toolCount:tools.definitions.length,explanation:'Even zero history and no summary cannot reach targetRatio. Loop is bounded, but history compression cannot remove the fixed prompt/catalog/tool schemas.'});
await fs.writeFile(new URL('probe-results.json',dir),JSON.stringify({baseline:'724ba940add4fe333a55d10f4e15f862106ba800',modelCalls:0,networkCalls:0,findings,parentEvidence,composition},null,2)+'\n');
await fs.writeFile(new URL('trace-inventory.json',dir),JSON.stringify(inventory,null,2)+'\n');
console.log(JSON.stringify({offlineProbes:findings.map(f=>f.id),parentEvidence,composition,historicalCases:inventory.map(({caseId,turns,transportCalls,phases,summaryAttempts,summaryFailures,summaries,assets,proposals})=>({caseId,turns,transportCalls,phases,summaryAttempts,summaryFailures:summaryFailures.length,summaries,assets,proposals}))},null,2));
