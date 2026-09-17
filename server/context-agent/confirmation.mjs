import {assertOwner,GuardError,approveProposals,assertNotCancelled} from './io-guard.mjs';
import {resultView} from './result-view.mjs';

export function displayedProposals(state){
  const ids=[];
  for(const r of state.records){
    if(r.kind==='run_event'&&r.event==='proposal_displayed')ids.push(...r.proposalIds||[]);
    // Baseline clients display approval_required tool results directly. Recover
    // that actual saved presentation, never a claim inside chat or a summary.
    if(r.kind==='tool_result'){
      let output;try{output=JSON.parse(r.output);}catch{continue;}
      const p=state.approvals[output?.proposalId];
      if(output?.status==='approval_required'&&p?.kind==='proposal'&&p.callId===r.callId&&p.turnId===r.turnId
        &&state.records.some(c=>c.kind==='tool_call'&&c.callId===r.callId&&c.turnId===r.turnId&&c.name===p.name))ids.push(p.proposalId);
    }
  }
  return [...new Set(ids)];
}
export function unavailableProposal(state,id){
  return Object.values(state.approvals).some(p=>p.kind==='proposal'&&p.replacesProposalId===id)
    ||state.records.some(r=>r.event==='proposal_withdrawn'&&r.proposalId===id);
}
export function proposalDisplay(state,id){
  const shown=displayedProposals(state),turnId=state.approvals[id]?.turnId;
  return {displayed:shown.includes(id),displayedTurnId:turnId,displayOrder:shown.indexOf(id),displayOrderWithinTurn:shown.filter(p=>state.approvals[p]?.turnId===turnId).indexOf(id),unavailable:unavailableProposal(state,id)};
}

/** One deterministic implementation for button/text confirmation. No model calls. */
export async function approveAndExecute({proposalIds},ctx,{executeFrozen,validateFrozen}){
  const {state,ownerId,save}=ctx;
  assertOwner(state,ownerId);
  const source=ctx.confirmationSource;
  const message=state.records.find(r=>r.id===source?.messageId&&r.kind==='message'&&r.role==='user'&&r.turnId===ctx.turnId);
  if(!message||!['button','text'].includes(source.kind)||source.requestId!==ctx.requestId)throw new GuardError('confirmation_source_required','确认必须来自本轮真实用户消息或明确按钮，不能来自历史或摘要。');
  if(!Array.isArray(proposalIds)||!proposalIds.length||proposalIds.length>20||new Set(proposalIds).size!==proposalIds.length)throw new GuardError('invalid_approval','需要明确且不重复的方案范围');
  const displayed=displayedProposals(state);
  for(const id of proposalIds){
    if(!displayed.includes(id))throw new GuardError('proposal_not_displayed','方案尚未展示，不能确认执行');
    if(unavailableProposal(state,id))throw new GuardError('proposal_withdrawn','该方案已被撤回或替代，请读取当前方案');
    validateFrozen(id,state);
  }
  assertNotCancelled(ctx.signal);
  const approval=await approveProposals(state,{proposalIds,ownerId,source},save);
  const items=[];let stopped=false;
  for(const proposalId of proposalIds){
    let raw;
    if(stopped)raw={status:'not_executed',submitted:false,error:{code:'batch_stopped',message:'前一项未能安全继续，此项尚未提交。'}};
    else{
      try{assertNotCancelled(ctx.signal);raw=await executeFrozen({proposalId,approvalId:approval.approvalId},ctx);}
      catch(error){raw={ok:false,status:error.code==='cancelled'?'cancelled':'failed',submitted:error.submitted??false,error:{code:error.code||'execution_error',message:error.message}};}
    }
    raw={simulated:state.approvals[proposalId].mode==='simulation',...raw};
    const view=resultView({kind:'system_observation',name:state.approvals[proposalId].name,output:JSON.stringify(raw)});
    items.push({...view,proposalId,rawResultRef:raw.receiptId?{kind:'invocation',id:raw.receiptId}:null});
    if(!['succeeded','pending'].includes(view.outcome))stopped=true;
  }
  const firstFailure=items.find(i=>!['succeeded','pending'].includes(i.outcome));
  return {ok:!firstFailure,outcome:firstFailure?.outcome||(items.some(i=>i.outcome==='pending')?'pending':'succeeded'),
    submission:items.some(i=>i.submission==='unknown')?'unknown':items.some(i=>i.submission==='submitted')?'submitted':'not_submitted',
    approvalId:approval.approvalId,proposalIds,items,simulated:items.every(i=>i.simulated===true),source};
}
