import {discardImageDirectionSelector} from './turn-operation.mjs';
import {validationTrace} from './trace-context.mjs';
const machineFields=skill=>Object.keys(skill?.contract?.outputSchema?.properties?.structure?.properties||{});
const inheritedDrafts=new WeakMap();
export function normalizeMethodPlan(route,d,catalog){
 discardImageDirectionSelector(d);
 const explicit=d.requiredMethods||[];
 if(d.kind==='text'&&d.businessOperation==='modify'&&d.changeContract)return {...route,operation:'rewrite',skills:explicit};
 const shape=d.coverage?null:d.form||(d.purpose==='storyboard'?'script':d.purpose==='prompt'?'prompt':null);
 let methods=route.skills.filter(slug=>{
  const skill=catalog.skills.find(s=>s.slug===slug);if(!skill)return true;
  if((d.selectionRole==='consumer'||['modify','translate'].includes(d.businessOperation))&&machineFields(skill).includes('directions')&&!explicit.includes(slug))return false;
  if(d.coverage&&skill.contract.deliveryLayouts&&!skill.contract.deliveryLayouts.includes(d.coverage.layout)){if(explicit.includes(slug))throw new Error('指定Skill与交付形式不兼容：'+slug);return false;}
  if(explicit.includes(slug))return true;
  if(!skill.contract.operations.includes(route.operation))return false;
  if(shape&&skill.contract.forms&&!skill.contract.forms.includes(shape))return false;
  return true;
 });
 // A selector is an executable dependency, not a hint in the script prompt.
 if(d.form==='directions'&&d.action==='create'&&!d.coverage&&d.selectionRole!=='consumer'&&!['modify','translate'].includes(d.businessOperation)){
  const producer=methods.find(slug=>machineFields(catalog.skills.find(s=>s.slug===slug)).includes('directions'));
  if(!producer&&!d.dependsOn?.length){
   const skill=catalog.skills.find(s=>machineFields(s).includes('directions')&&s.contract.operations.includes(route.operation));
   if(!skill)throw new Error('方向义务缺少兼容的生产能力');
   const consumer=methods.findIndex(slug=>machineFields(catalog.skills.find(s=>s.slug===slug)).some(f=>['body','shots','prompt'].includes(f)));
   methods.splice(consumer<0?methods.length:consumer,0,skill.slug);
  }
 }else if((d.executionShape==='direct'||['title','copy','prompt','answer'].includes(d.form))&&explicit.length<2&&!(d.requiredSteps?.length>1)){
  // Minimum implementation for one local transformation; explicit methods win.
  methods=explicit.length?explicit:methods.slice(0,1);
 }
 if(JSON.stringify(methods)!==JSON.stringify(route.skills))validationTrace({phase:'normalize_method_plan',before:route.skills,after:methods,reason:'只保留适用方法，补齐结构化义务的生产者'});
 return {...route,skills:methods};
}
export function planSpecs(d,{query='',previous,sourceTurn='current'}={}){
 if(!d.spec&&!d.specOrigins)return d;
 const spec={...d.spec},origins={...d.specOrigins};
 for(const [key,value] of Object.entries(spec)){
  const declaration=origins[key];
  const inherited=previous?.spec?.[key]!==undefined&&JSON.stringify(previous.spec[key])===JSON.stringify(value);
  const evidenced=declaration?.origin==='user'&&typeof declaration.evidence==='string'&&declaration.evidence.trim()&&query.includes(declaration.evidence);
  // Old, unattributed constraints remain locked unless no original numeric evidence exists.
  const numeric=typeof value==='number',hasLiteral=numeric&&((query.match(/\d+(?:\.\d+)?/g)||[]).includes(String(value))||({1:'一',2:'二',3:'三',4:'四',5:'五',6:'六',7:'七',8:'八',9:'九',10:'十',15:'十五',20:'二十'}[value]&&query.includes({1:'一',2:'二',3:'三',4:'四',5:'五',6:'六',7:'七',8:'八',9:'九',10:'十',15:'十五',20:'二十'}[value])));
  origins[key]={value,origin:evidenced?'user':inherited?'inherited':declaration?.origin==='system_default'?'system_default':numeric&&!hasLiteral?'system_default':'unattributed',sourceTurn:declaration?.sourceTurn||sourceTurn,evidence:evidenced?declaration.evidence:inherited?'previous accepted specification':'',adjustable:!evidenced&&!inherited&&numeric&&!hasLiteral};
 }
 if(spec.shotCount&&spec.secondsPerShot&&spec.durationSeconds&&Math.abs(spec.shotCount*spec.secondsPerShot-spec.durationSeconds)>0.001){
  if(origins.secondsPerShot?.adjustable){const before=spec.secondsPerShot;delete spec.secondsPerShot;origins.secondsPerShot={...origins.secondsPerShot,discardedValue:before,value:null,reason:'系统默认与总时长冲突，镜头时长由一致的分镜分配'};}
  else if(origins.durationSeconds?.adjustable){spec.durationSeconds=spec.shotCount*spec.secondsPerShot;origins.durationSeconds.value=spec.durationSeconds;}
  else throw Object.assign(new Error('明确规格冲突：镜头数×每镜秒数与总时长不一致'),{code:'spec_conflict'});
 }
 d.spec=spec;d.specOrigins=origins;return d;
}
export function ensureMethodDefaults(d,methods,catalog){
 if(d.kind&&d.kind!=='text')return;
 if(methods.some(slug=>machineFields(catalog.skills.find(s=>s.slug===slug)).includes('directions'))&&!d.spec?.directionCount){
  const declared=d.form==='directions'?(d.contentCardinality??(d.countDeclared!==false?d.count:undefined)):undefined;
  d.spec={...d.spec,directionCount:declared??Math.max(3,d.spec?.selectedDirectionIndex||0)};
  d.specOrigins={...d.specOrigins,directionCount:{value:d.spec.directionCount,origin:declared?'accepted_request':'system_default',sourceTurn:'current',evidence:declared?d.requestEvidence||'':'未指定方向数量，默认三个',evidenceSpans:declared?d.requestEvidenceSpans||[]:[],adjustable:!declared}};
 }
}
export function assertWorkflow(item,items,catalog){
 if(item.operation==='edit_image'&&item.spec?.selectedDirectionIndex!==undefined)throw new Error('image selector cannot map to direction selector');
 const methods=(item.requiredMethods||[]).map(slug=>({slug,skill:catalog?.skills.find(s=>s.slug===slug)}));
 if(catalog&&methods.some(m=>!m.skill))throw Object.assign(new Error('所需Skill当前不可用：'+methods.filter(m=>!m.skill).map(m=>m.slug).join('、')),{code:'unsupported_method'});
 if(item.spec?.shotCount&&item.spec.secondsPerShot&&item.spec.durationSeconds&&Math.abs(item.spec.shotCount*item.spec.secondsPerShot-item.spec.durationSeconds)>0.001)throw Object.assign(new Error('执行前规格检查失败：镜头时长与总长冲突'),{code:'spec_conflict'});
 if(!item.spec?.selectedDirectionIndex)return;
 if(item.spec.directionCount&&item.spec.selectedDirectionIndex>item.spec.directionCount)throw new Error('选定方向超过计划方向数量');
 const fields=m=>catalog?machineFields(m.skill):m.slug==='direction-designer-zh-v1'?['directions']:['video-script-zh-v1','storyboard-one-shot-zh-v2','creative-prompt-rewrite'].includes(m.slug)?['body']:[];
 const producer=methods.findIndex(m=>fields(m).includes('directions'));
 const consumer=methods.findIndex(m=>fields(m).some(f=>['body','shots','prompt'].includes(f)));
 const external=(item.dependsOn||[]).some(n=>items[n]?.spec?.directionCount>=item.spec.selectedDirectionIndex&&(items[n]?.requiredMethods||[]).some(slug=>catalog?machineFields(catalog.skills.find(s=>s.slug===slug)).includes('directions'):slug==='direction-designer-zh-v1'));
 if(methods.length&&consumer<0)return;
 if(!external&&!item.references?.length&&(producer<0||consumer>=0&&producer>=consumer))throw Object.assign(new Error('执行图缺少选定方向的前置生产节点，不能删除选择要求继续'),{code:'missing_dependency',repairTarget:'plan'});
}

