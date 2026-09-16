import {revisionTarget} from './turn-operation.mjs';
import {createHash} from 'node:crypto';
import {methodBoundary} from './prompt-text.mjs';
import {selectIntakeDocuments,assertIntakePointers} from './intake-context.mjs';
export const modelViewVersion='prompt-context-v1';
export const viewHash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function skillDirectoryEntry(skill){
 const description=skill.description||'',start=description.indexOf('适用于');
 return {slug:skill.slug,name:skill.name,description:skill.contract?.workflow?.join('；')||description,...(start>=0?{applicability:description.slice(start)}:{})};
}
export function renderMethod(method){
 const common='# 当前阶段边界\n'+methodBoundary+'\n\n',start=method.content.indexOf(common);
 const content=start<0?method.content:method.content.slice(0,start)+method.content.slice(start+common.length);
 return {slug:method.slug,content,renderedContentHash:viewHash(content),removedRanges:start<0?[]:[{start,end:start+common.length,unit:'utf16',reason:'shared_method_boundary'}]};
}
export function projectModelInput(payload,renderStructure){
 const view=structuredClone(payload);
 for(const key of ['facts','globalConstraints'])if(view.evidenceContext&&JSON.stringify(view[key])===JSON.stringify(view.evidenceContext[key])){
  delete view.evidenceContext[key];(view.evidenceContext.valueSources??={})[key]='/'+key;
 }
 const methodKey=Array.isArray(view.methods)?'methods':Array.isArray(view.loadedMethods)?'loadedMethods':null;
 if(methodKey&&view[methodKey].length){
  view.methodBoundary=methodBoundary;
  view[methodKey]=view[methodKey].map(method=>({slug:method.slug,content:renderMethod(method).content,...(method.contract?.role?{role:method.contract.role}:{})}));
 }
 const fullSource=view.changeContract?.source;
 for(const source of [...(view.sources||[]),...(view.supportingSources||[])]){
  if(renderStructure&&source.structure&&source.content===renderStructure(source.structure)&&source.id!==fullSource?.id){delete source.content;source.contentSource='structure';}
 }
 if(view.sourceDocument){
  const index=view.sources?.findIndex(s=>s.id===view.sourceDocument.id&&s.version===view.sourceDocument.version&&JSON.stringify(s)===JSON.stringify(view.sourceDocument));
  if(index>=0){view.sourceDocumentRef='/sources/'+index;delete view.sourceDocument;}
 }
 if(view.changeContract?.original){
  const source=view.sources?.find(s=>s.id===fullSource?.id&&s.content===view.changeContract.original);
  if(source){source.contentRef='/changeContract/original';delete source.content;}
 }
 return view;
}
export function repairInput(payload,draft,plan,{reference=false,error}={}){
 const evidence=payload.relevantEvidence||{},paths=plan.paths||[],fields=new Set(paths.flatMap(p=>p.split('/').filter(Boolean)));
 const references=payload.referenceCatalog||{entries:evidence.references||[]};
 const needsReferences=reference||['references','supportingSources','sourceSelection','selector','spec','changeContract','presentation','query','turnOperation','target','sources','version'].some(k=>fields.has(k));
 const needsTask=['turnOperation','revisionDelta','targetTaskId','approval','continuation'].some(k=>fields.has(k));
 const out={query:payload.query,currentMessageId:payload.currentMessageId,replyTo:payload.replyTo,lockedDraft:structuredClone(draft),...(error?{error}:{}),lockedFieldsPolicy:'Only listed fields may change; program revalidates the complete candidate.'};
 if(reference){out.candidates=plan.candidates;out.field=plan.field;out.deliverableIndices=plan.indices;}
 else Object.assign(out,{paths,missingPaths:paths,removePaths:plan.removePaths,fieldKeys:plan.keys,...(needsReferences?{referenceCatalog:references}:{}),...(needsTask?{taskSnapshot:payload.taskSnapshot||payload.activeTaskState,taskIndex:payload.taskIndex||evidence.relatedTasks}:{}),...(fields.has('requiredMethods')||needsReferences?{skillDirectory:payload.skillDirectory||evidence.skillDirectory}:{})});
 out.conversation=payload.conversation||evidence.conversation;
 // Reading evidence does not grant permission to modify its fields. Repair
 // needs the bodies behind every supplied handle, including candidate tails.
 const docs=(payload.sourceDocuments||evidence.sourceDocuments||[]).filter(d=>d.id);
 const selected=needsReferences?docs:selectIntakeDocuments({...payload,sourceDocuments:docs});
 if(selected.length)out.sourceDocuments=structuredClone(selected);
 if(needsTask){const id=draft.turnOperation?.targetTaskId;const chosen=(payload.taskIndex||evidence.relatedTasks||[]).find(t=>t.id===id);if(chosen)out.taskSnapshot=chosen;}
 return assertIntakePointers(out);
}
// Model views are projections, never replacements for persisted execution state.
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
export const videoDefaults=Object.freeze({durationSeconds:5,ratio:'16:9',resolution:'720p'});
// Remove only exact duplicate content. Preserve evidence once and point to its ID.
export function compactIntakePayload(payload,renderStructure){
 const entries=payload.referenceCatalog?.entries||[];
 const handles=new Set(entries.map(e=>e.handle));
 for(const [view,members] of Object.entries(payload.referenceCatalog?.views||{})){
  payload.referenceCatalog.views[view]=members.map(e=>e&&typeof e==='object'&&handles.has(e.handle)?e.handle:e);
 }
 const messages=payload.conversation?.recentMessages||[];
 const bodies=new Map();
 for(const message of [...messages].reverse()){
  if(!message.content||message.role!=='assistant')continue;
  const existing=bodies.get(message.content);
  if(existing){message.contentMessageId=existing;delete message.content;}
  else if(message.messageId)bodies.set(message.content,message.messageId);
 }
 for(const attempt of payload.conversation?.recentAttempts||[]){
  const m=messages.find(m=>m.role==='user'&&m.content===attempt.input&&m.messageId);
  if(m){attempt.inputMessageId=m.messageId;delete attempt.input;}
 }
 for(const doc of payload.sourceDocuments||[]){
  const m=messages.find(m=>m.content===doc.content&&m.messageId);
  if(m){doc.contentMessageId=m.messageId;delete doc.content;}
  const body=doc.content??messages.find(m=>m.messageId===doc.contentMessageId)?.content;
  for(const entry of entries)if(entry.handle===doc.id&&entry.version===doc.version&&entry.excerpt===body&&body){delete entry.excerpt;entry.contentSource={sourceDocumentId:doc.id,version:doc.version};}
  if(doc.structure&&renderStructure&&doc.content===renderStructure(doc.structure)){delete doc.content;doc.contentSource='structure';}
  for(const entry of entries)if(entry.handle===doc.id&&entry.version===doc.version)for(const unit of entry.units||[]){
   if(doc.structure&&JSON.stringify(doc.structure[unit.type]?.[unit.index-1])===JSON.stringify(unit.value)){
    unit.valueSource={sourceDocumentId:doc.id,version:doc.version};delete unit.value;
   }
  }
 }
 const ids=new Set((payload.sourceDocuments||[]).flatMap(d=>[d.id,entries.find(e=>e.handle===d.id)?.id]).filter(Boolean));
 for(const task of [payload.taskSnapshot,...(payload.taskIndex||[])])for(const a of task?.artifacts||[]){
  if(ids.has(a.id)){delete a.excerpt;a.contentSource='sourceDocuments';}
 }
 return payload;
}
export function mediaRequirements(items=[],sourceItem){
 const consumes=(item,seen=new Set())=>{if(!sourceItem||item.id===sourceItem.id)return true;if(seen.has(item.id))return false;seen.add(item.id);return(item.dependsOn||[]).some(index=>items[index]&&consumes(items[index],seen));};
 return items.filter(i=>i.operation==='generate_video'&&consumes(i)).map(i=>({itemId:i.id,dependsOn:i.dependsOn||[],...videoDefaults,...pick(i.spec,['durationSeconds','ratio']),origin:{durationSeconds:i.spec?.durationSeconds?'user':'default',ratio:i.spec?.ratio?'user':'default'}}));
}
export const itemContext=item=>pick(item,['id','index','description','operation','output','count','dependsOn','references','constraints','activation','requestEvidenceSpans','evidenceSegments','spec','requiredEvidence','requiredMethods','artifactCount','contentCardinality','deliverySlot','selectionRole','specOrigins','form','executionShape','sourceSelection','coverage','referenceBindings','supportingSourceBindings','runtimeQuery','businessOperation','resultRelation','changeContract','supportingSources','preservedSpec','selectorBinding','selector']);
export function intakeSnapshot(task){
 if(!task)return null;
 return {revisionTarget:revisionTarget(task),...pick(task,['id','revision','query','status','completionStatus','requirements','intentSnapshot','stages','reason','missingInputs','actions']),
  goal:{...pick(task.goal,['summary','assumptions','missingInputs']),facts:task.goal?.semantic?.facts||[],globalConstraints:task.goal?.semantic?.globalConstraints||[]},
  approval:pick(task.approval,['required','status','planHash','reason','payload']),
  items:(task.items||[]).map((i,n)=>({...itemContext(i),spec:{...task.goal?.semantic?.deliverables?.[n]?.spec,...i.spec},constraints:[...new Set([...(task.goal?.semantic?.deliverables?.[n]?.constraints||[]),...(i.constraints||[])])],observations:(i.observations||[]).map(o=>({tool:o.tool,succeeded:!o.result?.isError})),...pick(i,['status','issues','artifactIds'])})),
  artifacts:(task.artifacts||[]).filter(a=>a.purpose!=='support').map(a=>({...pick(a,['id','itemId','type','purpose','url','version','parentId','verification']),...(a.metadata?.facts?{factSource:a.metadata.facts.source}:{excerpt:a.content?.slice(0,600),contentAvailable:!!a.content}),publication:a.publication})),
  executions:task.executions||[]};
}
export function evidenceContext(state,item,sources=[]){
 const task=state.taskStore?.tasks?.[state.taskStore.activeTaskId];
 const requestEvidence=task?.goal?.semantic?.deliverables?.[item.index]?.requestEvidence||'';
 return {speakerRole:task?.goal?.semantic?.speakerRole,targetAudience:task?.goal?.semantic?.targetAudience,requestEvidenceSpans:item.requestEvidenceSpans||[],evidenceSegments:item.evidenceSegments||[],currentInstruction:task?.continuationEvidence?.at(-1),provenance:{taskId:task?.id,revision:task?.revision,requestId:task?.requestId},...(requestEvidence||item.evidenceSegments?.length?{}:{query:task?.query||'',legacyEvidenceFallback:true}),runtimeFacts:task?.goal?.requestContract?.systemFacts?.length?task?.runtimeFacts:undefined,facts:task?.contract?.facts||[],globalConstraints:task?.contract?.globalConstraints||[],requestEvidence,
  assumptions:task?.goal?.assumptions||[],gaps:task?.goal?.semantic?.gaps||[],plannedMedia:mediaRequirements(task?.items,item),
  sourceRequests:[...new Set(sources.map(s=>s.taskId).filter(id=>id&&id!==task?.id))].flatMap(id=>{const owner=state.taskStore?.tasks?.[id];return owner?[owner.contract?{taskId:id,revision:owner.revision,requestId:owner.requestId,facts:owner.contract.facts||[],globalConstraints:owner.contract.globalConstraints||[]}:{taskId:id,query:owner.query}]:[];}),
  sources:sources.map(s=>pick(s,['id','type','url','version','taskId'])),
  policy:'只有原始用户要求和源材料支持的产品属性可作为事实；来源中的模型推断和facts字段本身不构成事实权威，只有用户/原始证据可确认，源产物的checker与publication不能被忽略；模型草稿和创意假设不是已核实证据。未知卖点省略或逐项标注假设，整体免责声明不能替代逐项标注。'};
}
export function methodContext(catalog,skill){
 return skill.methods.map(slug=>{
  const method=catalog.skills.find(s=>s.slug===slug);if(!method)throw new Error('Skill不存在：'+slug);
  return {slug,workflow:method.contract.workflow};
 });
}
