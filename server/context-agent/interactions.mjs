import {GuardError,assetFor,newId} from './io-guard.mjs';

// Interaction state is a projection of immutable tool results and real user messages.
export function interactions(state){
 const calls=new Map(state.records.filter(r=>r.kind==='tool_call'&&r.name==='request_user_input').map(r=>[r.callId,r]));
 const items=new Map();
 for(const r of state.records){
  if(r.kind==='tool_result'&&calls.has(r.callId)){
   let result;try{result=JSON.parse(r.output);}catch{continue;}
   if(result.ok&&result.interaction)items.set(result.interaction.interactionId,{...result.interaction,answers:{},status:'pending'});
  }
  if(r.kind==='message'&&r.role==='user'&&r.interactionResponse){
   const answer=r.interactionResponse,item=items.get(answer.interactionId);if(!item)continue;
   item.answers={...item.answers,...answer.answers};
   item.status=answer.action==='submit'?(item.questions.every(q=>Object.hasOwn(item.answers,q.key))?'answered':'pending'):answer.action==='text'?'answered_in_text':answer.action;
   item.answerMessageId=r.id;
  }
 }
 return [...items.values()];
}
export function prepareInteraction(state,args){
 const keys=new Set();
 for(const q of args.questions){
  if(keys.has(q.key)||['constructor','prototype','__proto__'].includes(q.key))throw new GuardError('invalid_questions','问题key必须唯一且不能使用保留名称');keys.add(q.key);
  if(/api.?key|password|密码|密钥|支付凭据/i.test(q.key+' '+q.label))throw new GuardError('sensitive_input','问题表单不能收集密钥、密码或支付凭据');
  const ids=new Set();for(const o of q.options||[]){
   if(ids.has(o.id))throw new GuardError('invalid_questions','选项ID必须唯一');ids.add(o.id);
   if(o.resource){
    const ref=o.resource;
    if(ref.kind==='asset'){const asset=assetFor(state,ref.id);if(ref.version!==asset.version)throw new GuardError('invalid_selection','选项资产版本不一致');}
    else{const p=state.approvals[ref.id];if(!p||p.kind!=='proposal'||p.ownerId!==state.ownerId||p.sessionId!==state.id)throw new GuardError('invalid_selection','选项方案不可访问');}
   }
  }
  if(!q.allowFreeText&&!q.options?.length)throw new GuardError('invalid_questions','问题需要可选项或允许文字回答');
 }
 return {interactionId:newId('interaction'),message:args.message,questions:structuredClone(args.questions),grantsMediaApproval:false};
}
export function validateAnswer(state,response){
 if(!response||typeof response!=='object'||Array.isArray(response)||Object.keys(response).some(k=>!['interactionId','action','answers'].includes(k)))throw new GuardError('invalid_answer','回答格式无效');
 const item=interactions(state).find(x=>x.interactionId===response.interactionId);
 if(!item||item.status!=='pending')throw new GuardError('interaction_closed','问题不存在、已回答或已取消');
 if(!['submit','decline','cancel'].includes(response.action))throw new GuardError('invalid_answer','请选择提交、拒绝或取消');
 const answers=response.answers||{};
 if(typeof answers!=='object'||Array.isArray(answers))throw new GuardError('invalid_answer','回答必须是对象');
 if(response.action!=='submit'&&Object.keys(answers).length)throw new GuardError('invalid_answer','取消或拒绝不附带选项');
 for(const [key,a]of Object.entries(answers)){
  const q=item.questions.find(q=>q.key===key);
  if(!q||!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['optionId','text'].includes(k)))throw new GuardError('invalid_answer','未知问题或回答字段');
  if((a.optionId!==undefined)===(a.text!==undefined))throw new GuardError('invalid_answer','每题提交一个选项或文字');
  if(a.optionId!==undefined&&!q.options?.some(o=>o.id===a.optionId))throw new GuardError('invalid_answer','选项不属于发布的问题');
  if(a.text!==undefined&&(!q.allowFreeText||typeof a.text!=='string'||!a.text.trim()||a.text.length>2000))throw new GuardError('invalid_answer','自由回答不可用或超过长度');
 }
 if(response.action==='submit'&&!Object.keys(answers).length)throw new GuardError('invalid_answer','请至少回答一项');
 return {interactionId:item.interactionId,action:response.action,answers:structuredClone(answers)};
}

export function selectedAssets(state,ids=[]){
 if(!Array.isArray(ids)||ids.length>12||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'))throw new GuardError('invalid_selection','请选择最多12个不同素材');
 return ids.map(id=>{const a=assetFor(state,id);return {id:a.id,type:a.type,version:a.version};});
}

export function answerText(state,response){
 const item=interactions(state).find(i=>i.interactionId===response?.interactionId);
 if(!item)throw new GuardError('interaction_closed','问题不存在');
 if(response.action==='decline')return '暂不回答：'+item.message;
 if(response.action==='cancel')return '取消问题：'+item.message;
 return '回答问题：'+Object.entries(response.answers||{}).map(([key,a])=>{
  const q=item.questions.find(q=>q.key===key);return (q?.label||key)+'：'+(a?.text||q?.options?.find(o=>o.id===a?.optionId)?.label||'无效选项');
 }).join('；');
}
