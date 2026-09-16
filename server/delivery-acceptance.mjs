// Delivery acceptance is not a claim that content constraints or visual quality passed.
export function deliveryVerdict({content,artifact}={}){
 const issues=[];
 if(artifact){
  if(!artifact.url||!['image','video','audio'].includes(artifact.type))issues.push('缺少可交付媒体结果');
  if(artifact.status&&artifact.status!=='completed')issues.push('媒体结果尚未完成');
  if(artifact.verification?.technical==='failed')issues.push('媒体执行或技术检查失败');
  if(artifact.metadata?.simulated)issues.push('测试替身不能作为真实交付');
 }else if(typeof content!=='string'||!content.trim())issues.push('文字交付为空');
 const passed=issues.length===0;
 return {passed,outcome:passed?'passed':'failed',uncertain:false,issues,evaluationPolicy:'delivery_only',checker:{kind:'program',phase:'delivery_presence'},quality:{status:'not_evaluated'},recovery:passed?null:{kind:'missing_deliverable',nextActor:'executor',action:'retry_missing_output'},...(artifact?.metadata?.coverage?{coverage:{passed,unitIds:artifact.metadata.coverage.unitIds,scope:'receipt_mapping_not_visual_quality'}}:{})};
}
export function executionRecovery(error,node,executions=[]){
 if(executions.some(e=>['pending','unknown'].includes(e.status)&&!e.providerTaskId))return {kind:'receipt_reconciliation',nextActor:'operator',action:'reconcile_provider_receipt',automaticResubmit:false};
 if(executions.some(e=>['pending','unknown','submitted'].includes(e.status)))return {kind:'submission_pending_or_unknown',nextActor:'executor',action:'poll_existing_execution',automaticResubmit:false};
 const contract=['execution_projection','invalid_schema','reference_contract','reference_selection','operation_selection','document_authority','unsupported_method'].includes(error.code);
 return {kind:contract?'contract_error':node.kind==='text'?'text_execution_error':'media_execution_error',nextActor:contract?'intake':'executor',action:contract?'replan_affected_target':'retry_failed_step',automaticResubmit:false,reason:error.message};
}
