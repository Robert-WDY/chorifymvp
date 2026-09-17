import {countBody} from '../text-measure.mjs';
import {fingerprint,GuardError} from './io-guard.mjs';
import {selectOriginal} from './document-source.mjs';

// Requirements and semantic item boundaries are chosen by the Agent. This tool
// checks the entire declared draft, never infers a contract from keywords.
export function measureDelivery(args,{state,turnId}={}){
 const {text,unit,requirements,items,bodyText}=args;
 if(bodyText!==undefined)selectOriginal(text,bodyText);
 const count=countBody(bodyText??text,unit),issues=[];
 if(!requirements)return {count,unit};
 if(requirements.min!==undefined&&requirements.max!==undefined&&requirements.min>requirements.max)throw new GuardError('invalid_requirements','字数下限不能超过上限');
 const declared=[];
 if(state&&turnId){
  const results=new Map(state.records.filter(r=>r.kind==='tool_result'&&r.turnId===turnId).map(r=>[r.callId,r]));
  for(const call of state.records){
   if(call.kind!=='tool_call'||call.turnId!==turnId||call.name!=='measure_text')continue;
   try{const prior=JSON.parse(call.arguments),receipt=JSON.parse(results.get(call.callId)?.output);
    // A failed content check still declares valid constraints. Invalid arguments
    // and failed tool operations do not establish new constraints.
    if(receipt.ok&&receipt.deliveryCheck)declared.push(prior);
   }catch{}
  }
 }
 const groups=new Map(),itemCounts=new Set();
 for(const declaration of [...declared,args]){
  const r=declaration.requirements;if(!r)continue;
  if(r.itemCount!==undefined)itemCounts.add(r.itemCount);
  const key=declaration.unit+':'+(declaration.bodyText!==undefined),group=groups.get(key)||{unit:declaration.unit,bodyOnly:declaration.bodyText!==undefined};
  if(r.min!==undefined)group.min=Math.max(group.min??0,r.min);
  if(r.max!==undefined)group.max=Math.min(group.max??Infinity,r.max);
  if(group.min!==undefined||group.max!==undefined)groups.set(key,group);
 }
 for(const group of groups.values()){
  if(group.bodyOnly&&bodyText===undefined){issues.push('declared_body_scope_missing');continue;}
  const actual=countBody(group.bodyOnly?bodyText:text,group.unit);group.count=actual;
  if(group.min!==undefined&&actual<group.min)issues.push('below_minimum');
  if(group.max!==undefined&&actual>group.max)issues.push('above_maximum');
 }
 if(itemCounts.size){
  if(!items||items.join('\n\n')!==text)issues.push('items_do_not_cover_entire_delivery');
  if([...itemCounts].some(n=>items?.length!==n))issues.push('item_count_mismatch');
 }
 return {count,unit,deliveryCheck:{status:issues.length?'failed':'passed',issues:[...new Set(issues)],requirements,effectiveChecks:{text:[...groups.values()],itemCounts:[...itemCounts]},bodyOnly:bodyText!==undefined,itemCount:items?.length,textIdentity:fingerprint(text),scope:'declared_constraints_on_exact_draft',semanticMeaningVerified:false}};
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
   message:'最终正文尚未通过本轮已声明要求的验收。只修正文并用measure_text重新检查完整交付；重测不能放宽已有要求、改计数口径或漏掉备选。',requirements:check.requirements,effectiveChecks:check.effectiveChecks};
 }
 return null;
}
