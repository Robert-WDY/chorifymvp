import {digest} from './document-contract.mjs';
import {constraintChecks} from './constraint-checks.mjs';
// One counting convention, shared by generation, acceptance and completion.
export const bodyLengthSchema={type:'object',additionalProperties:false,required:['min','max','unit'],properties:{min:{type:'integer',minimum:0},max:{type:'integer',minimum:1},unit:{enum:['non_punctuation_characters','characters']}}};
export const textUnitsSchema={type:'array',minItems:1,items:{type:'object',additionalProperties:false,required:['body'],properties:{body:{type:'string',minLength:1},titleBefore:{type:'string'},titleAfter:{type:'string'}}}};
export const renderTextUnits=units=>units.map(u=>[u.titleBefore,u.body,u.titleAfter].filter(Boolean).join('\n\n')).join('\n\n');
export const countBody=(body,unit)=>[...body.replace(/[*`#]/g,'').replace(unit==='characters'?/$^/u:/[\p{P}\p{Z}\s]/gu,'')].length;
export function hardTextChecks(item,result){
 const checks=[...(result.stageChecks||constraintChecks(item,result).checks)],spec=item.spec||{};
 const missing=(field,expected)=>{if(!checks.some(c=>c.field===field))checks.push({field,expected,actual:null,status:'not_evaluated'});};
 const script=item.form==='script'||item.operation==='storyboard'||result.structure?.shots;
 if(spec.shotCount&&script)missing('shotCount',spec.shotCount);
 if(spec.directionCount&&(item.form==='directions'||item.selectionRole==='producer'||result.structure?.directions))missing('directionCount',spec.directionCount);
 if(spec.durationSeconds&&script)missing('durationSeconds',spec.durationSeconds);
 for(const text of spec.exactTexts||[])checks.push({field:'exactText',expected:text,actual:result.content?.includes(text)||false,status:result.content?.includes(text)?'passed':'failed'});
 if(spec.bodyLength){
  const units=result.structure?.textUnits;
  // This representation renders body/title only. Hidden numeric metadata is
  // not evidence of delivered shots/directions; mixed layouts need a renderer.
  if(units&&(result.structure.shots||result.structure.directions))checks.push({field:'renderedStructuredUnits',expected:'visible numeric units',actual:null,status:'not_evaluated'});
  // Check the rendered delivery, never a second model-written body or a title.
  if(result.stageChecks?.some(c=>c.field.startsWith('bodyLength.'))){ /* measured against each actual stage body */ }
  else if(!Array.isArray(units)||!units.length||units.some(u=>typeof u.body!=='string')||renderTextUnits(units)!==result.content)missing('bodyLength',spec.bodyLength);
  else for(const [i,u] of units.entries()){
   const actual=countBody(u.body,spec.bodyLength.unit);checks.push({field:'bodyLength.'+i,expected:spec.bodyLength,actual,status:actual>=spec.bodyLength.min&&actual<=spec.bodyLength.max?'passed':'failed'});
  }
  if(units)checks.push({field:'bodyUnitCount',expected:item.contentCardinality||item.count||1,actual:units.length,status:units.length===(item.contentCardinality||item.count||1)?'passed':'failed'});
 }
 return {checker:'program',scope:'actual_delivery_hard_requirements',inputHash:digest(result.content||''),status:checks.some(c=>c.status==='failed')?'failed':checks.some(c=>c.status==='not_evaluated')?'not_evaluated':'passed',checks};
}
export function enforceHardChecks(verdict,report){
 const unresolved=report.checks.filter(c=>c.status!=='passed');
 return {...verdict,hardRequirements:report,...(unresolved.length?{passed:false,outcome:report.status==='failed'?'failed':'uncertain',uncertain:report.status!=='failed',issues:[...(verdict.issues||[]),...unresolved.map(c=>`${c.status==='failed'?'硬要求不满足':'硬要求未核验'}：${c.field}，要求 ${JSON.stringify(c.expected)}，实际 ${JSON.stringify(c.actual)}`)]}:{})};
}
