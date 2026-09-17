import {countBody} from '../text-measure.mjs';
import {fingerprint,GuardError} from './io-guard.mjs';
import {selectOriginal} from './document-source.mjs';

const targetKey=args=>args.assetId?JSON.stringify(['asset',args.assetId,args.assetVersion]):JSON.stringify([args.target?.kind||'reply',args.target?.id||'final']);
function measurements(state,turnId){
 const results=new Map((state?.records||[]).filter(r=>r.kind==='tool_result'&&r.turnId===turnId).map(r=>[r.callId,r]));
 return (state?.records||[]).filter(r=>r.kind==='tool_call'&&r.turnId===turnId&&r.name==='measure_text').flatMap(call=>{
  try{return [{call,args:JSON.parse(call.arguments),result:JSON.parse(results.get(call.callId)?.output)}];}catch{return [];}
 });
}
export function checkedDocument(state,turnId,callId,content){
 const entry=measurements(state,turnId).find(r=>r.call.callId===callId);
 if(!entry?.result.ok||entry.result.deliveryCheck?.status!=='passed'||entry.result.deliveryCheck.textIdentity!==fingerprint(content))throw new GuardError('document_check_failed','测量没有通过或待保存正文已变化；对这份正文重测后再保存');
 return {callId,textIdentity:entry.result.deliveryCheck.textIdentity};
}

// Requirements and semantic item boundaries are chosen by the Agent. This tool
// checks the entire declared draft, never infers a contract from keywords.
export function measureDelivery(args,{state,turnId}={}){
 const {text,unit,requirements,items,bodyText}=args;
 if(bodyText!==undefined)selectOriginal(text,bodyText);
 const count=countBody(bodyText??text,unit),issues=[];
 if(!requirements)return {count,unit};
 if(requirements.min!==undefined&&requirements.max!==undefined&&requirements.min>requirements.max)throw new GuardError('invalid_requirements','字数下限不能超过上限');
 let declared=[];
 if(state&&turnId){
  const results=new Map(state.records.filter(r=>r.kind==='tool_result'&&r.turnId===turnId).map(r=>[r.callId,r]));
  for(const call of state.records){
   if(call.kind!=='tool_call'||call.turnId!==turnId||call.name!=='measure_text')continue;
   try{const prior=JSON.parse(call.arguments),receipt=JSON.parse(results.get(call.callId)?.output);
    // A failed content check still declares valid constraints. Invalid arguments
    // and failed tool operations do not establish new constraints.
    if(receipt.ok&&receipt.deliveryCheck&&targetKey(prior)===targetKey(args)){
     if(prior.correction)declared=[];
     declared.push({...prior,callId:call.callId});
    }
   }catch{}
  }
 }
 if(args.correction){
  const c=args.correction,last=declared.at(-1);
  const original=state?.records.find(r=>r.id===c.messageId&&r.kind==='message'&&r.role==='user'&&r.turnId===turnId);
  if(!last||last.callId!==c.callId||!original||typeof original.content!=='string'||!c.reason?.trim())throw new GuardError('invalid_requirement_correction','纠正须指向同一成果的最新有效测量和本轮用户原话，并说明误解；不能用新目标绕过检查');
  selectOriginal(original.content,c.quote);
  declared=[];
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
 return {count,unit,deliveryCheck:{status:issues.length?'failed':'passed',issues:[...new Set(issues)],requirements,target:args.target||{kind:'reply'},assetId:args.assetId,assetVersion:args.assetVersion,correction:args.correction,effectiveChecks:{text:[...groups.values()],itemCounts:[...itemCounts]},bodyOnly:bodyText!==undefined,itemCount:items?.length,textIdentity:fingerprint(text),scope:'declared_constraints_on_exact_draft',semanticMeaningVerified:false}};
}

// Only a check explicitly made in this user turn governs its final response.
// Stored tool receipts are the evidence; no second state or mandatory audit call.
export function finalDeliveryCheck(state,turnId,text){
 const results=new Map(state.records.filter(r=>r.kind==='tool_result'&&r.turnId===turnId).map(r=>[r.callId,r]));
 const seen=new Set();
 const savedCalls=new Set(state.records.filter(r=>r.kind==='tool_call'&&r.turnId===turnId&&r.name==='save_document').map(r=>r.callId));
 const saved=[...results.values()].filter(r=>savedCalls.has(r.callId)).flatMap(r=>{try{const v=JSON.parse(r.output);return v.ok&&v.asset?.content!==undefined?[v.asset]:[];}catch{return [];}});
 for(const call of [...state.records].reverse()){
  if(call.kind!=='tool_call'||call.turnId!==turnId||call.name!=='measure_text')continue;
  let args,result;try{args=JSON.parse(call.arguments);result=JSON.parse(results.get(call.callId)?.output);}catch{continue;}
  if(!args.requirements)continue;
  const key=targetKey(args);if(seen.has(key))continue;seen.add(key);
  const check=result?.deliveryCheck||{status:'failed',issues:['measurement_failed'],requirements:args.requirements};
  if(args.assetId&&check.status==='passed'&&state.assets[args.assetId]?.version===args.assetVersion&&check.textIdentity===fingerprint(state.assets[args.assetId]?.content))continue;
  if(check.status==='passed'&&saved.some(a=>check.textIdentity===fingerprint(a.content)))continue;
  if(!args.assetId&&args.target?.kind!=='document'&&check.status==='passed'&&(args.target?.id?typeof args.text==='string'&&text.includes(args.text):check.textIdentity===fingerprint(text)))continue;
  return {ok:false,code:'delivery_check_failed',submitted:false,measurementCallId:call.callId,
   issues:[...check.issues,...(check.textIdentity!==fingerprint(text)?['final_text_changed_after_measurement']:[])],
   message:'这份回复正文尚未通过对应要求的验收。修正文并重测；若先前误解用户要求，用correction引用本轮原话明确纠正。不同作品使用各自target，保存文稿的检查不能约束状态说明。',requirements:check.requirements,effectiveChecks:check.effectiveChecks};
 }
 return null;
}
