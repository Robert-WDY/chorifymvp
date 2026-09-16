// Read-only projections. Do not import SessionStore, Agent, or business validators.
import {readFile,readdir,stat} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {modelStage,structuredModelOutput} from '../dist/debug/model-evidence.mjs';
import {sessionEvidence} from './debug-session-view.mjs';

const values=x=>Array.isArray(x)?x:Object.values(x||{});
const arr=x=>Array.isArray(x)?x:[];
const stamp=x=>Number.isFinite(Date.parse(x))?Date.parse(x):null;
const sameRun=(x,id)=>x?.runId===id||(!x?.runId&&x?.requestId===id);
const pointer=s=>String(s).replaceAll('~','~0').replaceAll('/','~1');
const secretKey=/^(?:(?:[a-z0-9]+[-_])*(?:api[-_]?key|api[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password)|key|passwd|client[-_]?secret|private[-_]?key|cookie|set-cookie|proxy-authorization|x-api-key|x-mvp-token)$/i;
export function redactDebug(value,key=''){
 if(secretKey.test(key)||/^authorization$/i.test(key)&&(value===null||typeof value!=='object'))return '[REDACTED]';
 if(typeof value==='string'){
  // JSON bodies are often embedded inside model messages and tool results.
  if(/^[\s]*[\[{]/.test(value)){try{return JSON.stringify(redactDebug(JSON.parse(value)));}catch{/* Plain text or rejected JSON remains readable. */}}
  return value.replace(/\bsk-[\w-]{8,}/g,'[REDACTED_KEY]')
   .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi,'[REDACTED_CREDENTIAL]')
   .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|cookie|authorization)\s*["']?\s*[:=]\s*)[^\r\n,}]+/gi,'$1[REDACTED]')
   .replace(/https?:\/\/[^\s<>"']+/gi,url=>{try{const u=new URL(url);u.username='';u.password='';const hadQuery=!!u.search;u.search='';u.hash='';return u.toString()+(hadQuery?'?[REDACTED_QUERY]':'');}catch{return '[REDACTED_URL]';}});
 }
 if(Array.isArray(value))return value.map(v=>redactDebug(v));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redactDebug(v,k)]));
 return value;
}
function category(path,origins){
 const origin=origins?.[path]?.origin||origins?.[path];
 if(['user','explicit','user_explicit'].includes(origin))return 'explicit_user_change';
 if(['default','system_default'].includes(origin))return 'system_default';
 if(origin==='unauthorized')return 'unauthorized_addition';
 if(/\/(status|updatedAt|finishedAt|startedAt|transitions|actions|observations)(\/|$)/.test(path))return 'internal_state';
 return 'unattributed';
}
export function stateDiff(before,after,{origins={}}={}){
 const changes=[];
 function walk(a,b,path){
  if(JSON.stringify(a)===JSON.stringify(b))return;
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
   for(const k of new Set([...Object.keys(a),...Object.keys(b)]))walk(a[k],b[k],path+'/'+pointer(k));
  }else if((a===undefined||b===undefined)&&typeof(a??b)==='object'&&(a??b)!==null&&Object.keys(a??b).length){
   for(const k of Object.keys(a??b))walk(a?.[k],b?.[k],path+'/'+pointer(k));
  }else changes.push({field:path||'/',old:a??null,new:b??null,oldPresent:a!==undefined,newPresent:b!==undefined,change:a===undefined?'added':b===undefined?'removed':'changed',classification:category(path,origins)});
 }
 walk(before,after,'');return changes;
}
function textOf(x){
 if(typeof x==='string')return x;
 if(Array.isArray(x))return x.map(textOf).filter(Boolean).join('\n');
 return x?.text||textOf(x?.content)||'';
}
function parsedOutput(c){try{return JSON.parse(textOf(c.output).replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{return null;}}
function findFields(value,name,path=''){
 if(!value||typeof value!=='object')return [];
 return Object.entries(value).flatMap(([k,v])=>[...(k===name?[{path:path+'/'+pointer(k),value:v}]:[]),...findFields(v,name,path+'/'+pointer(k))]);
}
function originsOf(value,path='',out={}){
 if(!value||typeof value!=='object')return out;
 for(const [k,v] of Object.entries(value)){
  if(k==='specOrigins')for(const [field,origin] of Object.entries(v||{}))out[path+'/spec/'+pointer(field)]=origin;
  else originsOf(v,path+'/'+pointer(k),out);
 }return out;
}
function duration(start,end){return stamp(start)!==null&&stamp(end)!==null?Math.max(0,stamp(end)-stamp(start)):null;}

export function aggregateRun(state,runId,{source='saved-session',boundary=null}={}){
 const turns=arr(state.turns),turnIndex=turns.findIndex(t=>sameRun(t,runId));
 if(turnIndex<0)return null;
 const turn=turns[turnIndex],store=state.taskStore||{},events=arr(state.events).filter(e=>sameRun(e,runId));
 const calls=arr(state.modelCalls).filter(c=>sameRun(c,runId)),callIds=new Set(calls.map(c=>c.id));
 const toolRecords=values(store.toolCalls).filter(c=>sameRun(c,runId));
 const executions=values(store.executions).filter(c=>sameRun(c,runId));
 const final=events.findLast(e=>e.type==='final'),intentEvent=events.find(e=>e.type==='intent');
 const accepted=turn.decision?.semantic||intentEvent?.decision?.semantic||intentEvent?.goal?.semantic||null;
 const eventSnapshots=events.filter(e=>e.type==='task_state'&&e.task);
 const taskIds=new Set([turn.taskId,...events.map(e=>e.taskId)].filter(Boolean));
 const contextIds=new Set(events.map(e=>e.contextTaskId).filter(Boolean));
 const currentTasks=values(store.tasks).filter(t=>taskIds.has(t.id));
 const recordedTasks=[...new Map(eventSnapshots.map(e=>[e.task.id,e.task])).values()];
 const candidates=calls.filter(c=>arr(c.validations).some(v=>['understand','intent'].includes(v.phase))||(!c.nodeId&&!c.methodId&&(parsedOutput(c)?.deliverables||parsedOutput(c)?.turnOperation))).map(c=>({callId:c.id,at:c.finishedAt,source:'/modelCalls/'+arr(state.modelCalls).indexOf(c),rawOutput:c.output??null,parsedRawOutput:parsedOutput(c),validations:c.validations||[],accepted:arr(c.validations).some(v=>v.accepted===true)}));
 const timeline=[{id:'query',phase:'USER INPUT',at:turn.createdAt,source:'/turns/'+turnIndex,data:{rawInput:turn.rawInput,assets:turn.assets,explicitTarget:turn.explicitTarget,createdAt:turn.createdAt}}];
 const stateSnapshots=[];
 const addSnapshot=(id,stage,data,source,at,scope,recorded=true)=>stateSnapshots.push({id,stage,data,source,at,scope,recorded});
 for(const c of candidates){
  if(c.parsedRawOutput)addSnapshot(c.callId+':raw','MODEL DRAFT',c.parsedRawOutput,c.source+'/output',c.at,'request_contract');
  for(const [i,v] of c.validations.entries())if(v.parsed)addSnapshot(c.callId+':validation:'+i,'VALIDATION '+v.phase,v.parsed,c.source+'/validations/'+i+'/parsed',c.at,'request_contract');
 }
 if(accepted)addSnapshot('accepted','ACCEPTED CONTRACT',accepted,'/turns/'+turnIndex+'/decision/semantic',intentEvent?.occurredAt,'request_contract');
 for(const e of eventSnapshots)addSnapshot(e.eventId||'task:'+stateSnapshots.length,'TASK STATE',e.task,'/events/'+arr(state.events).indexOf(e)+'/task',e.occurredAt,'task:'+e.task.id);
 const previous=turns[turnIndex-1];
 const previousEvents=previous?arr(state.events).filter(e=>sameRun(e,previous.runId||previous.requestId)&&e.type==='task_state'&&e.task):[];
 const diffs=[];
 for(const scope of new Set(stateSnapshots.map(s=>s.scope))){const snapshots=stateSnapshots.filter(s=>s.scope===scope);for(let i=1;i<snapshots.length;i++)diffs.push({from:snapshots[i-1].id,to:snapshots[i].id,scope,kind:'recorded_projection',changes:stateDiff(snapshots[i-1].data,snapshots[i].data,{origins:originsOf(snapshots[i].data)})});}
 const prior=previous?.decision?.semantic;
 const previousTurn={runId:previous?.runId||previous?.requestId||null,available:!!previous,contract:prior||null,taskSnapshots:previousEvents.map(e=>({source:'/events/'+arr(state.events).indexOf(e),task:e.task})),comparison:prior&&accepted?stateDiff(prior,accepted,{origins:originsOf(accepted)}):null,note:'合同差异不等于完整 State 差异；不同任务不视为同一状态变更。'};
 for(const e of previousEvents){const next=stateSnapshots.find(s=>s.scope==='task:'+e.task.id);if(next&&e===previousEvents.findLast(x=>x.task.id===e.task.id))diffs.unshift({from:'previous:'+previous.runId,to:next.id,scope:next.scope,kind:'cross_turn_recorded_task',before:e.task,changes:stateDiff(e.task,next.data)});}
 const fieldOrigins=stateSnapshots.flatMap(s=>findFields(s.data,'selectedDirectionIndex').map(f=>({...f,snapshotId:s.id,stage:s.stage,source:s.source,meaning:'first observed is not proof of creation time'})));
 const available=boundary?.actualIntakeOptions||null;
 const constraints=[...new Set([...(accepted?.globalConstraints||[]),...(accepted?.deliverables||[]).flatMap(d=>d.constraints||[])])].filter(x=>typeof x==='string'&&x);
 const contextSnapshots=calls.map(c=>{
  const actual=c.normalizedRequest??null,actualText=JSON.stringify(actual||'');
  const isIntake=candidates.some(x=>x.callId===c.id);
  const stage=modelStage(c),assembly=sessionEvidence(state,turnIndex,[c],stateDiff).assembly[0];
  const payload=assembly?.components?.find(p=>p.goal||p.nodeId||p.item);
  const historicalItems=[...new Map(recordedTasks.flatMap(t=>arr(t.items)).map(i=>[i.id,i])).values()];
  const matched=historicalItems.filter(i=>i.description===(typeof payload?.goal==='string'?payload.goal:payload?.goal?.description));
  const nodeId=c.nodeId||payload?.nodeId||payload?.item?.id||(matched.length===1?matched[0].id:null);
  return {callId:c.id,nodeId,taskId:c.taskId??null,methodId:c.methodId??null,phase:stage.phase,stage,modelSequence:calls.indexOf(c)+1,structuredOutput:structuredModelOutput(c.output),bindingEvidence:c.nodeId?'recorded_node':nodeId?'recorded_payload_unique_target':'unavailable',model:c.model||actual?.model,at:c.startedAt,durationMs:c.durationMs??duration(c.startedAt,c.finishedAt),usage:c.providerResponse?.usage||null,actualRequest:actual,preTransportInput:c.input??null,tools:c.tools||[],options:c.options||null,availableContext:isIntake?available:null,availableContextSource:isIntake&&available?'boundary.actualIntakeOptions':null,output:c.output??null,providerResponse:c.providerResponse??null,validations:c.validations||[],error:c.error??null,contextLoss:{context_loss:null,status:actual?'literal_check_only':'unavailable',hints:actual?constraints.filter(x=>!actualText.includes(x)).map(x=>({constraint:x,reason:'accepted constraint not literally present; may be paraphrased or introduced later, not proof of semantic loss'})):[],note:'不重新拼接历史。语义丢失与未授权状态变更不能由文本匹配确证。'}};
 });
 const requiredItems=recordedTasks.flatMap(t=>arr(t.items).map(i=>({...i,taskId:t.id,scopeEvidence:'recorded_task_snapshot'})));
 // For a turn cut off before its first task snapshot, accepted requirements remain visible.
 if(!requiredItems.length)for(const [i,d] of (accepted?.deliverables||[]).entries())requiredItems.push({...d,id:'contract:'+i,scopeEvidence:'accepted_contract',methods:[]});
 const recordedPlans=[...recordedTasks.map(t=>t.executionPlan),...events.filter(e=>e.type==='execution_plan').map(e=>e.plan)].filter(Boolean);
 for(const plan of recordedPlans)for(const node of values(plan.nodes)){
  let item=requiredItems.find(i=>i.id===(node.itemId||node.id));
  if(!item){item={id:node.itemId||node.id,requiredMethods:[],methods:[],scopeEvidence:'recorded_execution_plan'};requiredItems.push(item);}
  item.requiredMethods=[...new Set([...arr(item.requiredMethods),...arr(node.requiredMethods)])];
  item.selectedMethods=[...new Set([...arr(item.selectedMethods),node.skillId].filter(Boolean))];
 }
 const globalRequired=(accepted?.requiredMethods||[]).filter(id=>!requiredItems.some(i=>arr(i.requiredMethods).includes(id)));
 if(globalRequired.length)requiredItems.push({id:'contract:global',requiredMethods:globalRequired,methods:requiredItems.flatMap(i=>arr(i.methods)),scopeEvidence:'accepted_contract'});
 const skills=requiredItems.flatMap(item=>{
  const methods=arr(item.methods),ids=new Set([...arr(item.requiredMethods),...arr(item.selectedMethods),...methods.map(m=>m.skillId||m.slug)].filter(Boolean));
  return [...ids].map(skillId=>{
   const records=methods.filter(m=>(m.skillId||m.slug)===skillId);
   const scoped=records.filter(m=>arr(m.modelCallIds).some(id=>callIds.has(id))||sameRun(m,runId));
   const executed=scoped.some(m=>arr(m.modelCallIds).some(id=>calls.some(c=>c.id===id&&['returned','completed'].includes(c.status))));
   const loaded=records.some(m=>!!m.contentHash),outputs=[...new Set(scoped.flatMap(m=>arr(m.outputArtifactIds)))];
   const required=arr(item.requiredMethods).includes(skillId);
   const recordedOutputs=recordedTasks.flatMap(t=>arr(t.artifacts)).filter(a=>outputs.includes(a.id));
   const producedArtifact=outputs.length>0&&outputs.every(id=>recordedOutputs.some(a=>a.id===id));
   const verified=executed&&scoped.some(m=>m.contractValidated===true)&&producedArtifact&&recordedOutputs.every(a=>a.verification?.technical==='passed'&&a.verification?.semantic==='passed');
   return {skillId,itemId:item.id,required,selected:true,loaded,executed,producedArtifact,verified,version:records[0]?.version||records[0]?.contractVersion||null,inputArtifacts:scoped.flatMap(m=>m.inputArtifactIds||m.inputArtifacts||m.input?.sourceArtifactIds||[]),outputArtifacts:outputs,callIds:[...new Set(scoped.flatMap(m=>arr(m.modelCallIds)))],executionId:scoped[0]?.id||null,status:required&&!executed?'MISSING_EXECUTION_EVIDENCE':verified?'verified':producedArtifact?'produced_artifact':executed?'executed':loaded?'loaded':'selected',scopeEvidence:item.scopeEvidence,records,projection:arr(item.methodExecution),note:'执行证据须链接到本轮有返回的模型调用；产物与验收须见本轮任务快照。旧方法记录、Skill 选择或加载不等于本轮执行。'};
  });
 });
 const tools=toolRecords.map(c=>({...c,callId:c.id,request:c.args??null,durationMs:duration(c.startedAt,c.finishedAt),validation:Object.fromEntries(['schema','permission','source','budget'].map(k=>[k,c.validation?.[k]??c.validations?.[k]??{status:'unrecorded'}])),source:'/taskStore/toolCalls/'+pointer(c.id)}));
 const explicitArtifactIds=new Set([...events.flatMap(e=>arr(e.artifacts).map(a=>typeof a==='string'?a:a.id)),...recordedTasks.flatMap(t=>arr(t.items).flatMap(i=>arr(i.artifactIds))),...skills.flatMap(s=>s.outputArtifacts)]);
 const queryReferences=q=>[...arr(q?.targets),...arr(q?.bindings)];
 const references=[...queryReferences(accepted?.turnOperation?.presentation),...(accepted?.deliverables||[]).flatMap(d=>[...arr(d.references),...queryReferences(d.runtimeQuery)]),...recordedTasks.flatMap(t=>arr(t.items).flatMap(i=>[...arr(i.references),...queryReferences(i.runtimeQuery),...arr(i.readReceipt?.artifactReferences)])),...arr(turn.queryReceipt?.artifactReferences),...arr(final?.queryReceipt?.artifactReferences)];
 const snapshotArtifacts=new Map([...recordedTasks.flatMap(t=>arr(t.artifacts)),...arr(final?.artifacts).filter(a=>a&&typeof a==='object')].map(a=>[a.id,a]));
 const allArtifacts=values(store.artifacts).map(a=>({...snapshotArtifacts.get(a.id)||a,debugEvidenceScope:snapshotArtifacts.has(a.id)?'recorded_in_run':'latest_file_ledger_not_run_snapshot'})),execIds=new Set(executions.map(e=>e.id));
 const newArtifacts=allArtifacts.filter(a=>sameRun(a,runId)||execIds.has(a.sourceExecutionId)||(explicitArtifactIds.has(a.id)&&stamp(a.createdAt)!==null&&stamp(turn.createdAt)!==null&&stamp(a.createdAt)>=stamp(turn.createdAt)&&stamp(a.createdAt)<=(stamp(turn.finishedAt)??Infinity)));
 const selected=new Set([...explicitArtifactIds,...newArtifacts.map(a=>a.id),...references.map(r=>typeof r==='string'?r:r?.artifactId||r?.id)]);
 const edgeList=[];
 for(const a of allArtifacts){
  for(const r of arr(a.relationships))edgeList.push({from:r.artifactId,to:a.id,type:r.relation||'untyped',version:r.version,evidence:'relationships'});
  if(a.parentId&&!arr(a.relationships).some(r=>r.artifactId===a.parentId))edgeList.push({from:a.parentId,to:a.id,type:'parent_unspecified',evidence:'parentId (relation not recorded)'});
  if(a.sourceExecutionId)edgeList.push({from:a.sourceExecutionId,to:a.id,type:'created_from',evidence:'sourceExecutionId'});
 }
 // Include ancestors, never another session's graph or unrelated sibling outputs.
 let changed=true;while(changed){changed=false;for(const e of edgeList)if(selected.has(e.to)&&!selected.has(e.from)){selected.add(e.from);changed=true;}}
 const artifacts=allArtifacts.filter(a=>selected.has(a.id));
 const edges=edgeList.filter(e=>selected.has(e.to)&&selected.has(e.from));
 const graphNodes=[...artifacts.map(a=>({id:a.id,type:a.type,version:a.version,publication:a.publication||null,scope:newArtifacts.some(n=>n.id===a.id)?'new_in_run':'referenced_or_historical',simulated:a.metadata?.simulated||false})),...[...selected].filter(id=>!artifacts.some(a=>a.id===id)).map(id=>({id,type:values(store.executions).some(e=>e.id===id)?'execution':'unresolved_reference'}))];
 const coverage=requiredItems.flatMap(item=>{
  if(arr(item.requirementCoverage).length)return item.requirementCoverage.map(r=>({...r,itemId:item.id,evidence:'recorded_requirementCoverage'}));
  const c=item.resolvedCoverage||item.coverage;
  const ids=c?.unitIds||item.sourceSelection?.unitIds||[];
  return ids.map(id=>({requirementId:item.id+':'+id,source:c?.source||item.sourceSelection?.source,expected:{unitId:id},actual:item.coverageProgress?.covered?.includes(id)?[id]:[],status:item.coverageProgress?.covered?.includes(id)?'completed':'unknown',evidence:item.coverageProgress?'recorded_coverageProgress':'required_unit_without_verdict',itemId:item.id}));
 });
 const coverageSummary={completed:coverage.filter(c=>c.status==='completed').length,total:coverage.length,status:!coverage.length?'unrecorded':coverage.every(c=>c.status==='completed')?'recorded_complete':'incomplete_or_unknown',reportedStatus:turn.status,note:'无 Coverage 时不能从 artifact count 推断用户义务完成。'};
 const verification={business:recordedTasks.map(t=>({taskId:t.id,checker:'task.verification (recorded)',result:t.verification||null,requirements:t.contract?.requirements||null})),artifacts:artifacts.map(a=>({artifactId:a.id,evidenceScope:a.debugEvidenceScope,technical:a.verification?.technical??'unrecorded',semantic:a.verification?.semantic??'unrecorded',business:a.acceptance?.procedure??'unrecorded',mediaQuality:a.acceptance?.quality??'unrecorded',raw:a.verification,acceptance:a.acceptance})),modelChecks:contextSnapshots.filter(c=>/verif|review/i.test(c.phase)).map(c=>({callId:c.callId,checker:c.model,input:c.actualRequest,result:c.output})),note:'模型阶段未标明 checker 的调用保留在 Context Inspector；不猜测为验收调用。验收记录同时标明是本轮快照还是文件最终账本。'};
 const errors=[...(turn.error?[{phase:'turn',message:turn.error,source:'/turns/'+turnIndex+'/error'}]:[]),...events.filter(e=>e.error).map(e=>({phase:e.type,message:e.error,source:'/events/'+arr(state.events).indexOf(e)})),...calls.flatMap(c=>[...(c.error?[{phase:c.nodeId||'model',callId:c.id,message:c.error}]:[]),...arr(c.validations).filter(v=>v.error).map(v=>({phase:v.phase||'validation',callId:c.id,message:v.error,detail:v}))]),...tools.filter(c=>c.error||c.result?.isError).map(c=>({phase:'tool',callId:c.id,message:c.error||c.result,source:c.source}))];
 const cutoff=JSON.stringify([turn.error,final,boundary?.cutoffApplied]).includes('STAGE_A_ACCEPTANCE_BOUNDARY_STOP')||boundary?.cutoffApplied===true;
 const diagnostics=[];
 if(errors.length||cutoff)diagnostics.push({category:cutoff?'evaluation_cutoff':'recorded_error',severity:cutoff?'info':'error',message:cutoff?'评测在接受合同后主动截断，不能算业务执行失败。':'存在记录的异常；请检查原始 validator/tool/model 证据。',evidence:cutoff?{cutoffApplied:boundary?.cutoffApplied||null,errors:errors.map(e=>e.source||e.callId)}:errors.map(e=>e.source||e.callId)});
 if(calls.some(c=>arr(c.validations).some(v=>v.accepted===false&&v.error)))diagnostics.push({category:'validation_rejection',severity:accepted?'warning':'error',message:'存在程序拒绝的模型草稿；拒绝事实不等于 validator 存在 bug。',evidence:calls.flatMap(c=>arr(c.validations).filter(v=>v.accepted===false&&v.error).map(v=>({callId:c.id,phase:v.phase,error:v.error})))});
 if(tools.some(c=>c.error||c.result?.isError))diagnostics.push({category:'tool_error',severity:'error',message:'工具记录包含执行错误，查看 Tool Inspector 的原始参数与返回。',evidence:tools.filter(c=>c.error||c.result?.isError).map(c=>c.id)});
 for(const s of skills.filter(s=>s.status==='MISSING_EXECUTION_EVIDENCE'))diagnostics.push({category:'skill_missing',severity:cutoff?'info':'warning',message:s.skillId+': MISSING_EXECUTION_EVIDENCE',evidence:s.itemId});
 if(coverage.length&&coverageSummary.completed<coverage.length)diagnostics.push({category:'coverage_gap',severity:cutoff?'info':turn.status==='completed'?'error':'warning',message:'Coverage '+coverageSummary.completed+'/'+coverage.length+'；记录状态 '+turn.status,evidence:coverage.map(c=>c.requirementId)});
 if(fieldOrigins.length)diagnostics.push({category:'selector_inspection',severity:'hint',message:'发现 selectedDirectionIndex，查看最早可见草稿及阶段 Diff；此提示本身不判定污染。',evidence:fieldOrigins});
 for(const c of contextSnapshots)if(c.contextLoss.hints.length)diagnostics.push({category:'context_literal_hint',severity:'hint',message:c.contextLoss.hints.length+' 条接受约束在请求中未逐字出现，需人工核对',evidence:c.callId});
 for(const c of calls)timeline.push({id:c.id,phase:c.methodId||c.nodeId||'MODEL',at:c.startedAt,source:'/modelCalls/'+arr(state.modelCalls).indexOf(c),data:c});
 for(const e of events)timeline.push({id:e.eventId||'event:'+timeline.length,phase:e.type.toUpperCase(),at:e.occurredAt,source:'/events/'+arr(state.events).indexOf(e),data:e});
 for(const t of tools)timeline.push({id:t.id,phase:'TOOL '+t.name,at:t.startedAt,source:t.source,data:t});
 timeline.sort((a,b)=>(stamp(a.at)??Infinity)-(stamp(b.at)??Infinity));
 const planEvents=events.filter(e=>['execution_plan','plan','plan_progress'].includes(e.type));
 const missing=[];
 if(!eventSnapshots.length)missing.push('本轮没有 task_state 快照，不能重建完整阶段 State。');
 if(!available)missing.push('未记录模型调用前的完整 available context，不能计算可信上下文召回率。');
 if(contextSnapshots.some(c=>!c.actualRequest))missing.push('部分模型调用未记录供应商实际请求；preTransportInput 不等于实际发出。');
 if(!coverage.length)missing.push('未记录逐单元 RequirementCoverage，整体需求完成程度未知。');
 if(tools.some(t=>Object.values(t.validation).some(v=>v.status==='unrecorded')))missing.push('部分工具 Schema/权限/来源/预算判定未分别落盘。');
 missing.push('历史状态的每一次写入及写入者未完整记录；首个可见字段只证明该时点已存在。');
 if(recordedTasks.length)missing.push('原任务快照可能将产物 content 裁剪到 10000 字符；此界面保留已有截断，不补写历史正文。');
 return redactDebug({schemaVersion:1,sessionView:sessionEvidence(state,turnIndex,calls,stateDiff),runId,sessionId:state.id,source,status:turn.status||final?.status||'unknown',duration:duration(turn.createdAt,turn.finishedAt),createdAt:turn.createdAt,evaluation:{cutoff,sampleId:boundary?.sampleId||null,stopScope:boundary?.stopScope||null,fixtureHash:boundary?.fixtureHash||null,note:boundary?'真实模型入口评测；预置素材可能为测试中间态，接受后可能被截断。':'执行真实性未由数据来源标签单独证明，请核对调用和产物记录。'},userInput:{role:'user',content:turn.rawInput||'',timestamp:turn.createdAt,messageId:turn.messageId||null,assets:turn.assets||[]},intent:{businessAction:turn.businessAction||intentEvent?.goal?.businessAction||null,candidates,acceptedContract:accepted,decision:turn.decision||intentEvent?.decision||null,diffs:diffs.filter(d=>d.scope==='request_contract')},contract:{accepted,recordedTasks:recordedTasks.map(t=>({taskId:t.id,contract:t.contract})),latestLedger:currentTasks.map(t=>({taskId:t.id,contract:t.contract})),latestLedgerWarning:'当前文件最终账本，仅供查阅；可能晚于本轮，不能冒充本轮状态。'},stateSnapshots,stateDiffs:diffs,fieldOrigins,previousTurn,latestLedger:{tasks:currentTasks,contextTasks:values(store.tasks).filter(t=>contextIds.has(t.id)),scope:'file_final_state_not_run_snapshot'},contextSnapshots,plan:{events:planEvents,snapshots:recordedTasks.map(t=>({taskId:t.id,executionPlan:t.executionPlan,plan:t.plan}))},skills,tools,executions,artifacts,artifactGraph:{nodes:graphNodes,edges},delivery:{operation:accepted?.turnOperation||null,artifactReferences:references,queryReceipt:turn.queryReceipt||final?.queryReceipt||null,newArtifacts:newArtifacts.length,newArtifactIds:newArtifacts.map(a=>a.id),countEvidence:'explicit_run_link_or_recorded_artifact_with_timestamp',countComplete:!!final&&!!turn.finishedAt,note:'没有完成事件时，0 表示已记录新增为 0，不证明未发生未知提交。'},requirementCoverage:coverage,coverageSummary,verification,finalResponse:final?{text:final.text,status:final.status,artifacts:final.artifacts,eventId:final.eventId,source:'recorded_final_event'}:{text:null,status:turn.status,source:'unrecorded_no_message_guess'},errors,diagnostics,timeline,missingData:missing});
}

export class DebugTraceStore{
 constructor(directories,{boundaryDirectory=null}={}){this.sources=directories.map((d,i)=>({id:'source'+i,label:basename(resolve(d)),directory:resolve(d)}));this.boundaryDirectory=boundaryDirectory&&resolve(boundaryDirectory);this.cache=new Map();this.boundaries=null;this.warnings=[];}
 async boundaryIndex(){
  if(this.boundaries)return this.boundaries;
  this.boundaries=new Map();if(!this.boundaryDirectory)return this.boundaries;
  try{for(const filename of await readdir(this.boundaryDirectory))if(/^A\d+-\d+\.json$/.test(filename)){const b=JSON.parse(await readFile(join(this.boundaryDirectory,filename),'utf8'));this.boundaries.set(b.sessionId+':'+b.requestId,{...b,acceptedSnapshot:undefined,finalNativeSnapshot:undefined});}}catch(e){this.warnings.push({source:'boundaries',error:e.code||'invalid_json'});}
  return this.boundaries;
 }
 async sessions(){
  const entries=[];this.warnings=[];
  for(const source of this.sources){let names;try{names=await readdir(source.directory);}catch(e){this.warnings.push({source:source.id,error:e.code});continue;}
   for(const name of names.filter(n=>/^[\w-]+\.json$/.test(n))){const path=join(source.directory,name);try{
    const info=await stat(path);if(!info.isFile())continue;if(info.size>128*1024*1024){this.warnings.push({source:source.id,file:name,error:'file_exceeds_128MiB'});continue;}
    const key=info.mtimeMs+':'+info.size;let entry=this.cache.get(path);
    if(entry?.key!==key){const bytes=await readFile(path,'utf8'),s=JSON.parse(bytes);entry={key,state:s,sha256:createHash('sha256').update(bytes).digest('hex')};this.cache.set(path,entry);}
    if(entry.state?.id&&name===entry.state.id+'.json'){
     if(Array.isArray(entry.state.turns))entries.push({...entry,source:source.id,file:name});
     else this.warnings.push({source:source.id,file:name,error:'missing_turn_ledger (legacy session not reconstructed)'});
    }
   }catch(e){this.warnings.push({source:source.id,file:name,error:e.code||'invalid_json'});}}
  }return entries;
 }
 async list({q='',status='',source='',offset=0,limit=50}={}){
  const entries=await this.sessions(),boundaries=await this.boundaryIndex();
  const runs=entries.filter(e=>!source||e.source===source).flatMap(e=>e.state.turns.map(t=>{
   const runId=t.runId||t.requestId,b=boundaries.get(e.state.id+':'+runId),errors=arr(e.state.events).filter(v=>sameRun(v,runId)&&v.error),cutoff=!!b?.cutoffApplied||JSON.stringify(t.error||'').includes('STAGE_A_ACCEPTANCE_BOUNDARY_STOP');
   const failedTool=values(e.state.taskStore?.toolCalls).find(c=>sameRun(c,runId)&&(c.error||c.result?.isError));
   const inheritedFixture=!b&&[...boundaries.keys()].some(k=>k.startsWith(e.state.id+':'));
   return {runId,sessionId:e.state.id,source:e.source,query:t.rawInput||'',status:t.status||'unknown',createdAt:t.createdAt,duration:duration(t.createdAt,t.finishedAt),failurePoint:cutoff?'evaluation_cutoff':errors[0]?.type||(failedTool?'tool:'+failedTool.name:t.error?'turn':['failed','blocked'].includes(t.status)?'unrecorded':null),sampleId:b?.sampleId||null,recordingKind:b?'evaluation_sample':inheritedFixture?'fixture_history':'saved_run',cutoff,evidenceHash:e.sha256};
  })).filter(r=>r.runId&&(!status||r.status===status)&&(!q||[r.query,r.runId,r.sessionId,r.sampleId].join(' ').toLowerCase().includes(q.toLowerCase()))).sort((a,b)=>(stamp(b.createdAt)??0)-(stamp(a.createdAt)??0));
  return redactDebug({runs:runs.slice(offset,offset+limit),total:runs.length,offset,limit,sources:this.sources.map(({id,label})=>({id,label})),warnings:this.warnings});
 }
 async run(runId,{sessionId,source}={}){
  const matches=(await this.sessions()).filter(e=>(!source||e.source===source)&&(!sessionId||e.state.id===sessionId)&&e.state.turns.some(t=>sameRun(t,runId)));
  if(!matches.length)throw Object.assign(new Error('Run 不存在'),{status:404});
  if(matches.length!==1)throw Object.assign(new Error('Run ID 在多个数据源或会话中存在，请指定 source 和 sessionId'),{status:409});
  const e=matches[0],b=(await this.boundaryIndex()).get(e.state.id+':'+runId);
  return {...aggregateRun(e.state,runId,{source:e.source,boundary:b}),evidence:{file:e.file,sha256:e.sha256,readOnly:true}};
 }
 async failures({source=''}={}){
  const listing=await this.list({source,limit:Number.MAX_SAFE_INTEGER}),groups={},window=listing.runs.filter(r=>r.recordingKind!=='fixture_history').slice(0,100);
  const entries=await this.sessions(),boundaries=await this.boundaryIndex();
  for(const r of window){const entry=entries.find(e=>e.source===r.source&&e.state.id===r.sessionId),run=aggregateRun(entry.state,r.runId,{source:r.source,boundary:boundaries.get(r.sessionId+':'+r.runId)});for(const category of new Set(run.diagnostics.map(d=>d.category))){(groups[category]??=[]).push({...r,severity:run.diagnostics.find(d=>d.category===category).severity});}}
  return {window:window.length,totalAvailable:listing.total,groups,warnings:listing.warnings,note:'最近 100 条非 fixture_history Run；同一 Run 可有多个诊断，分类数量不可相加。hint ≠ 已证实故障；evaluation_cutoff 不计业务失败。没有证据不自动归因为 validator bug、上下文丢失或 State 污染。'};
 }
}
