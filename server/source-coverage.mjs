import {createHash} from 'node:crypto';
import {validationTrace} from './trace-context.mjs';
import {sourceDigest} from './reference-catalog.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Version and content qualify an index: reordering a legacy document invalidates
// the binding rather than silently changing the selected object.
export function sourceUnits(source){
 const structure=source.metadata?.structure||source.structure;
 if(!structure)return [];
 const fields=['shots','directions','products'];
 return fields.flatMap(field=>Array.isArray(structure[field])?structure[field].map((value,index)=>({
  id:(source.id||source.assetId)+':v'+(source.version||1)+':'+field+':'+index+':'+hash(value).slice(0,12),
  type:field,index:index+1,value
 })):[]);
}
export const coverageSelectionSchema={type:'object',additionalProperties:false,required:['source','unitType','mode','layout'],properties:{
 source:{type:'string'},unitType:{enum:['shots','directions','products']},mode:{enum:['all','selected']},
 unitIds:{type:'array',items:{type:'string'},uniqueItems:true},layout:{enum:['separate_images','storyboard_sheet','unspecified']},
 unitIndexes:{type:'array',minItems:1,uniqueItems:true,items:{type:'integer',minimum:1}},
 evidence:{type:'string'}
}};
const futureSource=ref=>/^task:\d+$/.test(ref||'');
const selectionError=(message,field='sourceSelection')=>Object.assign(new Error(message),{code:'reference_contract',selectionField:field});
// A future reference describes a producer and ordinal intent, never a fabricated
// artifact identity. All compatibility expressions converge before binding.
export function normalizeFutureSelection(d,peers=[]){
 const selector=d.selector,ref=selector?.sourceArtifactId||selector?.artifactId;
 if(futureSource(ref)){
  const index=selector.type==='direction'?selector.directionIndex:selector.type==='shot'?selector.shotIndex:undefined;
  if(!Number.isInteger(index)||index<1)throw selectionError('未来来源只声明方向/镜头序号；使用 sourceSelection.unitIndexes，不填写尚未产生的单元ID或版本','selector');
  if(d.sourceSelection)throw selectionError('不能同时声明两个内容选择来源','selector');
  d.sourceSelection={source:ref,unitType:selector.type==='direction'?'directions':'shots',mode:'selected',unitIndexes:[index],layout:d.kind==='image'&&d.action==='create'&&d.count===1?'separate_images':'unspecified'};
  if(selector.version!==undefined||selector.directionId!==undefined||selector.shotId!==undefined)validationTrace({phase:'future_selector_projection',source:ref,reason:'未来来源的旧占位ID及版本不作为绑定依据；执行时读取真实身份',ignoredFields:['version','directionId','shotId'].filter(k=>selector[k]!==undefined)});
  delete d.selector;
 }
 if(!d.sourceSelection&&d.spec?.selectedDirectionIndex){
  const refs=[...new Set([...(d.references||[]),...(d.supportingSources||[])].filter(futureSource))];
  if(refs.length>1)throw selectionError('多个未来来源不能只用方向序号；请通过 sourceSelection.source 指明上游');
  if(refs.length===1)d.sourceSelection={source:refs[0],unitType:'directions',mode:'selected',unitIndexes:[d.spec.selectedDirectionIndex],layout:d.kind==='image'&&d.action==='create'&&d.count===1?'separate_images':'unspecified'};
 }
 const s=d.sourceSelection;if(!s)return;
 if(!futureSource(s.source)){if(s.unitIndexes)throw selectionError('已有来源须绑定真实单元ID及版本；unitIndexes仅用于本轮未来来源');return;}
 const index=Number(s.source.slice(5)),owner=peers.indexOf(d),producer=peers[index];
 const refs=[...(d.references||[]),...(d.supportingSources||[])];
 if(!(d.dependsOn||[]).includes(index)||!refs.includes(s.source)||!producer||owner>=0&&index>=owner)throw selectionError('未来来源必须绑定本轮已声明的前序交付、来源引用和依赖，不能引用自身或后序任务');
 if(producer.kind!=='text')throw selectionError('未来内容单元选择必须指向文字结构产物，不能把图片当方向或镜头文档');
 if(s.unitIds?.length)throw selectionError('未来来源尚无真实单元ID；保留上游与所选范围，用 unitIndexes 表达序号');
 if(s.mode==='selected'&&(!s.unitIndexes?.length||s.unitIndexes.some(n=>!Number.isInteger(n)||n<1)||new Set(s.unitIndexes).size!==s.unitIndexes.length))throw selectionError('未来局部选择必须提供不重复的正整数 unitIndexes');
 if(s.mode==='all'&&s.unitIndexes?.length)throw selectionError('全部单元与局部序号不能同时声明');
 const count=s.unitType==='directions'?producer.spec?.directionCount:s.unitType==='shots'?producer.spec?.shotCount:undefined;
 if(count&&s.unitIndexes?.some(n=>n>count))throw selectionError('选择序号超出上游已声明的单元数量');
 if(d.spec?.selectedDirectionIndex!==undefined&&(s.unitType!=='directions'||s.mode!=='selected'||s.unitIndexes.length!==1||s.unitIndexes[0]!==d.spec.selectedDirectionIndex))throw selectionError('方向序号与类型化来源选择冲突');
 d.selectionRole='consumer';
}
// Resolve every consumer's selection, not just image generation coverage.
export function bindSourceSelection(deliverable,catalog){
 const imageEdit=deliverable.kind==='image'&&deliverable.action==='modify';
 const boundSources=[...(deliverable.references||[]),...(imageEdit?deliverable.supportingSources||[]:[])];
 let selector=deliverable.selector;
 if(selector?.type==='unit'){
  const resolved=catalog.resolveReference(selector.artifactId,{purpose:'history'}),unit=sourceUnits(resolved.source).find(u=>u.id===selector.unitId);
  if(resolved.version!==selector.version||!unit)throw new Error('内容单元或版本不匹配');
  if(!['directions','shots'].includes(unit.type))throw new Error('该类型单元暂不支持单项选择');
  selector=deliverable.selector=unit.type==='directions'?{type:'direction',sourceArtifactId:resolved.artifactId,version:resolved.version,directionId:unit.id,directionIndex:unit.index}:{type:'shot',sourceArtifactId:resolved.artifactId,version:resolved.version,shotId:unit.id};
 }
 if(selector){
  const r=catalog.resolveReference(selector.artifactId||selector.sourceArtifactId,{purpose:'history'});
  if(r.version!==selector.version||!boundSources.includes(r.artifactId))throw new Error('选择对象或版本与引用不一致');
  if(selector.type==='artifact'){
   if(selector.ordinal!==undefined&&selector.ordinal!==r.entry.visibleOrdinal)throw new Error('图片序号与绑定对象不一致');
   if(deliverable.kind==='image'&&r.entry.type!=='image')throw new Error('图片编辑必须使用图片对象选择器');
   if(deliverable.sourceSelection){
    const supportRef=deliverable.sourceSelection.source,supportId=futureSource(supportRef)?supportRef:catalog.resolveReference(supportRef,{purpose:'history'}).artifactId;
    if(!imageEdit||supportId===r.artifactId||!(deliverable.supportingSources||[]).includes(supportId))throw new Error('对象选择器与单元选择器不能同时声明');
   }else{deliverable.selectorBinding={...selector,artifactId:r.artifactId,sourceHash:r.sourceHash};return;}
  }else{
   if(imageEdit&&!['text','prompt'].includes(r.entry.type))throw new Error('图片编辑的内容单元必须来自真实文字辅助来源');
   const selection={source:r.artifactId,unitType:selector.type==='direction'?'directions':'shots',mode:'selected',unitIds:[selector.directionId||selector.shotId],layout:'unspecified'};
   if(deliverable.sourceSelection)throw new Error('不能同时声明两个单元选择来源');
   deliverable.sourceSelection=selection;
  }
 }
 const selection=deliverable.sourceSelection;
 if(!selection||/^task:\d+$/.test(selection.source))return;
 const resolved=catalog.resolveReference(selection.source,{purpose:'history'}),source=resolved.source;
 if(!boundSources.includes(resolved.artifactId))throw new Error('选择来源必须是本项已绑定的引用');
 const units=sourceUnits(source).filter(u=>u.type===selection.unitType);
 if(!units.length)throw new Error('来源没有指定类型的内容单元：'+selection.unitType);
 const selected=selection.mode==='all'?units:(selection.unitIds||[]).map(id=>{
  const matches=units.filter(u=>u.id===id||u.value?.id===id);
  if(matches.length!==1)throw new Error('选择范围包含未知或不唯一的来源单元：'+id);
  return matches[0];
 });
 if(!selected.length||new Set(selected.map(u=>u.id)).size!==selected.length)throw new Error('选择范围包含重复或缺失的来源单元');
 selection.source=resolved.artifactId;selection.unitIds=selected.map(u=>u.id);
 deliverable.selectorBinding={type:selection.unitType==='directions'?'direction':selection.unitType==='shots'?'shot':'product',sourceId:resolved.artifactId,sourceArtifactId:resolved.artifactId,version:resolved.version,sourceHash:resolved.sourceHash,unitIds:selected.map(u=>u.id),indexes:selected.map(u=>u.index)};
 if(selected.length===1)Object.assign(deliverable.selectorBinding,{unitId:selected[0].id,index:selected[0].index,...(selection.unitType==='directions'?{directionId:selected[0].id,directionIndex:selected[0].index}:selection.unitType==='shots'?{shotId:selected[0].id}:{})});
 if(selector?.type==='direction'&&selector.directionIndex!==selected[0].index)throw new Error('方向序号与绑定单元不一致');
 deliverable.selectionRole='consumer';
 if(deliverable.kind==='image'&&selection.unitType!=='directions'){for(const key of ['directionCount','selectedDirectionIndex']){if(deliverable.spec)delete deliverable.spec[key];if(deliverable.specOrigins)delete deliverable.specOrigins[key];}}
 if(deliverable.spec?.selectedDirectionIndex!==undefined&&(selection.unitType!=='directions'||selected.length!==1||deliverable.spec.selectedDirectionIndex!==selected[0].index))throw new Error('方向序号与类型化来源选择冲突');
}
export function bindCoverage(deliverable,catalog,query,peers=[]){
 try{normalizeFutureSelection(deliverable,peers);bindSourceSelection(deliverable,catalog);}catch(error){
  const index=peers.indexOf(deliverable);if(error.selectionField&&index>=0)error.issues=[{path:`/deliverables/${index}/${error.selectionField}`}];throw error;
 }
 delete deliverable.coverage;
 if(deliverable.kind!=='image'||deliverable.action!=='create')return;
 if(/^task:\d+$/.test(deliverable.sourceSelection?.source||'')){
  const selection=deliverable.sourceSelection,index=Number(selection.source.slice(5));
  if(!deliverable.dependsOn.includes(index)||!deliverable.references.includes(selection.source)||!peers[index])throw new Error('未来来源必须绑定已声明的上游交付');
  if(selection.layout==='unspecified')return '请确定上游产物按单元独立出图还是一张整版图。';
  const selectedCount=selection.mode==='selected'?selection.unitIndexes.length:selection.unitType==='directions'?peers[index].spec?.directionCount:selection.unitType==='shots'?peers[index].spec?.shotCount:undefined;
  if(selectedCount&&deliverable.count!==(selection.layout==='storyboard_sheet'?1:selectedCount))throw selectionError('选择范围与已声明的图片数量不一致，不能改变数量来通过校验');
  return;
 }
 const sources=(deliverable.references||[]).filter(r=>!/^task:\d+$/.test(r)).map(r=>catalog.select(r,{purpose:deliverable.action==='respond'?'history':'production'}).source);
 if(deliverable.kind!=='image'||deliverable.action!=='create')return;
 const candidates=sources.filter(s=>sourceUnits(s).length);
 if(!candidates.length)return;
 const selection=deliverable.sourceSelection;
 if(!selection||selection.layout==='unspecified')return '请确定来源内容的出图范围及形式：每个单元单独一张，还是一张包含全部单元的整版图；也可以指定只生成哪些单元。';
 const selected=catalog.select(selection.source).source;
 if(!sources.includes(selected))throw new Error('覆盖来源必须是本项已绑定的引用');
 const all=sourceUnits(selected).filter(u=>u.type===selection.unitType);
 if(!all.length)throw new Error('来源没有指定类型的内容单元');
 const ids=selection.mode==='all'?all.map(u=>u.id):selection.unitIds||[];
 if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!all.some(u=>u.id===id)))throw new Error('选择范围包含未知、重复或缺失的来源单元');
 if(selection.mode==='selected'){
  const evidence=selection.evidence?.trim()||deliverable.requestEvidence?.trim()||query;
  if(!evidence||!query.includes(evidence))throw new Error('局部选择必须有用户原话依据');
  selection.evidence=evidence;
 }

 const group=peers.filter(d=>d.kind==='image'&&d.action==='create'&&d.sourceSelection?.source===selection.source&&d.sourceSelection?.unitType===selection.unitType&&d.sourceSelection?.layout==='separate_images');
 if(group.length>1){const union=group.flatMap(d=>d.sourceSelection.mode==='all'?all.map(u=>u.id):d.sourceSelection.unitIds||[]);if(new Set(union).size!==union.length)throw new Error('独立交付的来源单元覆盖重复；请明确划分范围或使用同一交付的变体数量');}
 const fileCount=selection.layout==='separate_images'?ids.length:1;
 deliverable.coverage={source:{artifactId:selected.id||selected.assetId,version:selected.version||1,unitsHash:hash(all)},unitType:selection.unitType,unitIds:ids,layout:selection.layout,fileCount};
 deliverable.count=fileCount;deliverable.artifactCount=fileCount;deliverable.contentCardinality=ids.length;
 // A bound media source is an input, not an obligation to produce new directions.
 if(selection.unitType!=='directions'){
  const removed={};for(const key of ['directionCount','selectedDirectionIndex'])if(deliverable.spec?.[key]!==undefined){removed[key]=deliverable.spec[key];delete deliverable.spec[key];if(deliverable.specOrigins)delete deliverable.specOrigins[key];}
  if(Object.keys(removed).length)validationTrace({phase:'source_spec_applicability',removed,unitType:selection.unitType,reason:'来源单元已绑定，当前请求无方向创作义务'});
 }
}
export function assertCoverageSource(item,sources){
 const c=item.coverage||item.resolvedCoverage;if(!c)return;
 const s=sources.find(s=>s.id===c.source.artifactId);
 if(!s||(s.version||1)!==c.source.version||hash(sourceUnits(s).filter(u=>u.type===c.unitType))!==c.source.unitsHash)throw new Error('覆盖来源版本或内容已变化，旧计划不可继续');
}
export function coverageAssignments(item,sources,artifacts=[],options={}){
 if(!item.coverage&&!item.resolvedCoverage)return null;
 assertCoverageSource(item,sources);
 const c=item.coverage||item.resolvedCoverage,done=new Set(coverageStatus(item,artifacts,options).covered);
 const remaining=c.unitIds.filter(id=>!done.has(id));
 return (c.layout==='separate_images'?remaining.map(id=>[id]):remaining.length?[c.unitIds]:[]).map(ids=>({source:c.source,unitIds:ids,layout:c.layout}));
}
export function coverageStatus(item,artifacts,{mode='production'}={}){
 const c=item.coverage||item.resolvedCoverage;if(!c)return {required:[],covered:[],missing:[],complete:!(item.output==='image'&&item.operation==='generate_image'&&item.sourceSelection)};
 const covered=new Set();
 for(const a of artifacts){
  const simulated=mode==='simulation'&&a.metadata?.simulated&&a.verification?.semantic==='simulated_passed'&&a.testEvidence?.checker==='test_stub'&&a.testEvidence?.scope==='receipt_mapping';
  const binding=a.metadata?.coverage,verdict=simulated?a.testEvidence.coverage:a.acceptance?.quality?.coverage;
  if(a.purpose!=='deliverable'||a.verification?.technical!=='passed'||!simulated&&(a.verification?.semantic!=='passed'||a.metadata?.simulated)||['superseded','audit'].includes(a.publication))continue;
  if(!binding||JSON.stringify(binding.source)!==JSON.stringify(c.source)||!verdict?.passed)continue;
  // Actual content judge must have checked the same immutable assignment.
  if(JSON.stringify(verdict.unitIds)!==JSON.stringify(binding.unitIds))continue;
  if(c.layout==='separate_images'&&binding.unitIds.length!==1)continue;
  if(c.layout==='storyboard_sheet'&&JSON.stringify(binding.unitIds)!==JSON.stringify(c.unitIds))continue;
  for(const id of binding.unitIds)if(c.unitIds.includes(id))covered.add(id);
 }
 const missing=c.unitIds.filter(id=>!covered.has(id));
 return {required:c.unitIds,covered:[...covered],missing,complete:missing.length===0};
}

