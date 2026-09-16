import {AsyncLocalStorage} from 'node:async_hooks';
import {fingerprint} from './adapters.mjs';
import {guardSubmission} from './submission-guard.mjs';
const permits=new AsyncLocalStorage();
// A runtime adapter cannot confer authorization on itself. Only the executor
// which persisted the exact pending execution enters this asynchronous scope.
export function withSubmissionPermit(state,execution,fn){return permits.run({state,id:execution.id},fn);}
export function assertSubmissionPermit(state,name,args){
 const p=permits.getStore(),store=state.taskStore,e=store?.executions?.[p?.id],task=store?.tasks?.[e?.taskId];
 if(p?.state!==state||!e||e.status!=='pending'||e.tool!==name||e.parameterHash!==fingerprint(name,args)||!task)throw Object.assign(new Error('媒体适配器缺少绑定执行记录的提交许可'),{uncertain:false,code:'submission_authorization'});
 const item=task.items.find(i=>i.id===e.itemId);
 try{guardSubmission(task,item,name,args,{slot:e.slot,executions:Object.values(store.executions).filter(x=>x.id!==e.id)});}
 catch(error){error.uncertain=false;throw error;}
}
