import {immutableEvent,withTrace,tracedBrain} from './trace-context.mjs';
import { rememberAssets } from './assets.mjs';
import {TaskExecutor} from './execution-engine.mjs';
import {storeOf,projectState,taskSnapshot} from './task-state.mjs';
export function hasPendingTasks(state) {
  return [...Object.values(state.videoTasks||{}),...Object.values(state.mediaTasks||{})].some(t=>['queued','running'].includes(t.status))||
    Object.values(state.taskStore?.tasks||{}).some(task=>needsVerificationRecovery(state,task));
}
function needsVerificationRecovery(state,task){
  if(task.protocol!=='compiled-v1'||!['VERIFYING','PARTIAL'].includes(task.status)||(task.backgroundContinuations||0)>=2)return false;
  const store=state.taskStore;
  if(Object.values(store.executions).some(e=>e.taskId===task.id&&['pending','unknown','submitted'].includes(e.status)))return false;
  return Object.values(store.artifacts).some(a=>a.taskId===task.id&&a.purpose==='deliverable'&&['image','video'].includes(a.type)&&
    !a.metadata?.simulated&&['not_checked','unverified'].includes(a.verification?.semantic));
}
// Poll only known IDs: restarts and browser disconnects never resubmit paid jobs.
export async function refreshTasks(state,runtime,signal,options={}){return withTrace(state,options.save||(async()=>{}),()=>refreshInternal(state,runtime,signal,options));}
async function refreshInternal(state,runtime,signal,{save=async()=>{},verifier=null,resume=null}={}) {
  if(state.taskStore&&Object.keys(state.taskStore.tasks).length){
    const store=storeOf(state),active=store.activeTaskId;let changed=false;
    // Older sessions may have receipts with no task model. Poll those IDs too;
    // preserve their media as historical inputs, never attribute them to a new goal.
    for(const e of Object.values(store.executions).filter(e=>e.taskId==='legacy'&&e.status==='submitted'&&e.providerTaskId)){
      try{const name=e.tool==='generate_video'?'get_video_task':'get_media_task',result=await runtime.execute(name,{taskId:e.providerTaskId},state,signal);
        e.result=result;e.status=['queued','running'].includes(result.status)?'submitted':result.isError?'failed':'succeeded';
        for(const [kind,url] of [['video',result.videoUrl],['audio',result.audioUrl],...(result.images||[]).map(i=>['image',i.url])])if(url)store.inputs[e.id+':'+kind]={assetId:e.id+':'+kind,kind,url,source:'历史工具回执'};
        pushEvent(state,{type:'tool_result',name,result,callId:'legacy-monitor:'+e.id,media:true});changed=true;
      }catch{/* Keep known receipts for a future query; never resubmit. */}
    }
    try{for(const task of Object.values(store.tasks)){
      if(!Object.values(store.executions).some(e=>e.taskId===task.id&&e.status==='submitted')&&!needsVerificationRecovery(state,task))continue;
      store.activeTaskId=task.id;projectState(state);
      const record=async(name,args,result)=>{const callId='monitor_'+Date.now()+'_'+args.taskId;state.messages.push({type:'function_call',call_id:callId,name,arguments:JSON.stringify(args)},{type:'function_call_output',call_id:callId,output:JSON.stringify(result)});state.events.push({type:'tool_result',name,callId,result,media:true});changed=true;};
      const executor=new TaskExecutor({state,runtime,catalog:runtime.catalog,brain:runtime.brain,save,record,verifier});await executor.refresh(signal);
      if(resume&&['PARTIAL','VERIFYING'].includes(task.status)&&!Object.values(store.executions).some(e=>e.taskId===task.id&&['submitted','unknown','pending'].includes(e.status))&&(task.backgroundContinuations||0)<2){
        task.backgroundContinuations=(task.backgroundContinuations||0)+1;changed=true;await save(state);await resume(state,task.id);
      }
      state.events.push({type:'task_state',task:taskSnapshot(state)});
    }}finally{store.activeTaskId=active;projectState(state);if(changed)await save(state);}
    return changed;
  }
  state.events??=[];let changed=false;
  for(const [bucket,tool] of [['videoTasks','get_video_task'],['mediaTasks','get_media_task']]) {
    for(const task of Object.values(state[bucket]||{})) {
      if(!['queued','running'].includes(task.status))continue;
      try {
        const result=await runtime.execute(tool,{taskId:task.taskId},state,signal);
        if(JSON.stringify(result)!==JSON.stringify(task)) {
          changed=true;rememberAssets(state,result,tool);
          state.events.push({type:'tool_result',name:tool,callId:`monitor:${task.taskId}:${Date.now()}`,result,media:true});
          if(['succeeded','failed'].includes(result.status)) {
            const callId=`monitor_${Date.now()}_${task.jobId||task.taskId}`;
            state.messages.push({type:'function_call',name:tool,call_id:callId,arguments:JSON.stringify({taskId:task.taskId})},
              {type:'function_call_output',call_id:callId,output:JSON.stringify(result)});
            state.events.push({type:'notice',text:result.status==='succeeded'?'媒体任务已完成，结果如下方播放器所示。':'媒体任务处理失败，请查看任务状态。'});
          }
        }
      } catch { /* A query failure is not a failed generation. Retry known IDs on the next sweep. */ }
    }
  }
  if(!hasPendingTasks(state)&&state.status==='waiting') {
    state.status=[...Object.values(state.videoTasks||{}),...Object.values(state.mediaTasks||{})].some(t=>['failed','expired','cancelled'].includes(t.status))?'failed':'completed';changed=true;
  }
  return changed;
}

function pushEvent(state,event){state.events??=[];state.events.push(immutableEvent(state,event));}
