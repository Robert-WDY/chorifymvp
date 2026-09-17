import {createSession,appendRecord} from './history.mjs';
import {createHash} from 'node:crypto';
const text=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(p=>['text','input_text','output_text'].includes(p.type)).map(p=>p.text||'').join('\n'):'';
/** One-time data adaptation only. Original tasks, receipts and approvals stay in the archive. */
export function importLegacySession(original,sourceHash){
 const state=createSession({id:original.id});
 if(!Array.isArray(original.messages)||(!original.taskStore&&!Array.isArray(original.events)))throw new Error('Not a legacy MVP session');
 for(const [i,message]of original.messages.entries())if(['user','assistant'].includes(message.role)){
  const content=text(message.content);if(!content)continue;
  const id=message.id||'legacy_'+createHash('sha256').update(state.id+':message:'+i).digest('hex').slice(0,32);
  appendRecord(state,{kind:'message',id,role:message.role,content,at:message.at||original.turns?.[0]?.createdAt||'1970-01-01T00:00:00.000Z'});
 }
 const artifacts=Object.values(original.taskStore?.artifacts||{});
 for(const item of artifacts){
  if(item.status!=='completed')continue;
  const type=typeof item.content==='string'?'text':item.type;
  if(!['text','image','video'].includes(type)||(!item.content&&!item.url))continue;
  state.assets[item.id]={...item,type,ownerId:'local',origin:'legacy_import',name:item.title||item.name||'历史成果',sourceIds:item.sourceIds||[],version:item.version||1};
 }
 for(const item of original.deliverables||[]){if(!item.id||state.assets[item.id]||typeof item.content!=='string')continue;state.assets[item.id]={...item,type:'text',ownerId:'local',origin:'legacy_import',name:item.title||'历史文稿',sourceIds:item.sourceIds||[],version:item.version||1};}
 for(const item of original.assets||[]){const id=item.id||item.assetId;if(!id||state.assets[id]||!['text','image','video'].includes(item.type||item.kind))continue;
  state.assets[id]={...item,id,type:item.type||item.kind,ownerId:'local',origin:'legacy_import',name:item.name||'历史素材',version:item.version||1,sourceIds:item.sourceIds||[]};
 }
 appendRecord(state,{kind:'run_event',event:'legacy_import',sourceHash,originalSessionId:original.id});
 appendRecord(state,{kind:'system_observation',name:'history_migration',source:{kind:'legacy_archive',sessionId:original.id},output:JSON.stringify({ok:true,note:'已迁入旧MVP原始对话及已完成素材。旧任务、批准、回执和全部Trace保留在原始存档；不代表当前工具能力或新的执行授权，未完成媒体不可自动重提。历史成果是否满足当前要求由Agent根据原文判断。'})});
 return state;
}
