import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {businessStateSnapshot} from './trace-state.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inputMetrics=input=>({version:'prompt-context-v1',inputHash:hash(input),systemHash:hash(input.filter(m=>m.role==='system')),characters:JSON.stringify(input).length,unit:'utf16_characters'});
const scope=new AsyncLocalStorage();
const traced=Symbol('tracedBrain');
const runtimeTraced=Symbol('tracedRuntime');
export async function withTool(name,args,fn){
 const s=scope.getStore();if(!s?.state)return fn();
 const state=s.state,turn=state.turns?.find(t=>t.runId===state.currentRunId);
 const record={id:'exec_'+randomUUID(),runId:state.currentRunId,requestId:state.currentRunId,taskId:turn?.taskId||null,contextTaskId:turn?.taskId?undefined:state.taskStore?.activeTaskId,nodeId:s.nodeId,name,args:structuredClone(args),status:'running',startedAt:new Date().toISOString()};
 (state.taskStore.toolCalls??={})[record.id]=record;await s.save(state);
 try{const result=await fn();record.result=result;record.status=result?.isError?'failed':'completed';return result;}
 catch(error){record.status='failed';record.error=redact(error.message);throw error;}
 finally{record.finishedAt=new Date().toISOString();await s.save(state);}
}
export function tracedRuntime(runtime){if(runtime[runtimeTraced])return runtime;return new Proxy(runtime,{get(target,key){if(key===runtimeTraced)return true;if(key!=='execute')return Reflect.get(target,key);return(name,args,state,signal)=>withTool(name,args,()=>target.execute(name,args,state,signal));}});}
export function redact(value){
 if(typeof value==='string')return value.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g,'[REDACTED_KEY]').replace(/(https?:\/\/[^\s"<>?]+)\?[^\s"<>]*/g,'$1?[REDACTED_QUERY]');
 if(Array.isArray(value))return value.map(redact);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,(/^(apiKey|key|headers|token|secret)$/i.test(k)||/^authorization$/i.test(k)&&typeof v!=='object')?'[REDACTED]':redact(v)]));
 return value;
}
export function withTrace(state,save,fn){return scope.run({state,save},async()=>{
 try{return await fn();}
 finally{
  const turn=state.turns?.find(t=>t.runId===state.currentRunId);
  if(turn?.stateBefore){turn.stateAfter=businessStateSnapshot(state);await save(state);}
 }
});}
export function withNode(nodeId,methodId,fn){return scope.run({...scope.getStore(),nodeId,methodId},fn);}
export function transportTrace(request,response){const s=scope.getStore();if(s?.call){if(request){s.call.normalizedRequest=redact(request);s.call.normalizedRequestMetrics={hash:hash(request),characters:JSON.stringify(request).length,unit:'utf16_characters'};}if(response)s.call.providerResponse=redact(response);}}
export function validationTrace(result){const s=scope.getStore();if(s?.lastCall)(s.lastCall.validations??=[]).push(redact(result));}
export async function captureIntentSnapshot(snapshot){
 const s=scope.getStore();if(!s?.state)return;
 const turn=s.state.turns?.find(t=>t.runId===s.state.currentRunId);if(!turn)return;
 if(snapshot.origin==='unaccepted_draft'){
  turn.draftIntentSnapshot=structuredClone(snapshot);
  validationTrace({phase:'intent_draft',accepted:false,snapshot});await s.save(s.state);return;
 }
 if(turn.intentSnapshot&&turn.intentSnapshot.hash!==snapshot.hash)throw new Error('同一轮不能替换 Intent Snapshot');
 turn.intentSnapshot??=structuredClone(snapshot);validationTrace({phase:'intent_snapshot',snapshot});await s.save(s.state);
}
export function tracedBrain(brain){if(brain[traced])return brain;return new Proxy(brain,{get(target,key){
 if(key===traced)return true;
 if(key!=='respond')return Reflect.get(target,key);
 return async(input,tools,signal,options)=>{
  const s=scope.getStore();if(!s?.state)return target.respond(input,tools,signal,options);
  const task=s.state.taskStore?.tasks[s.state.taskStore.activeTaskId];
  const understanding=!s.state.turns?.find(t=>t.runId===s.state.currentRunId)?.decision;
  const call={id:randomUUID(),requestId:s.state.currentRunId,runId:s.state.currentRunId,taskId:understanding?undefined:task?.id,contextTaskId:understanding?task?.id:undefined,revision:understanding?undefined:task?.revision,nodeId:options?.traceNodeId||s.nodeId,methodId:s.methodId,tracePhase:options?.tracePhase,attempt:options?.traceAttempt,startedAt:new Date().toISOString(),input:redact(input),modelView:inputMetrics(input),tools:redact(tools),options:redact(options),model:target.config?.model};
  (s.state.modelCalls??=[]).push(call);s.lastCall=call;await s.save(s.state);
  return scope.run({...s,call},async()=>{try{const output=await target.respond(input,tools,signal,options);call.output=redact(output);call.status='returned';return output;}catch(e){call.status='failed';call.error=redact(e.message);throw e;}finally{call.finishedAt=new Date().toISOString();call.durationMs=Date.parse(call.finishedAt)-Date.parse(call.startedAt);await s.save(s.state);}});
 };
}});}
export function immutableEvent(state,event){const turn=state.turns?.find(t=>t.runId===state.currentRunId),context=state.taskStore?.tasks[state.taskStore.activeTaskId],taskId=Object.hasOwn(event,'taskId')?event.taskId:turn?.taskId||null;return structuredClone({...event,eventId:randomUUID(),sequence:state.events.length+1,requestId:state.currentRunId,runId:state.currentRunId,taskId,contextTaskId:taskId?undefined:context?.id,revision:taskId?state.taskStore?.tasks[taskId]?.revision:undefined,occurredAt:new Date().toISOString()});}
