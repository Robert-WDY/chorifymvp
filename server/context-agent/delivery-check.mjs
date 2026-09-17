import {countBody} from '../text-measure.mjs';
import {fingerprint,GuardError} from './io-guard.mjs';
import {selectOriginal} from './document-source.mjs';

// Requirements and semantic item boundaries are chosen by the Agent. This tool
// checks the entire declared draft, never infers a contract from keywords.
export function measureDelivery(args){
 const {text,unit,requirements,items,bodyText}=args;
 if(bodyText!==undefined)selectOriginal(text,bodyText);
 const count=countBody(bodyText??text,unit),issues=[];
 if(!requirements)return {count,unit};
 if(requirements.min!==undefined&&requirements.max!==undefined&&requirements.min>requirements.max)throw new GuardError('invalid_requirements','字数下限不能超过上限');
 if(requirements.min!==undefined&&count<requirements.min)issues.push('below_minimum');
 if(requirements.max!==undefined&&count>requirements.max)issues.push('above_maximum');
 if(requirements.itemCount!==undefined){
  if(!items||items.join('\n\n')!==text)issues.push('items_do_not_cover_entire_delivery');
  if(items?.length!==requirements.itemCount)issues.push('item_count_mismatch');
 }
 return {count,unit,deliveryCheck:{status:issues.length?'failed':'passed',issues,requirements,bodyOnly:bodyText!==undefined,itemCount:items?.length,textIdentity:fingerprint(text),scope:'declared_constraints_on_exact_draft',semanticMeaningVerified:false}};
}

// Only a check explicitly made in this user turn governs its final response.
// Stored tool receipts are the evidence; no second state or mandatory audit call.
export function finalDeliveryCheck(state,turnId,text){
 const results=new Map(state.records.filter(r=>r.kind==='tool_result'&&r.turnId===turnId).map(r=>[r.callId,r]));
 for(const call of [...state.records].reverse()){
  if(call.kind!=='tool_call'||call.turnId!==turnId||call.name!=='measure_text')continue;
  let args,result;try{args=JSON.parse(call.arguments);result=JSON.parse(results.get(call.callId)?.output);}catch{continue;}
  if(!args.requirements)continue;
  const check=result?.deliveryCheck||{status:'failed',issues:['measurement_failed'],requirements:args.requirements};
  if(check.status==='passed'&&check.textIdentity===fingerprint(text))return null;
  return {ok:false,code:'delivery_check_failed',submitted:false,measurementCallId:call.callId,
   issues:[...check.issues,...(check.textIdentity!==fingerprint(text)?['final_text_changed_after_measurement']:[])],
   message:'最终正文尚未通过本轮已声明要求的验收。只修正文并用measure_text重新检查完整交付；不要追加未测量备选或解释。',requirements:check.requirements};
 }
 return null;
}