// Project immutable requirements and checked receipts; never treat count as coverage.
export function requirementCoverage(item,artifacts,options={}){
 const c=item.coverage||item.resolvedCoverage,progress=coverageStatus(item,artifacts,options);
 if(!c)return item.output==='image'&&item.sourceSelection?[{requirementId:item.id+':source_units',source:item.sourceSelection,expected:'resolved source unit coverage',actual:[],status:'pending'}]:[];
 return c.unitIds.map(id=>({requirementId:item.id+':unit:'+id,source:{...c.source,unitId:id},expected:{unitId:id,layout:c.layout},actual:progress.covered.includes(id)?[id]:[],status:progress.covered.includes(id)?'completed':'pending'}));
}
export function resolveDeferredSelection(item,sources){
 const selection=item.sourceSelection;if(!futureSource(selection?.source))return null;
 const index=Number(selection.source.slice(5));
 // Runtime projections identify the exact producer. Type-only fallback supports
 // older standalone callers, never a tagged collection containing other tasks.
 const tagged=sources.some(s=>s.dependencyIndex!==undefined);
 const candidates=sources.filter(s=>(!tagged||s.dependencyIndex===index)&&sourceUnits(s).some(u=>u.type===selection.unitType));
 if(candidates.length!==1)throw new Error('上游来源单元不能唯一绑定，禁止猜测');
 const source=candidates[0],units=sourceUnits(source).filter(u=>u.type===selection.unitType);
 if(selection.unitIds?.length)throw new Error('未来来源不能使用尚未绑定的单元ID');
 const selected=selection.mode==='all'?units:(selection.unitIndexes||[]).map(n=>units.find(u=>u.index===n));
 if(!selected.length||selected.some(u=>!u)||new Set(selected.map(u=>u.id)).size!==selected.length)throw new Error('上游实际产物缺少所选单元，禁止退回全部内容或猜测');
 const binding={type:selection.unitType==='directions'?'direction':selection.unitType==='shots'?'shot':'product',sourceId:source.id,sourceArtifactId:source.id,version:source.version||1,sourceHash:sourceDigest(source),unitIds:selected.map(u=>u.id),indexes:selected.map(u=>u.index)};
 if(selected.length===1)Object.assign(binding,{unitId:selected[0].id,index:selected[0].index});
 if(item.resolvedSelectorBinding&&hash(item.resolvedSelectorBinding)!==hash(binding))throw new Error('已绑定的上游来源版本或选择内容已变化，必须重新接受修订');
 return binding;
}
export function resolveDeferredCoverage(item,sources){
 const selection=item.sourceSelection;if(!futureSource(selection?.source))return null;
 const binding=resolveDeferredSelection(item,sources),source=sources.find(s=>s.id===binding.sourceId),units=sourceUnits(source).filter(u=>u.type===selection.unitType);
 const fileCount=selection.layout==='storyboard_sheet'?1:binding.unitIds.length;
 if(selection.layout==='unspecified'||fileCount!==item.count)throw new Error('上游实际单元数量与已接受的交付数量不符，需要修订数量并重新确认');
 const coverage={source:{artifactId:source.id,version:source.version||1,unitsHash:hash(units)},unitType:selection.unitType,unitIds:binding.unitIds,layout:selection.layout,fileCount};
 if(item.resolvedCoverage&&hash(item.resolvedCoverage)!==hash(coverage))throw new Error('已绑定的上游来源版本变化，旧批准不可继续');
 return coverage;
}
