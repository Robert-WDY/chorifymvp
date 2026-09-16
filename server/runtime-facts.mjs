import {readSkill} from './catalog.mjs';
import {observationQuestion} from './observation-contract.mjs';
import {formatRuntimeFacts} from '../dist/fact-display.js';
import {createHash} from 'node:crypto';
import {tools} from './tool-schemas.mjs';
import {ReferenceCatalog,verifyReferenceBinding} from './reference-catalog.mjs';
import {resolvePresentationReference} from './presentation-reference.mjs';
import {messageEvidence} from './conversation-query.mjs';
import {completionFacts} from './task-requirements.mjs';
import Ajv from 'ajv';
import {validationTrace,withNode} from './trace-context.mjs';
const observationValidators=new Map(['analyze_image','read_video'].map(name=>[name,new Ajv({strict:false}).compile(tools.find(t=>t.name===name).parameters)]));
export const inspectionOperations=new Set(['present','inspect_runtime','inspect_capabilities','inspect_quote','query_task']);
export function capabilitySnapshot(runtime,catalog){
 const config=runtime.capabilities?.()||{};
 const entries=[['generate_image','generate_image'],['edit_image','generate_image'],['generate_video','generate_video']].map(([operation,tool])=>({operation,tool,registered:true,compilable:true,adapterImplemented:true,configured:operation==='generate_video'?config.videoConfigured??null:config.imageConfigured??null,permission:'task_contract',specSupport:operation==='generate_video'?{durationSeconds:{min:2,max:12},defaultDurationSeconds:5}:{defaultSize:'2048x2048'},health:'unknown',quoteAvailable:false,parameters:tools.find(t=>t.name===tool)?.parameters}));
 entries.push({operation:'analyze_image',tool:'analyze_image',registered:true,compilable:true,adapterImplemented:true,configured:!!runtime.brain,permission:'read_only',health:'unknown',quoteAvailable:false});
 const value={modelIdentity:{configuredModel:runtime.brain?.config?.model||null,provider:runtime.brain?.config?.provider||null,underlyingVersion:null},source:'runtime_registry',schemaVersion:1,entries,unsupported:[{operation:'edit_video',compilable:false,reason:'未实现通用视频编辑'}],skills:catalog.skills.map(s=>({slug:s.slug,name:s.name,description:s.description,workflow:s.contract.workflow,version:s.contract.version,operations:s.contract.operations})),quote:{status:'unavailable',source:null,version:null,currency:null,unitPrice:null,total:null,expiresAt:null,canAuthorize:false,reason:'当前部署未配置可核验的报价来源，不能提供实际金额。'}};
 return {...value,version:createHash('sha256').update(JSON.stringify(value)).digest('hex'),observedAt:new Date().toISOString()};
}
export function inspectFacts(executor,item){
 const {state,runtime,catalog}=executor;
 const query=item.runtimeQuery;
 if(query?.type==='presentation'){
  const references=new ReferenceCatalog([...Object.values(state.taskStore.artifacts),...Object.values(state.taskStore.inputs||{}),...(state.assets||[])],{scope:state.id}),messages=messageEvidence(state);
  const entries=(query.targets||[]).map(id=>{
   const binding=query.bindings?.find(b=>b.id===id);
   const target=binding?.referenceType==='message'?{type:'message',messageId:id}:binding?.referenceType==='artifact'?{type:'artifact',artifactId:id,version:binding.version}:id;
   const {entry:a}=resolvePresentationReference(target,{references,messages,sessionId:state.id,binding});
   return {id:a.id,type:a.type,version:a.version,role:a.role,replyTo:a.replyTo,content:a.content,url:a.url,publication:a.publication,verification:a.verification};
  });
  if(!entries.length)throw new Error('展示目标为空');
  return {source:'session_ledger',query,entries,artifacts:entries.filter(a=>a.type!=='message'),messages:entries.filter(a=>a.type==='message')};
 }
 if(query&&['artifact_inventory','task_plan','task_inspect','execution_inspect'].includes(query.type)){
  const store=state.taskStore,ids=query.taskIds||[],selected=Object.values(store.tasks).filter(t=>!t.goal?.readOnlyTurn&&(ids.length?ids.includes(t.id):!t.supersededBy));
  const base={source:'session_ledger',query,version:store.version,observedAt:new Date().toISOString(),completion:selected.map(t=>completionFacts(t,store))};
  if(query.type==='artifact_inventory')return {...base,artifacts:Object.values(store.artifacts).filter(a=>a.purpose==='deliverable'&&!store.tasks[a.taskId]?.goal?.requestContract?.readOnly&&(!ids.length||ids.includes(a.taskId))).map(a=>({id:a.id,title:a.metadata?.structure?.title||store.tasks[a.taskId]?.items.find(i=>i.id===a.itemId)?.description||a.type,type:a.type,taskId:a.taskId,version:a.version,parentId:a.parentId,relationships:a.relationships||[],publication:a.publication||'candidate',verification:a.verification,current:a.publication==='current'}))};
  const tasks=selected.map(t=>({id:t.id,revision:t.revision,status:t.status,reason:t.reason,summary:t.goal?.summary,...(query.type==='task_plan'?{plan:t.plan,approval:t.approval,batches:t.batches||{},proposals:Object.values(store.artifacts).filter(a=>a.taskId===t.id&&a.purpose==='support'&&a.type==='prompt').map(a=>({id:a.id,version:a.version,content:a.content}))}:{})}));
  return {...base,tasks,...(query.type==='execution_inspect'?{executions:Object.values(store.executions).filter(e=>!ids.length||ids.includes(e.taskId))}:{}),...(query.includeQuote?{quote:capabilitySnapshot(runtime,catalog).quote}:{})};
 }
 if(item.operation==='query_task')return {source:'execution_ledger',observedAt:new Date().toISOString(),tasks:Object.values(state.taskStore.tasks).filter(t=>!item.queryTaskIds?.length||item.queryTaskIds.includes(t.id)).map(t=>({id:t.id,revision:t.revision,status:t.status,reason:t.reason,supersededBy:t.supersededBy})),executions:Object.values(state.taskStore.executions).filter(e=>!item.queryTaskIds?.length||item.queryTaskIds.includes(e.taskId)).map(e=>({id:e.id,taskId:e.taskId,status:e.status,providerTaskId:e.providerTaskId,result:e.result}))};
 const snapshot=capabilitySnapshot(runtime,catalog);if(item.runtimeQuery)return selectRuntimeFacts(snapshot,item.runtimeQuery);if(item.operation==='inspect_runtime')return {...snapshot,taskLedger:inspectFacts(executor,{...item,operation:'query_task'})};return item.operation==='inspect_quote'?{source:snapshot.source,version:snapshot.version,quote:snapshot.quote}:snapshot;
}
export async function loadInspection(executor,item,signal){
 const facts=inspectFacts(executor,item);
 if(item.runtimeQuery?.sourceBindings?.length){
  const {state}=executor,store=state.taskStore;
  const catalog=new ReferenceCatalog([...Object.values(store.artifacts),...Object.values(store.inputs||{}),...(state.assets||[])],{scope:state.id});
  facts.sources=item.runtimeQuery.sourceBindings.map(binding=>{
   const {source,entry}=catalog.resolveReference(binding.id,{purpose:'history',binding});
   return {id:entry.id,type:entry.type,version:entry.version,sourceHash:entry.sourceHash,content:source.content,url:source.url,publication:source.publication};
  });
 }
 if(item.runtimeQuery?.messages?.length)facts.messages=item.runtimeQuery.messages;
 if(item.runtimeQuery?.observations?.length){
  facts.observations=[];
  for(const observation of item.runtimeQuery.observations){
   const source=facts.sources?.find(s=>s.id===observation.sourceId&&s.type===observation.kind);
   const turn=executor.state.turns?.find(t=>t.runId===executor.state.currentRunId);
   const evidenceState=turn?{taskStore:{activeTaskId:turn.runId,tasks:{[turn.runId]:{id:turn.inputMessageId||turn.runId,query:turn.rawInput}}}}:{};
   const name=observation.kind==='image'?'analyze_image':'read_video',args={url:source?.url,question:observationQuestion({description:observation.question},facts.sources||[],evidenceState)};
   let result;
   try{
    if(!source||!observationValidators.get(name)(args))throw new Error('观察需要本会话绑定的可读取媒体地址和问题');
    validationTrace({phase:'observation_input',accepted:true,tool:name,sourceId:source.id,version:source.version});
    result=await withNode(undefined,'readonly_observation',()=>executor.runtime.execute(name,args,executor.state,signal));
    if(result?.isError||!result?.text?.trim())throw new Error(result?.text||'观察工具没有返回正文');
   }catch(error){if(signal?.aborted)throw error;result={isError:true,text:error.message};}
   await executor.record?.(name,args,result,undefined,true,{taskId:null});
   facts.observations.push({sourceId:observation.sourceId,version:source?.version,tool:name,status:result.isError?'unavailable':'observed',result});
  }
 }
 if(facts.query?.type==='skill_detail'&&facts.skills?.length===1){
  const slug=facts.skills[0].slug;let offset=0,content='';
  do{const part=await readSkill(executor.catalog,slug,undefined,offset);content+=part.content;offset=part.nextOffset;}while(offset!==null);
  facts.skillInstructions={slug,version:facts.skills[0].version,content};
 }
 return facts;
}
export function renderFacts(facts){
 if(facts.skillInstructions)return formatRuntimeFacts(facts)+'\n\n'+facts.skillInstructions.content;
 if(facts.query?.type==='skill_detail'&&!facts.skills?.length)return '未找到该 Skill，请使用目录中的准确名称或 ID。';
 if(facts.query?.type==='presentation')return (facts.entries||facts.artifacts).map(a=>['text','message','prompt'].includes(a.type)?a.content:a.type==='image'?`![图片 v${a.version}](${a.url})`:`[${a.type} v${a.version}](${a.url})`).join('\n\n');
 if(facts.query?.type==='artifact_inventory')return facts.artifacts.length?facts.artifacts.map(a=>`${a.title}（${a.type} v${a.version}，${a.publication}）\nID：${a.id}\n关系：${a.relationships.map(r=>`${r.relation} ${r.artifactId} v${r.version}`).join('；')||'原始成果'}`).join('\n\n'):'当前没有正式成果记录。';
 if(['task_plan','task_inspect','execution_inspect'].includes(facts.query?.type))return (facts.tasks.map(t=>`${t.summary||t.id}\n状态：${t.status}，版本：${t.revision}${t.reason?'\n'+t.reason:''}${t.batches&&Object.keys(t.batches).length?'\n实际保存的执行参数：'+JSON.stringify(Object.values(t.batches).map(b=>({batchId:b.id,status:b.status,items:b.items}))):''}${t.proposals?.length?'\n\n'+t.proposals.map(a=>a.content).join('\n\n'):t.plan?'\n方案：'+JSON.stringify(t.plan):''}`).join('\n\n')||'未找到目标任务。')+(facts.executions?'\n执行回执：'+JSON.stringify(facts.executions):'')+(facts.quote?'\n\n报价：'+facts.quote.reason:'');
 return formatRuntimeFacts(facts);
}
export function queryChecks(facts){
 const type=facts.query?.type;
 const resolved=type==='history'?!!facts.message:type==='skill_detail'?facts.resolved&&facts.skills.length===1:type==='model_identity'?!!facts.modelIdentity?.configuredModel:['task_plan','task_inspect','execution_inspect'].includes(type)?facts.tasks?.length>0:true;
 const topicMatched=facts.query?.topicMatched!==false;
 const observationFailed=facts.observations?.some(o=>o.status!=='observed');
 return {sourceTrusted:true,topicMatched,queryResolved:!!resolved&&!observationFailed,answerCovered:false,answerCoverageStatus:'not_composed',completionAllowed:topicMatched&&!observationFailed,...(!resolved||observationFailed?{availability:'unavailable',reason:observationFailed?'媒体观察未成功；已有记录可用于解释，不能冒充已看见画面':'所需原文或配置事实不可得，已如实说明缺口'}:{availability:'available'})};
}

export function selectRuntimeFacts(snapshot,query){
 const base={source:snapshot.source,version:snapshot.version,query,observedAt:snapshot.observedAt};
 switch(query.type){
 case 'model_identity':return {...base,modelIdentity:snapshot.modelIdentity};
 case 'quote':return {...base,quote:snapshot.quote};
 case 'tools':return {...base,entries:snapshot.entries,unsupported:snapshot.unsupported};
 case 'skills':return {...base,skills:snapshot.skills};
 case 'skill_detail':return {...base,skills:snapshot.skills.filter(s=>query.targets?.includes(s.slug)),resolved:query.targets?.length===1};
 case 'history':return {...base,source:'conversation',message:query.message,requestedAnchor:query.requestedAnchor};
  case 'capabilities':return {...snapshot,query};
  case 'conversation':return {source:'runtime_registry',query,modelIdentity:snapshot.modelIdentity,entries:snapshot.entries.map(({operation,configured,health})=>({operation,configured,health}))};
 default:throw new Error('查询主题未实现：'+query.type);
 }
}
