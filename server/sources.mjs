import {ReferenceCatalog} from './reference-catalog.mjs';
import {isAccepted} from './task-contract.mjs';
import {validationTrace} from './trace-context.mjs';
export function resolveTaskReferenceAliases(references,snapshot){
 return references.map(ref=>{
  const m=/^task:([a-f0-9-]{36}):(\d+)$/.exec(ref);if(!m||m[1]!==snapshot?.id)return ref;
  const item=snapshot.items?.[Number(m[2])];const matches=(snapshot.artifacts||[]).filter(a=>a.itemId===item?.id&&isAccepted(a));
  if(matches.length!==1)throw new Error('任务槽位引用没有唯一的已接受产物，不能猜测来源');
  validationTrace({phase:'resolve_reference_alias',from:ref,to:matches[0].id,version:matches[0].version});return matches[0].id;
 });
}
// Verification follows the inputs actually submitted to the media tool. Other
// dependency artifacts may be useful for planning, but are not reference images.
export function verificationSources(state,item,artifact){
 const submitted=artifact.metadata?.args?.referenceImages;
 const references=submitted?.length?submitted:item.references?.length?item.references:artifact.parentId?[artifact.parentId]:[];
 const sources=resolveSources(state,item,{taskId:artifact.taskId,references,allowUnaccepted:true});
 return sources.filter(s=>s.type==='image'&&s.url&&s.id!==artifact.id&&(!submitted?.length||submitted.includes(s.url)||submitted.includes(s.id)));
}
// Resolve references only within the session. Content is data, never instructions.
export function usableReferences(references,inventory){
 const catalog=new ReferenceCatalog(inventory);
 return [...new Set(references.map(ref=>/^task:\d+$/.test(ref)?ref:catalog.resolveReference(ref).artifactId))];
}
export function canonicalReferences(references,inventory){
 const catalog=new ReferenceCatalog(inventory);
 return [...new Set(references.map(ref=>/^task:\d+$/.test(ref)?ref:catalog.resolveReference(ref,{purpose:'history'}).artifactId))];
}
export function resolveSupportingSources(state,item){
 return resolveSources(state,item,{references:item.supportingSources||[],bindings:item.supportingSourceBindings||[],allowUnaccepted:true,includeDependencies:false});
}
export function resolveSources(state, item, {taskId, references = item.references || [],bindings=item.referenceBindings||[],allowUnaccepted=false,includeDependencies=true} = {}) {
  const store = state.taskStore || {};
  const task = store.tasks?.[taskId || store.activeTaskId];
  const artifacts = Object.values(store.artifacts || {});
  const inputs = [...Object.values(store.inputs || {}), ...(state.assets || [])];
  const sources = new Map();
  const catalog=new ReferenceCatalog([...artifacts,...inputs],{scope:state.id});
  const add = (source,dependencyIndex) => {
    const id = source.id || source.assetId || source.url;
    sources.set(id, {
      id, type: source.type || source.kind, content: source.content, url: source.url,
      version: source.version, taskId: source.taskId, structure:source.metadata?.document?.kind==='content'?undefined:source.metadata?.structure,provenance:{origin:source.taskId?'model_artifact':'user_input',factualSupport:source.acceptance?.factualSupport||'not_checked',sourceTaskId:source.taskId},relation:source.taskId?'accepted_artifact':'user_input',role:source.type||source.kind,
      ...(dependencyIndex!==undefined?{dependencyIndex}:{}),
      ...(source.metadata?.factBoundary?{factBoundary:structuredClone(source.metadata.factBoundary)}:{}),
    });
  };
  const dependency = index => {
    const itemId = task?.items[index]?.id;
    return artifacts.filter(a => a.itemId === itemId && a.taskId === task?.id)
      .map(a=>catalog.resolveReference(a.id,{required:false})).filter(r=>r.usable).map(r=>r.source);
  };
  for (const ref of references) {
    if (/^task:\d+$/.test(ref)) {
      const index = Number(ref.slice(5));
      if (!(item.dependsOn || []).includes(index)) throw new Error('素材引用未声明前序依赖：' + ref);
      const matches = dependency(index);
      if (!matches.length) throw new Error('前序素材尚未完成：' + ref);
      matches.forEach(source=>add(source,index));
    } else {
      const {source}=catalog.resolveReference(ref,{purpose:allowUnaccepted?'history':'production',bindings});
      add(source);
    }
  }
  if(includeDependencies)for (const index of item.dependsOn || []) dependency(index).forEach(source=>add(source,index));
  return [...sources.values()];
}
