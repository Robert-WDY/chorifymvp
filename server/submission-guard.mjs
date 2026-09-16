import {unresolvedScope} from './workflow-contract.mjs';
import {fingerprint} from './adapters.mjs';
import {assertContract} from './task-contract.mjs';
export function guardSubmission(task,item,name,args,{slot='',executions=[]}={}){
 assertContract(task);
 if(unresolvedScope(task))throw new Error('任务存在未解决的执行范围，禁止提交媒体');
 if(!task.items.some(i=>i.id===item.id))throw new Error('提交对象不属于本任务合同');
 if(task.contract?.effects.mediaSubmissionAllowed===false)throw new Error('只读合同禁止提交媒体');
 if(task.recovery?.kind==='missing_quote')throw new Error('缺少实际报价，不能提交媒体');
 if(task.effectPolicy==='explicit_approval'&&!task.approval.required)throw new Error('媒体提交需要独立批准');
 if(task.effectPolicy==='explicit_approval'&&(!task.approval.controlReceipt||task.approval.controlReceipt.source!=='explicit_control'||task.approval.controlReceipt.taskId!==task.id||task.approval.controlReceipt.revision!==task.revision||task.approval.controlReceipt.planHash!==task.approval.planHash))throw new Error('媒体提交缺少显式控制批准回执');
 if(task.approval.required){const a=task.approval,p=a.payload;
  if(a.status!=='approved'||a.revision!==undefined&&a.revision!==task.revision||a.contractHash&&a.contractHash!==task.contract?.hash)throw new Error('媒体提交尚未获得当前版本批准');
  if(!p||p.itemId!==item.id||p.tool!==name||!p.items?.some(v=>fingerprint(name,v)===fingerprint(name,args))||slot&&p.batchId&&!slot.startsWith(p.batchId+':'))throw new Error('媒体提交超出已批准的具体方案');
  if(a.quote?.expiresAt&&Date.parse(a.quote.expiresAt)<=Date.now())throw new Error('授权报价已过期');
 }
 const logical=task.id+':'+task.revision+':'+item.id+':'+(slot||'direct');
 const previous=executions.findLast(e=>e.logicalExecutionId===logical);
 if(previous&&['pending','unknown'].includes(previous.status))throw new Error('同一逻辑执行受理状态未知，必须核对回执');
 if(previous&&['submitted','succeeded'].includes(previous.status)&&previous.parameterHash!==fingerprint(name,args)&&previous.acceptance?.passed!==false)throw new Error('不能通过修改参数绕过已有逻辑执行');
 return logical;
}
