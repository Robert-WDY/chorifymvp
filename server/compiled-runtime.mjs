import {isDeferred} from './stage-contract.mjs';
import {observeImages} from './observation-contract.mjs';
import {executionRecovery} from './delivery-acceptance.mjs';
import {recordChange} from './change-set.mjs';
import {acceptanceRecord} from './document-contract.mjs';
import {assertWorkflow} from './planning-boundary.mjs';
import {withNode} from './trace-context.mjs';
import {verifyArtifactOnce} from './verification-attempt.mjs';
import {executeTextStage,publishTextCandidate} from './text-stage.mjs';
import {loadInspection,renderFacts,capabilitySnapshot,queryChecks} from './runtime-facts.mjs';
import {assertContract} from './task-contract.mjs';
import {compileGoal,validateGraph,migrateGraph,prepareMediaPlan,validatePrepared} from './goal-compiler.mjs';
import {currentTask,taskArtifacts,storeOf,reconcileTask,transition,addArtifact} from './task-state.mjs';
import {resolveSources} from './sources.mjs';
export async function runCompiled(executor,signal,publish){
 const {state,brain}=executor,task=currentTask(state);
 assertContract(task);task.protocol='compiled-v1';task.validationPolicy='strict';task.resultAcceptancePolicy=executor.verifier?.policy||'strict';task.runtimeFacts=capabilitySnapshot(executor.runtime,executor.catalog);
 if(task.goal.requestContract?.query)task.runtimeFacts=await loadInspection(executor,{operation:'inspect_runtime',runtimeQuery:task.goal.requestContract.query});
 const quoteRequired=task.goal.requestContract?.systemFacts?.includes('quote')&&task.items.some(i=>i.output!=='text');
 if(task.goal.capabilityGap){task.recovery={kind:'unsupported',nextActor:'deployment',...task.goal.capabilityGap};transition(state,'BLOCKED',task.goal.capabilityGap.reason);await executor.save(state);return;}
 try{for(const item of task.items)assertWorkflow(item,task.items,executor.catalog);}catch(error){task.recovery={kind:error.code==='unsupported_method'?'unsupported':'plan',nextActor:'system',reason:error.message};transition(state,'BLOCKED',error.message);await executor.save(state);return;}
 if(!task.items.length){transition(state,'NEEDS_INPUT','当前没有可执行交付，请补齐任务目标或素材后重新理解。');await executor.save(state);return;}
 if(task.recovery?.kind==='missing_quote'){transition(state,'BLOCKED','实际报价来源尚未配置，不能通过继续操作跳过事实缺口。');return;}
 migrateGraph(task);task.executionPlan??=compileGoal(task);validateGraph(task);await executor.save(state);
 for(let pass=0;pass<task.items.length*3+2+Math.min(20,Math.max(...task.items.map(i=>i.artifactCount||1)));pass++){
  signal.throwIfAborted();if(!task.goal.readOnlyTurn)await executor.refresh(signal);reconcileTask(state);
  if(['COMPLETED','SIMULATED','REFUSED','WAIT_CONFIRM','NEEDS_INPUT','CANCELLED'].includes(task.status))return;
  let progressed=false;
  for(const node of task.executionPlan.nodes){
   const item=task.items.find(i=>i.id===node.itemId);
   if(isDeferred(item)){node.status='needs_input';continue;}
   if(item.status==='COMPLETED'){node.status='completed';continue;}
   if(node.failedRunId&&node.failedRunId===state.currentRunId)continue;
   if(item.status==='WAITING'||!node.dependsOn.every(id=>task.items.find(i=>i.id===id)?.status==='COMPLETED'))continue;
   if(node.kind==='unsupported'){task.recovery={kind:'unsupported',nextActor:'deployment',operation:item.operation};node.status='blocked';item.status='BLOCKED';transition(state,'BLOCKED','当前MVP未开放该能力：'+item.operation+'。目标已保留。');continue;}
   try{
    if(node.kind==='inspection'){
     if(node.inspectionCompleted){item.status='BLOCKED';task.recovery={kind:'query_contract_mismatch',nextActor:'system'};transition(state,'BLOCKED','只读查询已返回，但证据合同未满足；停止重复查询。');continue;}
     const facts=await loadInspection(executor,item);
     item.readReceipt={facts,checks:queryChecks(facts),text:renderFacts(facts),artifactReferences:facts.artifacts?.map(a=>({id:a.id,version:a.version}))||[],newArtifacts:0};
     if(!item.readReceipt.checks.completionAllowed)task.recovery={kind:'query_contract_mismatch',nextActor:'system'};
     item.observations.push({tool:'runtime_facts',args:{operation:item.operation},result:facts});
     if(item.operation==='query_task'||item.requiredEvidence==='task')item.observations.push({tool:'refresh_task_results',args:{},result:{results:Object.values(storeOf(state).executions).map(e=>({...e.result,taskId:e.providerTaskId}))}});
     await executor.record('inspect_runtime',{operation:item.operation},{receipt:item.readReceipt,facts});node.status='completed';node.inspectionCompleted=true;progressed=true;
     if(item.operation==='inspect_quote'&&task.items.some(i=>i.dependsOn.includes(item.index)&&i.output!=='text')){task.recovery={kind:'missing_quote',nextActor:'configuration'};reconcileTask(state);for(const pending of task.items.filter(i=>i.output!=='text'&&i.status!=='COMPLETED'))pending.status='BLOCKED';reconcileTask(state);transition(state,'BLOCKED','方案/查询已保存，但实际报价不可取得，依赖报价的媒体尚未授权。');return;}
    }else if(node.kind==='text'){
     await observeImages(executor,item,signal);

     if(!executor.verifier)throw new Error('缺少产物验证器，不能完成交付');
     if((item.artifactCount||1)>20)throw new Error('当前文字批次最多20份文档，原始文件数量已保留');
     const deliverySlot=taskArtifacts(state).filter(a=>a.itemId===item.id&&a.type==='text'&&a.verification.semantic==='passed'&&a.publication!=='superseded').length;
     const stageItem=(item.artifactCount||1)>1?{...item,deliverySlot}:item;
     let previous=null;
     for(let attempt=0;attempt<2;attempt++){
      const {result,methodRecords}=await executeTextStage(executor,stageItem,signal,previous);
      const verdict=await executor.verifier.verifyText(item,result.content,state,signal);
      const artifact=publishTextCandidate(executor,stageItem,result,methodRecords,verdict,previous?.artifactId||executor.parentFor(item,'text'));
      for(const method of methodRecords)await executor.record('run_skill',{slug:method.skillId,nodeId:item.id},{artifactId:artifact.id,methodId:method.id,contractValidated:true});
      await executor.record('commit_text_deliverable',result,{...artifact,isError:!verdict.passed});await executor.save(state);
      if(verdict.passed){node.status='completed';progressed=true;break;}
      item.issues=verdict.issues;previous={artifactId:artifact.id,content:result.content,issues:verdict.issues};if(attempt)throw new Error('文字修复后仍未通过验收：'+verdict.issues.join('；'));
     }
    }else{
     if(quoteRequired&&task.runtimeFacts.quote.status!=='available'){task.recovery={kind:'missing_quote',nextActor:'configuration'};reconcileTask(state);for(const pending of task.items.filter(i=>i.output!=='text'&&i.status!=='COMPLETED'))pending.status='BLOCKED';reconcileTask(state);transition(state,'BLOCKED','实际报价不可取得，已保留完成的文字方案；媒体尚未提交。');continue;}
     const allArtifacts=taskArtifacts(state).filter(a=>a.itemId===item.id&&a.purpose==='deliverable');
     const artifacts=allArtifacts.filter(a=>a.publication!=='superseded'&&!allArtifacts.some(b=>b.parentId===a.id));
     const unverified=artifacts.filter(a=>['not_checked','unverified','simulated_not_checked',...(task.resultAcceptancePolicy==='delivery_only'?['failed']:[])].includes(a.verification.semantic));
     if(unverified.length){
      // Retrying verification never creates another paid media submission.
      for(const a of unverified){if(a.metadata.simulated)continue;const verdict=executor.verifier?await verifyArtifactOnce(executor.verifier,item,a,state,signal):null;if(verdict){if(verdict.passed&&task.resultAcceptancePolicy==='delivery_only'&&a.publication==='audit')a.publication='current';if(task.resultAcceptancePolicy==='delivery_only'&&a.acceptance?.quality?.status!=='not_evaluated')a.priorQualityAssessment=a.acceptance?.quality; a.acceptance={...a.acceptance,...acceptanceRecord(verdict,a.url||a.content||'')};a.verification={technical:a.verification?.technical||'passed',semantic:verdict.passed?'passed':verdict.uncertain?'unverified':'failed',issues:verdict.issues,...(verdict.comparison?{comparison:verdict.comparison}:{})};}}
      reconcileTask(state);if(item.status==='COMPLETED'){progressed=true;continue;}
      if(unverified.some(a=>a.verification.semantic!=='passed'&&a.verification.semantic!=='failed')){item.status='BLOCKED';transition(state,'BLOCKED','产物已返回，但内容验证尚未通过；可重试验证，不重新生成。');continue;}
     }
     const failed=artifacts.filter(a=>a.verification.semantic==='failed');
     const batch=node.batchId?task.batches[node.batchId]:null;
     const needsRepair=failed.length&&batch?.executionIds.some(id=>failed.some(a=>a.sourceExecutionId===id));
     if(needsRepair&&node.revision>=2){item.status='BLOCKED';transition(state,'BLOCKED','修复后仍未通过验收，已保留版本和反馈。');continue;}
     if(Object.values(storeOf(state).executions).some(e=>e.taskId===task.id&&['pending','unknown'].includes(e.status)))throw new Error('当前任务提交结果未知，保留记录，禁止自动重提。');
     if(!node.batchId||needsRepair){transition(state,'PLANNING');await prepareMediaPlan(executor,item,node,signal);await publish({type:'execution_plan',plan:task.executionPlan});}
     if(task.status==='WAIT_CONFIRM')return;
     validatePrepared(task,node,state);const outcome=await executor.executeBatch(node.batchId,item,signal);
     const failure=outcome.results?.find(r=>r.isError);
     if(failure)throw new Error(failure.text||'工具执行明确失败，已保留进度');
     node.status=item.status==='COMPLETED'?'completed':'submitted';delete node.error;delete node.failedRunId;progressed=true;
    }
   }catch(error){if(signal.aborted)throw error;node.status='blocked';node.error=error.message;node.failedRunId=state.currentRunId;task.recovery={...executionRecovery(error,node,Object.values(storeOf(state).executions).filter(e=>e.taskId===task.id&&e.itemId===item.id)),itemId:item.id};recordChange(task,item,{status:'failed',error:error.message});item.status='BLOCKED';transition(state,'BLOCKED',error.message);}
   await executor.save(state);await publish({type:'plan_progress',node});
  }
  reconcileTask(state);if(!progressed||task.status==='WAITING')return;
 }
 reconcileTask(state);if(task.status!=='COMPLETED'&&task.status!=='WAITING')transition(state,'BLOCKED','达到本轮执行预算，进度已保存。');
}
