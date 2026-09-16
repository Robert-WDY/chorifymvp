import {createHash} from 'node:crypto';
import {isAccepted} from './task-contract.mjs';
export const selectorSchema={oneOf:[
 {type:'object',additionalProperties:false,required:['type','artifactId','version','unitId'],properties:{type:{const:'unit'},artifactId:{type:'string'},version:{type:'integer',minimum:1},unitId:{type:'string'}}},
 {type:'object',additionalProperties:false,required:['type','artifactId','version'],properties:{type:{const:'artifact'},artifactId:{type:'string'},version:{type:'integer',minimum:1},ordinal:{type:'integer',minimum:1}}},
 {type:'object',additionalProperties:false,required:['type','sourceArtifactId','version','directionId','directionIndex'],properties:{type:{const:'direction'},sourceArtifactId:{type:'string',not:{pattern:'^task:\\d+$'}},version:{type:'integer',minimum:1},directionId:{type:'string'},directionIndex:{type:'integer',minimum:1}}},
 {type:'object',additionalProperties:false,required:['type','sourceArtifactId','version','shotId'],properties:{type:{const:'shot'},sourceArtifactId:{type:'string',not:{pattern:'^task:\\d+$'}},version:{type:'integer',minimum:1},shotId:{type:'string'}}},
 {type:'object',additionalProperties:false,required:['type','sourceArtifactId','directionIndex'],properties:{type:{const:'direction'},sourceArtifactId:{type:'string',pattern:'^task:\\d+$'},directionIndex:{type:'integer',minimum:1},version:{type:'integer',minimum:1},directionId:{type:'string'}}},
 {type:'object',additionalProperties:false,required:['type','sourceArtifactId','shotIndex'],properties:{type:{const:'shot'},sourceArtifactId:{type:'string',pattern:'^task:\\d+$'},shotIndex:{type:'integer',minimum:1}}}
]};
export const sourceDigest = source => createHash('sha256').update(JSON.stringify({id:source.id||source.assetId,version:source.version||1,content:source.content,structure:source.metadata?.structure||source.structure,url:source.url})).digest('hex');
export function referenceInventory({taskCandidates=[],taskSnapshot,assets=[]}={}){
 const entries=new Map();
 for(const s of [...taskCandidates.flatMap(t=>t.artifacts||[]),...(taskSnapshot?.artifacts||[]),...assets]){
  const id=s.id||s.assetId||s.url;if(!id)continue;
  // Full durable artifact wins over a media projection or excerpt.
  if(!entries.has(id))entries.set(id,s);
 }
 return [...entries.values()];
}
export class ReferenceCatalog{
 expand(refs=[]){return refs.flatMap(ref=>{const parts=ref.split(/[,，]/).map(s=>s.trim());return parts.length>1&&parts.every(r=>this.entries.some(e=>e.id===r||e.handle===r))?parts:[ref];});}
 constructor(inventory,{scope='',epoch=''}={}){
  this.inventory=referenceInventory({assets:inventory.filter(s=>!s.sessionId||!scope||s.sessionId===scope)});
  this.version=createHash('sha256').update(JSON.stringify([scope,epoch,this.inventory.map(s=>[s.id||s.assetId,sourceDigest(s)])])).digest('hex').slice(0,12);
  this.entries=this.inventory.map((s,i)=>({handle:'ref_'+this.version+'_'+i,id:s.id||s.assetId||s.url,version:s.version||1,type:s.type||s.kind,filename:s.filename,purpose:s.purpose,taskId:s.taskId,sourceMessageId:s.sourceMessageId,sourceHash:sourceDigest(s),readable:!s.revoked&&!s.deleted,productionUsable:!s.revoked&&!s.deleted&&!['superseded','audit'].includes(s.publication)&&(!s.verification&&!s.taskId||isAccepted(s)),excerpt:s.content?.slice(0,160)}));
  for(const type of ['image','video','text','audio']){
   const visible=this.entries.filter((e,i)=>e.type===type&&e.productionUsable&&this.inventory[i].purpose!=='support'&&!this.inventory[i].metadata?.facts);
   visible.forEach((e,i)=>e.visibleOrdinal=i+1);
  }
 }
 view(role){return this.entries.filter(e=>role==='image_target'?e.type==='image'&&e.productionUsable&&e.visibleOrdinal:role==='artifact_inventory'?!!e.visibleOrdinal:role==='production'?e.productionUsable:e.readable);}
 resolveReference(ref,{purpose='production',binding,bindings=[],required=true}={}){
  if(typeof ref!=='string')throw Object.assign(new Error('引用必须是对象句柄'),{code:'reference_selection',status:'not_found'});
  const plain=ref.replace(/^(artifact|asset|artifactId|assetId):/,'');
  const taskId=ref.startsWith('task:')?ref.slice(5):null;
  const taskMatches=taskId?this.entries.filter((e,n)=>this.inventory[n].taskId===taskId&&e.productionUsable):[];
  if(taskId&&taskMatches.length!==1)throw Object.assign(new Error('任务来源没有唯一的已接受产物：'+ref),{code:'reference_selection',status:taskMatches.length?'ambiguous':'not_found'});
  const i=this.entries.findIndex((e,n)=>e.handle===ref||e.id===plain||this.inventory[n].url===ref||e===taskMatches[0]);
  if(i<0){const result={artifactId:null,version:null,sourceHash:null,status:'not_found',relation:null,usable:false};if(!required)return result;throw Object.assign(new Error('源素材引用ID不存在或引用句柄已过期：'+ref),{code:'reference_selection',discardDraft:true,reference:ref,...result});}
  const entry=this.entries[i],source=this.inventory[i];
  binding??=bindings.find(b=>b.id===entry.id||b.artifactId===entry.id);
  purpose=binding?.purpose||purpose;
  const status=!entry.readable?'unavailable':source.publication==='superseded'?'superseded':!entry.productionUsable?'not_production_usable':'usable';
  const result={artifactId:entry.id,version:entry.version,sourceHash:entry.sourceHash,status,relation:source.parentId?'revision_of':source.taskId?'task_artifact':'user_input',usable:entry.readable&&(purpose!=='production'||entry.productionUsable)};
  if(!result.usable&&required)throw Object.assign(new Error((!entry.readable?'引用已撤销或内容已删除：':'所选源素材尚未通过验收或已被替代：')+ref),{code:'reference_unavailable',discardDraft:true,...result});
  if(result.usable)verifyReferenceBinding(source,binding);
  return {...result,purpose,entry,source};
 }
 // Compatibility API delegates to the same resolver; there is no second pool.
 select(ref,options){return this.resolveReference(ref,options);}
 bind(ref,options){const r=this.resolveReference(ref,options);return {id:r.artifactId,artifactId:r.artifactId,type:r.entry.type,version:r.version,sourceHash:r.sourceHash,status:r.status,relation:r.relation,usable:r.usable,purpose:options?.purpose||'production',catalogVersion:this.version};}
}
export function verifyReferenceBinding(source,binding){
 if(!binding)return;
 if((source.version||1)!==binding.version||sourceDigest(source)!==binding.sourceHash)throw Object.assign(new Error('来源版本或内容已变化，请重新确定范围：'+binding.id),{code:'source_changed'});
 if(source.revoked||source.deleted)throw Object.assign(new Error('来源权限或可用性已变化：'+binding.id),{code:'reference_unavailable'});
}
