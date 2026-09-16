import {createHash} from 'node:crypto';

const failure=(message,code='reference_selection')=>Object.assign(new Error(message),{code});
const digest=(message,sessionId)=>createHash('sha256').update(JSON.stringify([sessionId,message.messageId,message.role,message.replyTo||null,message.content])).digest('hex');

// Presentation is a read effect over typed persisted objects, not a production source.
// Legacy string targets resolve by exact membership only; no query text or ID-prefix routing.
export function resolvePresentationReference(target,{references,messages=[],sessionId='',binding}){
 const typed=typeof target==='object'&&target!==null;
 const id=typed?(target.type==='message'?target.messageId:target.artifactId):target;
 if(typeof id!=='string'||!id)throw failure('展示引用缺少合法对象标识');
 if(typed&&!['message','artifact'].includes(target.type))throw failure('展示引用对象类型不支持');
 const message=messages.find(m=>m.messageId===id);
 const artifact=references.resolveReference(id,{purpose:'history',required:false});
 const kind=typed?target.type:message&&artifact.artifactId?null:message?'message':'artifact';
 if(!kind)throw failure('展示引用同时匹配消息与产物，必须指定对象类型');
 if(binding?.referenceType&&binding.referenceType!==kind)throw failure('展示引用对象类型已变化','source_changed');
 if(binding?.sessionId&&binding.sessionId!==sessionId)throw failure('展示引用不属于当前会话','reference_unavailable');
 if(kind==='message'){
  if(!message)throw failure('历史消息锚点不存在于本会话');
  if(message.deleted||message.revoked||message.sessionId&&message.sessionId!==sessionId)throw failure('历史消息已撤销或不属于当前会话','reference_unavailable');
  const sourceHash=digest(message,sessionId);
  if(binding&&(binding.id!==id||binding.sourceHash!==sourceHash))throw failure('历史消息内容已变化，请重新确定范围','source_changed');
  return {binding:{id,messageId:id,referenceType:'message',type:'message',sessionId,sourceHash,purpose:'history',usable:true},entry:{...message,type:'message',id}};
 }
 if(binding&&binding.id!==artifact.artifactId)throw failure('展示产物绑定与目标不一致','source_changed');
 const resolved=references.resolveReference(id,{purpose:'history',binding});
 if(typed&&target.version!==undefined&&target.version!==resolved.version)throw failure('展示产物版本已变化','source_changed');
 return {binding:{...references.bind(id,{purpose:'history'}),referenceType:'artifact',sessionId},entry:resolved.source};
}
