// Disposable model view. Raw provider/tool output remains immutable history.
export function resultView(record, {tool, maxDataChars = Infinity} = {}) {
  let raw;
  try { raw = JSON.parse(record.output); } catch { raw = {content:record.output}; }
  const status = raw?.status;
  const outcome = raw?.outcome || (status === 'approval_required' ? 'needs_confirmation'
    : ['queued','running','pending','inflight'].includes(status) ? (status==='inflight'?'unknown':'pending')
    : status === 'unknown' || raw?.submitted === 'unknown' ? 'unknown'
    : status === 'cancelled' || raw?.code === 'cancelled' || raw?.error?.code === 'cancelled' ? 'cancelled'
    : status === 'not_executed' ? 'not_executed'
    : raw?.ok === false || raw?.isError || ['failed','expired','rejected'].includes(status) ? 'failed' : 'succeeded');
  const submission = raw?.submission || (raw?.submitted === 'unknown' ? 'unknown' : raw?.submitted === true ? 'submitted'
    : raw?.submitted === false ? 'not_submitted' : 'not_applicable');
  const body = record.output, truncated = body.length > maxDataChars;
  const resultRefs = (raw?.assets || (raw?.asset ? [raw.asset] : [])).map(a=>({id:a.id,type:a.type,version:a.version,parentId:a.parentId,receiptId:a.receiptId}));
  if(raw?.messageId)resultRefs.push({id:raw.messageId,type:'record',seq:raw.seq,pagination:raw.pagination});
  for(const id of raw?.imageIds||[])if(!resultRefs.some(r=>r.id===id))resultRefs.push({id,type:'image'});
  // These fields survive body truncation. Batch members retain separate receipts.
  return {kind:record.kind==='system_observation'?'system_observation':'tool_result',
    ...(record.kind==='tool_result'?{callId:record.callId}:{}), tool:tool || record.name,
    outcome,submission, ...(raw?.proposalId?{proposalId:raw.proposalId}:{}), ...(raw?.receiptId?{receiptId:raw.receiptId}:{}),
    ...(raw?.providerReceiptId?{providerReceiptId:raw.providerReceiptId}:{}),
    ...(raw?.approvalId?{approvalId:raw.approvalId}:{}), ...(raw?.simulated!==undefined?{simulated:raw.simulated}:{}),
    ...(raw?.error?{error:raw.error}:raw?.isError?{error:{code:raw.code,message:raw.message}}:{}),
    ...(raw?.items?{members:raw.items.map(i=>({proposalId:i.proposalId,receiptId:i.receiptId,outcome:i.outcome,submission:i.submission,error:i.error,resultRefs:i.resultRefs,simulated:i.simulated}))}:{}),
    resultRefs,rawResultRef:{kind:'record',id:record.id,tool:'read_history',arguments:{messageId:record.id,offset:0,limit:12000}},
    ...(raw?.parentEvidence?{parentEvidence:{...raw.parentEvidence,content:raw.parentEvidence.content.slice(0,240),contentTruncated:raw.parentEvidence.content.length>240}}:{}),
    ...(raw?.deliveryCheck?{deliveryCheck:raw.deliveryCheck}:{}),
    ...(raw?.changeEvidence?{changeEvidence:{changed:raw.changeEvidence.changed,baseProposalId:raw.changeEvidence.baseProposalId,changedFields:raw.changeEvidence.changedFields,changes:raw.changeEvidence.changes?.slice(0,8).map(c=>({...c,before:c.before.slice(0,160),after:c.after.slice(0,160),truncated:c.before.length>160||c.after.length>160})),...(raw.changeEvidence.text?{text:{changed:raw.changeEvidence.text.changed,readMore:'rawResultRef'}}:{}),meaningVerified:false}}:{}),
    truncated,data:truncated?{excerpt:body.slice(0,maxDataChars),totalCharacters:body.length,nextOffset:maxDataChars}:raw};
}