export function revisionMediaScope(value,previous,query){
 if(!previous)return value;
 const old=previous.goal?.requestContract?.media||Object.fromEntries(['image','video','audio'].map(k=>[k,(previous.items||[]).filter(i=>i.output===k).reduce((n,i)=>n+i.count,0)]));
 const media={...old};
 for(const change of value.mediaChanges||[]){
  if(!Object.hasOwn(media,change.kind)||!Number.isInteger(change.count)||change.count<0)throw new Error('交付范围变更的媒介或数量无效');
  if(change.count===media[change.kind])continue; // Identity updates authorize no new effect.
  if(!change.evidence?.trim()||!query.includes(change.evidence))throw new Error('交付范围变更必须有本轮原文证据');
  media[change.kind]=change.count;
 }
 // No explicit delta means the final obligation survives a pause or spec edit.
 return {...value,proposedMedia:value.media,proposedReadOnly:value.readOnly,readOnly:Object.values(media).some(n=>n>0)?false:value.readOnly,media,finalObligations:{media},currentPermission:{mediaSubmission:'approval_gate'},scopeSource:'previous_plus_explicit_delta'};
}
export function auditedDeliveryScope(value,query,previous){
 if(!value.finalDeliverables)return value; // Older captured contracts remain readable.
 if(!Array.isArray(value.finalDeliverables))throw new Error('最终交付清单格式无效');
 const media={image:0,video:0,audio:0},now={image:0,video:0,audio:0};
 for(const d of value.finalDeliverables){
  if(!['text','image','video','audio'].includes(d.kind)||!Number.isInteger(d.count)||d.count<1||!['now','after_approval'].includes(d.timing))throw new Error('最终交付须包含媒介、数量和执行时机');
  if(!d.evidence?.trim()||!(query.includes(d.evidence)||previous?.query?.includes(d.evidence)))throw new Error('最终交付缺少原始要求依据');
  if(d.kind!=='text'){media[d.kind]+=d.count;if(d.timing==='now')now[d.kind]+=d.count;}
 }
 return {...value,media,finalObligations:{media},currentPermission:{mediaBudget:now,approvalPending:value.finalDeliverables.some(d=>d.timing==='after_approval')}};
}
export function inheritMediaObligations(semantic,snapshot,scope){
 if(semantic.continuation?.mode!=='revise'||!snapshot)return;
 const prior=snapshot.goal?.semantic?.deliverables||[];
 for(const [index,d] of prior.entries()){
  if(d.kind==='text'||scope?.[d.kind]===0||semantic.deliverables.some(n=>n.kind===d.kind))continue;
  const map=new Map();
  for(const dep of d.dependsOn||[]){
   const matches=semantic.deliverables.map((n,i)=>({n,i})).filter(({n})=>n.kind===prior[dep]?.kind);
   if(matches.length!==1)throw new Error('修订中的原依赖不能唯一映射，须明确修订范围');map.set(dep,matches[0].i);
  }
  const inherited=structuredClone(d);inherited.dependsOn=(d.dependsOn||[]).map(n=>map.get(n));
  inherited.references=(d.references||[]).map(r=>/^task:\d+$/.test(r)?'task:'+map.get(Number(r.slice(5))):r);
  const predecessor=semantic.deliverables[inherited.dependsOn[0]];
  const patch=Object.fromEntries(['durationSeconds','ratio'].filter(k=>predecessor?.spec?.[k]!==undefined).map(k=>[k,predecessor.spec[k]]));
  inherited.spec={...inherited.spec,...patch,...semantic.spec};
  if(!inheritedDrafts.has(semantic))inheritedDrafts.set(semantic,{items:[],approval:structuredClone(semantic.approval)});
  inheritedDrafts.get(semantic).items.push(inherited);semantic.deliverables.push(inherited);
  validationTrace({phase:'inherit_final_obligation',previousIndex:index,kind:d.kind,count:d.count,reason:'修订默认保留已有最终媒体，只有原文支持的范围增量可取消',dependsOn:inherited.dependsOn});
 }
 if(snapshot.approval?.required&&semantic.deliverables.some(d=>d.kind!=='text'))semantic.approval.required=true;
 if(scope&&['image','video','audio'].every(k=>scope[k]===0)&&!semantic.deliverables.some(d=>d.kind!=='text'))semantic.approval.required=false;
}
export function discardInheritanceForNewTask(semantic){
 const record=inheritedDrafts.get(semantic);if(!record||semantic.continuation?.mode==='revise')return;
 semantic.deliverables=semantic.deliverables.filter(d=>!record.items.includes(d));semantic.approval=record.approval;inheritedDrafts.delete(semantic);
}
