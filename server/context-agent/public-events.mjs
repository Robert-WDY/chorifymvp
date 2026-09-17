import {appendRecord} from './history.mjs';
import {resultView} from './result-view.mjs';

export const safeText=value=>String(value||'').replace(/Bearer\s+\S+|sk-[\w-]{12,}/gi,'[redacted]').slice(0,800);
export function resultSummary(result={}){
 const view=resultView({kind:'tool_result',output:JSON.stringify(result)});
 const failed=view.outcome==='failed';
 return {status:view.outcome==='needs_confirmation'?'prepared':view.outcome,
  ...(result.status==='awaiting_user'?{note:'问题已成功发布；实际回答由问题卡记录'}:{}),
  ...(result.deliveryCheck?{note:result.deliveryCheck.status==='passed'?'已声明要求的草稿检查通过；最终文本须保持一致':'测量已完成，草稿未满足已声明要求'}:{}),
  ...(failed||view.outcome==='unknown'?{error:safeText(result.error?.message||result.message||result.items?.find(i=>i.error)?.error.message),code:result.error?.code||result.code}:{}),
  ...(result.receiptId?{receiptId:result.receiptId}:{}),...(result.proposalId?{proposalId:result.proposalId}:{}),
  simulated:result.simulated===true,submission:view.submission,submitted:view.submission==='unknown'?'unknown':view.submission==='submitted',
  resultRefs:[...view.resultRefs,...(result.items||[]).flatMap(item=>item.resultRefs||[])].map(a=>({id:a.id,type:a.type,version:a.version})).slice(0,20),
  receipts:(result.items||[]).filter(item=>item.receiptId).map(item=>({receiptId:item.receiptId,proposalId:item.proposalId,outcome:item.outcome,submission:item.submission})).slice(0,20)};
}
export function appendPublicEvent(state,turnId,event){
 const seq=state.records.length;
 const record=appendRecord(state,{kind:'run_event',event:'public_event',turnId,public:event});
 return {type:'public_event',eventId:record.id,seq,turnId,at:record.at,...event};
}
export function publicEvents(state,after=-1,limit=100){
 const events=[];let cursor=after;
 for(let seq=after+1;seq<state.records.length;seq++){
  const r=state.records[seq];cursor=seq;
  if(r.kind==='run_event'&&r.event==='public_event')events.push({type:'public_event',eventId:r.id,seq,turnId:r.turnId,at:r.at,...r.public});
  if(events.length>=limit)break;
 }
 return {events,cursor,hasMore:cursor<state.records.length-1};
}
