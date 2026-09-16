// Deterministic diagnostics only. Presence acceptance and creative quality are
// separate policies; these checks never authorize resubmission or rewrite Goals.
export function constraintChecks(item,result){
 const checks=[],spec=item.spec||{},s=result.structure;
 const check=(field,expected,actual)=>checks.push({field,expected,actual:actual??null,status:actual===undefined?'not_evaluated':typeof expected==='number'&&typeof actual==='number'?Math.abs(expected-actual)<0.001?'passed':'failed':expected===actual?'passed':'failed'});
 if(s?.directions&&spec.directionCount)check('directionCount',spec.directionCount,s.directions.length);
 if(s?.shots){
  if(spec.shotCount)check('shotCount',spec.shotCount,s.shots.length);
  const durations=s.shots.map(s=>s.durationSeconds),sum=durations.every(n=>typeof n==='number'&&Number.isFinite(n))?durations.reduce((a,b)=>a+b,0):undefined;
  if(spec.durationSeconds)check('durationSeconds',spec.durationSeconds,sum);
  if(typeof s.durationSeconds==='number')check('structure.durationSeconds',s.durationSeconds,sum);
  if(spec.secondsPerShot)durations.forEach((n,i)=>check('shots.'+i+'.durationSeconds',spec.secondsPerShot,n));
 }
 return {checker:'program',scope:'structured_numeric_constraints',status:checks.some(c=>c.status==='failed')?'failed':checks.some(c=>c.status==='not_evaluated')||!checks.length?'not_evaluated':'passed',checks,semanticQuality:'not_evaluated'};
}
export function aggregateConstraintChecks(reports){
 const checks=reports.flatMap(({id,report})=>(report?.checks||[]).map(c=>({...c,field:id+'.'+c.field})));
 return {checker:'program',scope:'structured_numeric_constraints',status:checks.some(c=>c.status==='failed')?'failed':!checks.length||checks.some(c=>c.status==='not_evaluated')?'not_evaluated':'passed',checks,semanticQuality:'not_evaluated'};
}

// Compare exact dimensions in code; a preview must never stand in for provider metadata.
export function checkImageGeometry(item,artifact){
 if(artifact.type!=='image')return null;
 const target=artifact.metadata?.args?.size;
 const expected=item.operation==='edit_image'&&!item.spec?.ratio&&/^\d+x\d+$/.test(target||'')?target:null;
 const ratio=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(item.spec?.ratio||'');
 if(!expected&&!ratio)return null;
 const actual=artifact.metadata?.provider?.size;
 if(!/^\d+x\d+$/.test(actual||''))return{passed:false,uncertain:true,issues:['缺少实际图片尺寸元数据，无法确认画布要求']};
 const [width,height]=actual.split('x').map(Number);
 if(width<=0||height<=0)return{passed:false,uncertain:true,issues:['实际图片尺寸元数据无效']};
 if(expected&&expected!==actual)return{passed:false,uncertain:false,issues:['实际画布尺寸 '+actual+' 未保持原图尺寸 '+expected]};
 if(ratio&&(Number(ratio[1])<=0||Number(ratio[2])<=0))return{passed:false,uncertain:true,issues:['目标比例无效']};
 if(ratio&&Math.abs(width/height/(Number(ratio[1])/Number(ratio[2]))-1)>0.01)return{passed:false,uncertain:false,issues:['实际图片尺寸 '+actual+' 不符合目标比例 '+item.spec.ratio]};
 return null;
}

export function mediaConstraintChecks(item,artifact){
 const checks=[],spec=item.spec||{},metadata=artifact.metadata?.provider||{};
 if(artifact.type==='image'&&(spec.ratio||item.operation==='edit_image'&&/^\d+x\d+$/.test(artifact.metadata?.args?.size||''))){
  const issue=checkImageGeometry(item,artifact);
  checks.push({field:spec.ratio?'ratio':'size',expected:spec.ratio||artifact.metadata.args.size,actual:metadata.size||null,status:issue?issue.uncertain?'not_evaluated':'failed':'passed',issues:issue?.issues||[]});
 }
 if(artifact.type==='video'&&spec.durationSeconds)checks.push({field:'durationSeconds',expected:spec.durationSeconds,actual:metadata.duration??null,status:typeof metadata.duration!=='number'?'not_evaluated':Math.abs(spec.durationSeconds-metadata.duration)<0.001?'passed':'failed'});
 if(artifact.type==='video'&&spec.ratio)checks.push({field:'ratio',expected:spec.ratio,actual:metadata.ratio??null,status:!metadata.ratio?'not_evaluated':spec.ratio===metadata.ratio?'passed':'failed'});
 return {checker:'program',scope:'provider_metadata_not_visual_content',status:checks.some(c=>c.status==='failed')?'failed':!checks.length||checks.some(c=>c.status==='not_evaluated')?'not_evaluated':'passed',checks,semanticQuality:'not_evaluated'};
}
