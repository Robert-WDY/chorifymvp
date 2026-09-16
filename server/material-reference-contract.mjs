// Registries define reference namespaces. This validates object identities, never Query wording.
export function assertMaterialReferenceTypes(semantic,references,catalog){
 const skills=new Set(catalog.skills.map(s=>s.slug)),known=new Set(references.entries.flatMap(e=>[e.id,e.handle]));
 const issues=[];
 for(const [index,d] of (semantic.deliverables||[]).entries()){
  for(const field of ['references','supportingSources'])for(const value of d[field]||[]){
   if(skills.has(value)&&!known.has(value))issues.push({path:`/deliverables/${index}/${field}`,value,actualType:'skill',expectedType:'material'});
  }
  if(d.sourceSelection&&!d.sourceSelection.source?.trim())issues.push({path:`/deliverables/${index}/sourceSelection`,actualType:'empty_selector',expectedType:'bound_source'});
  else if(d.sourceSelection&&d.kind==='image'&&d.action==='modify'&&!/^task:\d+$/.test(d.sourceSelection.source)){
   const selected=references.resolveReference(d.sourceSelection.source,{purpose:'history',required:false});
   const structure=selected.source?.metadata?.structure||selected.source?.structure;
   if(!structure?.[d.sourceSelection.unitType]?.length)issues.push({path:`/deliverables/${index}/sourceSelection`,actualType:'unit_selector_for_image_edit',expectedType:'bound_text_unit'});
  }
 }
 if(issues.length)throw Object.assign(new Error('素材引用合同类型不匹配：'+JSON.stringify(issues)+(issues.some(i=>i.actualType==='unit_selector_for_image_edit')?'。图片对象没有指定类型的内容单元，图片编辑必须绑定图片对象；只能修正 sourceSelection，不能改变编辑目标。':'')+'。Skill 的执行选择属于 requiredMethods，不能当素材读取；由需求理解重新决定正确字段，不自动移动或丢弃。未选择内容单元时不声明 sourceSelection，需要选择时必须绑定真实来源。'),{code:'reference_contract',issues,repairIssues:issues.flatMap(i=>[{...i,removeOnly:i.actualType==='unit_selector_for_image_edit'||i.actualType==='empty_selector'&&!(semantic.deliverables[Number(i.path.split('/')[2])].sourceSelection.unitIds||[]).length},...(i.actualType==='skill'?[{path:i.path.replace(/\/[^/]+$/,'/requiredMethods')}]:[])])});
}
