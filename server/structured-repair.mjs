import Ajv from 'ajv';
const ajv=new Ajv({strict:false,allErrors:true});
const escape=s=>s.replace(/~/g,'~0').replace(/\//g,'~1');
const parts=path=>path.split('/').slice(1).map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'));
// Patches never authorize execution themselves; the merged draft must pass the
// original schema, immutable intent comparison and all business validators.
export function missingFieldPlan(draft,schema){
 return fieldRepairPlan(draft,schema);
}
// Choose only a branch whose explicit discriminator matches the draft. This
// removes irrelevant oneOf errors without weakening the final schema validator.
function discriminated(schema,value){
 if(!schema||typeof schema!=='object')return schema;
 if(schema.oneOf&&value&&typeof value==='object'){
  const branches=schema.oneOf.filter(b=>Object.entries(b.properties||{}).some(([k,v])=>Object.hasOwn(v,'const')&&value[k]===v.const));
  if(branches.length===1){const {oneOf,...base}=schema;return discriminated({...base,...branches[0]},value);}
 }
 const result={...schema};
 if(schema.properties)result.properties=Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,discriminated(v,value?.[k])]));
 if(schema.items&&Array.isArray(value)){
  // Validate individual array entries independently, retaining their exact paths.
  result.items=schema.items;
 }
 return result;
}
function at(value,path){return parts(path).reduce((v,k)=>v?.[k],value);}
function fieldSchema(schema,value,path){
 let shape=schema,current=value;
 for(const key of parts(path)){shape=discriminated(shape,current);shape=shape.type==='array'?shape.items:shape.properties?.[key];current=current?.[key];if(!shape)return null;}
 return discriminated(shape,current);
}
export function fieldRepairPlan(draft,schema){
 if(!draft||!schema||!(Array.isArray(draft.deliverables)||Array.isArray(draft.businessActions)))return null;
 const properties={},keys={},removePaths=[],replacePaths=[];
 const visit=(value,shape,path='')=>{
  shape=discriminated(shape,value);
  // Array slots are immutable; a bad slot is repaired in place, never dropped.
  if(shape.type==='array'&&Array.isArray(value)&&shape.items){
   const header={...shape};delete header.items;
   if(!ajv.compile(header)(value))return false;
   return value.every((v,i)=>visit(v,shape.items,path+'/'+i));
  }
  const validationShape=structuredClone(shape);
  if(validationShape.properties)for(const [k,v] of Object.entries(validationShape.properties)){
   if(v.type==='array'&&Array.isArray(value?.[k]))validationShape.properties[k]={...v,items:{}};
  }
  const valid=ajv.compile(validationShape);valid(value);
  for(const error of valid.errors||[]){
   if(error.keyword==='if')continue;
   let target,field,remove=false;
   const local=error.instancePath;
   const rule=at(validationShape,error.schemaPath.slice(1).replace(/\/[^/]+$/,''));
   if(error.keyword==='required'){
    target=path+local+'/'+escape(error.params.missingProperty);
    field=rule?.properties?.[error.params.missingProperty]||fieldSchema(shape,value,local)?.properties?.[error.params.missingProperty];
   }else if(error.keyword==='additionalProperties'){
    target=path+local+'/'+escape(error.params.additionalProperty);field={const:null};remove=true;
   }else if(['enum','const','type','minimum','maximum','minLength','maxLength','pattern','minItems','maxItems'].includes(error.keyword)){
    target=path+local;field=rule;
    if(!target||target==='/deliverables'||target==='/businessActions')return false;
   }else return false;
   if(!field)return false;
   if(error.keyword==='required'&&Object.hasOwn(field,'default'))continue;
   if(keys[target])continue;
   const key=path===''&&error.keyword==='required'&&local===''?error.params.missingProperty:'field_'+Object.keys(keys).length;
   keys[target]=key;properties[key]=structuredClone(field);
   if(remove)removePaths.push(target);else if(error.keyword!=='required')replacePaths.push(target);
  }
  for(const [k,v] of Object.entries(shape.properties||{})){
   if(v.type==='array'&&Array.isArray(value?.[k])&&!visit(value[k],v,path+'/'+escape(k)))return false;
  }
  return true;
 };
 if(!visit(draft,schema)||!Object.keys(keys).length)return null;
 return {paths:Object.keys(keys),replacePaths,removePaths,keys,schema:{type:'object',additionalProperties:false,required:Object.keys(properties),properties}};
}
export function semanticFieldPlan(draft,schema,issues=[]){
 if(!draft||!schema||!issues?.length)return null;
 const properties={},keys={},removePaths=[];
 for(const issue of issues){
  const segments=parts(issue.path||'');
  // Semantic repair must name a concrete field, never the whole plan or a slot.
  if(segments.length<2||['deliverables','businessActions'].includes(segments[0])&&segments.length<3)return null;
  let shape=schema,value=draft;
  for(const key of segments){shape=discriminated(shape,value);shape=shape.type==='array'?shape.items:shape.properties?.[key];value=value?.[key];if(!shape)return null;}
  if(keys[issue.path])continue;
  const key='field_'+Object.keys(keys).length;keys[issue.path]=key;properties[key]=issue.removeOnly?{const:null}:structuredClone(shape);
  if(issue.removeOnly)removePaths.push(issue.path);
 }
 return {paths:Object.keys(keys),replacePaths:Object.keys(keys),removePaths,keys,schema:{type:'object',additionalProperties:false,required:Object.keys(properties),properties}};
}
export function applyMissingFields(draft,patch,plan){
 const validate=ajv.compile(plan.schema);if(!validate(patch))throw new Error('缺失字段补全不符合限定Schema：'+JSON.stringify(validate.errors));
 const result=structuredClone(draft);
 for(const path of plan.paths){const keys=parts(path),name=keys.pop();let target=result;for(const key of keys)target=target[key];if(plan.removePaths?.includes(path)){delete target[name];continue;}if(Object.hasOwn(target,name)&&!plan.replacePaths?.includes(path))throw new Error('补全不能修改已有字段：'+path);Object.defineProperty(target,name,{value:structuredClone(patch[plan.keys[path]]),enumerable:true,writable:true,configurable:true});}
 return result;
}
// The draft is unaccepted. Only fields explicitly rejected by validation can
// change during field repair; compare all remaining meaning against the draft.
export function repairComparisonDraft(draft,merged,plan){
 const baseline=structuredClone(draft);
 for(const path of [...(plan.replacePaths||[]),...(plan.removePaths||[])]){
  const keys=parts(path),name=keys.pop();let old=baseline,updated=merged;
  for(const key of keys){old=old?.[key];updated=updated?.[key];}
  if(!old||typeof old!=='object')continue;
  if(updated&&Object.hasOwn(updated,name))Object.defineProperty(old,name,{value:structuredClone(updated[name]),enumerable:true,writable:true,configurable:true});else delete old[name];
 }
 return baseline;
}
