
/** Adapt original fixture API actions; never rewrite queries or invent setup results. */
export async function runCaseTurns({caseData:c,agent,state,inputs=[],save=async()=>{},signal=new AbortController().signal,canCall=()=>true}){
  const rounds=[],byRound=new Map();let first=true;
  for(const [index,turn] of [...(c.setup_turns||[]).map(t=>({...t,setup:true})),...c.conversation].entries()){
    if(!canCall()){rounds.push({index,user:turn.user,status:'not_run',reason:'Global model-call budget exhausted'});break;}
    let confirmation;
    if(turn.action){
      if(turn.action.type!=='confirm_batch')throw new Error(`Unsupported original API action: ${turn.action.type}`);
      const prior=byRound.get(turn.action.from_round)||[];
      const proposals=prior.filter(r=>r.kind==='tool_result').map(r=>{try{return JSON.parse(r.output);}catch{return {};}}).filter(r=>r.status==='approval_required').map(r=>r.proposalId);
      if(!proposals.length){rounds.push({index,user:turn.user,status:'not_run',reason:'Original approval action has no displayed proposal from its specified source round'});break;}
      // Trusted approval records are projected by buildContext; this does not
      // masquerade as model text or change the original user quotation.
      confirmation={proposalIds:proposals};
    }
    const start=state.records.length;
    const result=await agent.run(state,turn.user,()=>{},signal,{inputs:first?inputs:[],requestId:`${c.id}:${index}`,confirmation});first=false;
    rounds.push({index,setup:!!turn.setup,user:turn.user,result});
    if(!turn.setup)byRound.set(turn.round,state.records.slice(start));
    if(result.status!=='completed')break;
  }
  await save(state);return {rounds};
}
