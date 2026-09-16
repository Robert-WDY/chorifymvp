import {createHash} from 'node:crypto';
import {validationTrace} from './trace-context.mjs';
import {sourceDigest} from './reference-catalog.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function relatedCurrentDocuments(references,selected){
 const text=references.inventory.filter(a=>a.type==='text'&&a.purpose==='deliverable'&&a.publication==='current'&&!a.metadata?.facts);
 const ids=new Set(selected),tasks=new Set(text.filter(a=>ids.has(a.id)).map(a=>a.taskId));let changed=true;
 while(changed){changed=false;for(const a of text){if(ids.has(a.id)||tasks.has(a.taskId)||(a.relationships||[]).some(r=>ids.has(r.artifactId))||text.filter(t=>ids.has(t.id)).some(t=>(t.relationships||[]).some(r=>r.artifactId===a.id))){if(!ids.has(a.id)){ids.add(a.id);tasks.add(a.taskId);changed=true;}}}}
 return text.filter(a=>ids.has(a.id));
}
// Expand target sets before routing. Single-source delta execution stays strict.
export function expandChangeSets(semantic,references,mapping=new Map()){
 const expanded=[];
 for(const [index,d] of semantic.deliverables.entries()){
  const mapped=[];
  const targets=d.businessOperation==='modify'&&d.kind==='text'?(d.references||[]).filter(r=>!/^task:\d+$/.test(r)).map(r=>references.select(r,{purpose:'history'}).source):[];
  if(targets.length&&targets.some(s=>s.type!=='text'||!s.content))throw Object.assign(new Error('文字修改目标必须是有原文的文档；辅助材料放 supportingSources'),{code:'reference_type',issues:[{path:'/deliverables/'+index+'/references'}]});
  const outputs=targets.length?targets.map(s=>{
   const id=s.id||s.assetId;
   const structure=s.metadata?.structure||{},spec={...d.spec};
   if(targets.length>1&&!structure.shots){for(const k of ['shotCount','secondsPerShot','durationSeconds'])delete spec[k];}
   return {...structuredClone(d),spec,references:[id],referenceBindings:(d.referenceBindings||[]).filter(b=>b.id===id),count:1,artifactCount:1,contentCardinality:1,
    changeContract:{...d.changeContract,source:{id,version:s.version||1,contentHash:hash(s.content),sourceHash:sourceDigest(s)},groupId:'change_'+hash(JSON.stringify([semantic.summary,index,targets.map(t=>t.id)])).slice(0,16),allowNoChange:true},
    requiredMethods:d.requiredMethods||[],executionShape:'direct'};
  }):[d];
  // Remap dependencies to every resulting target, never just the first document.
  for(const out of outputs){out.dependsOn=[...new Set((d.dependsOn||[]).flatMap(n=>mapping.get(n)||[]))];out.references=(out.references||[]).flatMap(r=>/^task:\d+$/.test(r)?(mapping.get(Number(r.slice(5)))||[]).map(n=>'task:'+n):[r]);
   const existing=out.changeContract?.source?expanded.findIndex(e=>e.changeContract?.source?.id===out.changeContract.source.id&&e.changeContract.request===out.changeContract.request):-1;
   if(existing>=0){const old=expanded[existing];if(JSON.stringify(old.spec)!==JSON.stringify(out.spec))throw new Error('同一对象重复修订的规格冲突，必须重新确定范围');old.constraints=[...new Set([...(old.constraints||[]),...(out.constraints||[])])];old.supportingSources=[...new Set([...(old.supportingSources||[]),...(out.supportingSources||[])])];mapped.push(existing);}
   else{mapped.push(expanded.length);expanded.push(out);}
  }
  mapping.set(index,[...new Set(mapped)]);
  if(targets.length>1)validationTrace({phase:'expand_change_set',originalIndex:index,targets:outputs.map(o=>o.changeContract.source),request:d.changeContract.request});
 }
 for(const d of expanded.filter(d=>d.changeContract?.source)){const peers=expanded.filter(p=>p.changeContract?.request===d.changeContract.request);d.changeContract.groupId='change_'+hash(JSON.stringify([d.changeContract.request,peers.map(p=>p.changeContract.source.id)])).slice(0,16);}
 semantic.deliverables=expanded;return semantic;
}
export function assertDeltaCurrent(state,contract){
 if(!contract?.source)return;
 const s=state.taskStore.artifacts[contract.source.id]||state.taskStore.inputs?.[contract.source.id];
 if(!s||s.publication==='superseded'||(s.version||1)!==contract.source.version||hash(s.content)!==contract.source.contentHash||contract.source.sourceHash&&sourceDigest(s)!==contract.source.sourceHash||s.revoked||s.deleted)throw new Error('修改源版本已变化，必须重新绑定，不能覆盖旧版本');
}
export function recordChange(task,item,update){
 if(!item.changeContract?.groupId)return;
 task.changeSets??={};const group=task.changeSets[item.changeContract.groupId]??={request:item.changeContract.request,targets:{}};
 group.targets[item.changeContract.source.id]={source:item.changeContract.source,itemId:item.id,...group.targets[item.changeContract.source.id],...update};
 group.status=Object.values(group.targets).every(t=>['published','no_change'].includes(t.status))?'completed':Object.values(group.targets).some(t=>['published','no_change'].includes(t.status))?'partial':'pending';
}
