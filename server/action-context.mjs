// A model view, not a new memory store. No inferred brand/account facts are
// promoted to user memory and no execution ledger is mutated here.
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
export function buildActionContext(payload,{userMemory=[]}={}){
 const task=payload.taskSnapshot,entries=payload.referenceCatalog.entries;
 const proposal=task?.revisionTarget;
 const recent=payload.conversation.recentMessages;
 const documents=payload.sourceDocuments||[];
 return {
  query:payload.query,currentMessageId:payload.currentMessageId,replyTo:payload.replyTo,
  userMemory:userMemory.filter(m=>m.confirmedByUser===true&&m.scope==='session'&&payload.conversation.messageIndex?.some(message=>message.messageId===m.sourceMessageId&&message.role==='user')).map(m=>pick(m,['value','sourceMessageId','scope','confirmedByUser'])),
  activeTaskState:task?{
   ...pick(task,['id','revision','status','completionStatus','query','missingInputs']),
   stages:task.stages,
   requirements:(task.requirements||[]).map(r=>pick(r,['id','goal','type','count','dependsOn','status','remaining','constraints'])),
   facts:task.goal?.facts||[],globalConstraints:task.goal?.globalConstraints||[],
   pendingSteps:(task.items||[]).filter(i=>i.status!=='COMPLETED').map(i=>pick(i,['id','description','status','references','spec','activation'])),
   confirmation:proposal?{type:'PROPOSAL',id:proposal.targetArtifactId,version:proposal.targetVersion,taskId:task.id,taskRevision:task.revision,planHash:task.approval?.planHash}:null,
   approval:pick(task.approval,['required','status']),
   // Parameter changes still use the existing revision contract, never approve.
   revisionTarget:proposal||null
  }:null,
  relevantEvidence:{
   conversation:{recentMessages:recent,messageIndex:payload.conversation.messageIndex,pendingRequest:payload.conversation.pendingRequest,
    recentAttempts:payload.conversation.recentAttempts.map(t=>pick(t,['runId','input','inputMessageId','status','error','decision'])),policy:payload.conversation.policy},
   references:entries.map(e=>pick(e,['id','handle','type','version','filename','purpose','taskId','sourceMessageId','visibleOrdinal','readable','productionUsable','excerpt','contentSource','units'])),
   sourceDocuments:documents,
   relatedTasks:(payload.taskIndex||[]).filter(t=>t.id!==task?.id).map(t=>pick(t,['id','revision','status','completionStatus','summary','originalQuery','revisionTarget','facts','globalConstraints','artifacts'])),
   skillDirectory:payload.skillDirectory,executionDefaults:payload.executionDefaults
  },
  contextPolicy:{source:'durable_session_projection',rawHistoryFor:'understanding_and_reference_resolution_only',fullSourceForExecution:'loaded_by_reference_id_and_version',assistantStatementsAreUserRequirements:false,activeTaskIsNotImplicitTarget:true}
 };
}
