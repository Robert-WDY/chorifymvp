// Only canonicalize unambiguous whitespace mistakes in schema-owned keys.
import {validationTrace} from './trace-context.mjs';
export function isSchemaEcho(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const keys=Object.keys(value),schemaKeys=new Set(['$schema','$id','$ref','$defs','definitions','type','properties','required','additionalProperties','oneOf','anyOf','allOf','not','if','then','else','items','prefixItems','enum','const','description','title','default','minimum','maximum','minLength','maxLength','minItems','maxItems','pattern']);
 return keys.length>0&&keys.every(k=>schemaKeys.has(k))&&keys.some(k=>['oneOf','anyOf','allOf','$defs','$ref','properties','items'].includes(k)||k==='type'&&['object','array','string','number','integer','boolean','null'].includes(value.type));
}
// Report the selected discriminator branch; validation itself remains unchanged.
export function relevantSchemaErrors(schema,value,errors=[]){
 const variants=schema?.properties?.deliverables?.items?.oneOf;
 if(!variants)return errors;
 const filtered=errors.filter(e=>{
  const match=/^\/deliverables\/(\d+)(?:\/|$)/.exec(e.instancePath||'');
  if(!match)return true;
  const kind=value?.deliverables?.[Number(match[1])]?.kind;
  const branch=variants.findIndex(v=>v.properties?.kind?.const===kind);
  if(branch<0)return true;
  const variant=/\/oneOf\/(\d+)(?:\/|$)/.exec(e.schemaPath||'');
  return variant?Number(variant[1])===branch:e.keyword!=='oneOf';
 });
 return filtered.length?filtered:errors;
}
// Recover only an unambiguous premature root closing brace followed by known
// object members. Never merge independent JSON objects or discard a field.
export function parseStructured(raw,schema){
 const text=raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
 try{
  const value=JSON.parse(text),instance=value?.properties;
  if(schema?.properties&&!schema.properties.properties&&value.type==='object'&&Object.keys(value).every(k=>['type','properties','required','additionalProperties'].includes(k))&&instance&&typeof instance==='object'&&!Array.isArray(instance)&&(schema.required||[]).length&&(schema.required||[]).every(k=>Object.hasOwn(instance,k))&&Object.entries(instance).every(([k,v])=>{const t=schema.properties[k]?.type;return !t||t==='array'?Array.isArray(v):t==='object'?v&&typeof v==='object'&&!Array.isArray(v):typeof v===t;})){
   validationTrace({phase:'normalize_metadata',operation:'unwrap_instance_envelope',preservedFields:Object.keys(instance),semanticFieldsChanged:[]});return instance;
  }
  return value;
 }catch(original){
  // Remove only a comma directly before a container closes, never text in strings.
  let quotedComma=false,escapedComma=false,withoutTrailing='',removed=0;
  for(let i=0;i<text.length;i++){
   const c=text[i];
   if(!quotedComma&&c===','&&/^\s*[}\]]/.test(text.slice(i+1))){removed++;continue;}
   withoutTrailing+=c;
   if(escapedComma){escapedComma=false;continue;}
   if(quotedComma&&c==='\\'){escapedComma=true;continue;}
   if(c==='"')quotedComma=!quotedComma;
  }
  if(removed){const value=parseStructured(withoutTrailing,schema);validationTrace({phase:'repair_json_syntax',repairTarget:'syntax',operation:'remove_trailing_comma',count:removed,semanticFieldsChanged:[]});return value;}
  let inString=false,escape=false,escapedText='',controls=0;
  for(const c of text){if(inString&&!escape&&c.charCodeAt(0)<32){escapedText+=JSON.stringify(c).slice(1,-1);controls++;continue;}escapedText+=c;if(escape){escape=false;continue;}if(inString&&c==='\\'){escape=true;continue;}if(c==='"')inString=!inString;}
  if(controls){const value=parseStructured(escapedText,schema);validationTrace({phase:'repair_json_syntax',repairTarget:'syntax',operation:'escape_literal_string_controls',count:controls,semanticFieldsChanged:[]});return value;}
  if(!schema?.properties||text[0]!=='{')throw original;
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;continue;}if(c==='{'||c==='[')depth++;if(c==='}'||c===']')depth--;if(depth===0){end=i;break;}}
  if(end<0||!/^\s*,\s*"[^"\\]+"\s*:/.test(text.slice(end+1)))throw original;
  let tail;try{tail=JSON.parse('{'+text.slice(end+1).replace(/^\s*,/,'').trim());}catch{throw original;}
  const head=JSON.parse(text.slice(0,end+1)),keys=Object.keys(tail);
  if(!keys.length||keys.some(k=>!Object.hasOwn(schema.properties,k)||Object.hasOwn(head,k)))throw original;
  const candidate=text.slice(0,end)+text.slice(end+1);
  // Count every root member token, including duplicates JSON.parse would hide.
  let rootDepth=0,keysSeen=[];
  for(let i=0;i<candidate.length;i++){
   const c=candidate[i];if(c==='{'||c==='[')rootDepth++;else if(c==='}'||c===']')rootDepth--;
   else if(c==='"'){let j=i+1;for(;j<candidate.length;j++){if(candidate[j]==='\\'){j++;continue;}if(candidate[j]==='"')break;}
    if(rootDepth===1&&/^\s*:/.test(candidate.slice(j+1)))keysSeen.push(JSON.parse(candidate.slice(i,j+1)));i=j;
   }
  }
  if(new Set(keysSeen).size!==keysSeen.length)throw original;
  const result=JSON.parse(candidate);validationTrace({phase:'repair_json_syntax',repairTarget:'syntax',removedOffset:end,operation:'remove_premature_root_close',preservedFields:Object.keys(result),semanticFieldsChanged:[]});return result;
 }
}
export function normalizeSemanticMetadata(value){
 if(!value||!Array.isArray(value.deliverables)||value.properties)return;
 const changes=[];
 if(['object','json_object'].includes(value.type)){const before=value.type;delete value.type;changes.push({path:'/type',before,reason:'Schema元字段，不是业务属性'});}
 for(const key of ['artifactCount','contentCardinality']){
  if(!Object.hasOwn(value,key))continue;
  if(value.turnOperation?.kind==='present'&&value[key]===value.turnOperation.presentation?.targets?.length){changes.push({path:'/'+key,before:value[key],reason:'呈现数量由绑定目标集合决定，不是新生产数'});delete value[key];continue;}
  if(!value.deliverables.length)continue;
  const d=value.deliverables;
  const expected=key==='artifactCount'?d.reduce((n,x)=>n+(x.artifactCount??(x.kind==='text'?1:x.count)),0):d.reduce((n,x)=>n+(x.contentCardinality??x.count),0);
  if(Number.isInteger(expected)&&value[key]===expected){changes.push({path:'/'+key,before:value[key],reason:'与交付项数量完全相同的冗余顶层字段，业务数量保留'});delete value[key];}
 }
 for(const [index,d] of value.deliverables.entries()){
  if(d.turnOperationKind&&d.turnOperationKind===value.turnOperation?.kind){changes.push({path:'/deliverables/'+index+'/turnOperationKind',before:d.turnOperationKind,reason:'与权威本轮操作相同的冗余字段'});delete d.turnOperationKind;}
  if(['image','video','audio'].includes(d.kind)&&Object.hasOwn(d,'form')){changes.push({path:'/deliverables/'+index+'/form',before:d.form,reason:'form为文字文档结构；媒体形式由kind和来源coverage.layout决定'});delete d.form;}
  if(d.kind==='image')for(const key of ['shotCount','secondsPerShot','durationSeconds'])if(d.spec?.[key]!==undefined){changes.push({path:'/deliverables/'+index+'/spec/'+key,before:d.spec[key],reason:'图片无时间轴，来源镜头范围由sourceSelection绑定'});delete d.spec[key];if(d.specOrigins)delete d.specOrigins[key];}
 }
 if(changes.length)validationTrace({phase:'normalize_metadata',allowedPaths:changes.map(x=>x.path),normalizations:changes});
}
export function normalizeOutputMetadata(value,schema){
 if(schema?.type!=='object'||!value||Array.isArray(value)||schema.properties?.type||!['object','json_object'].includes(value.type)||value.properties)return;
 if(!(schema.required||[]).length||!(schema.required||[]).every(k=>Object.hasOwn(value,k)))return;
 const before=value.type;delete value.type;validationTrace({phase:'normalize_metadata',allowedPaths:['/type'],normalizations:[{path:'/type',before,reason:'所有必需实例字段已存在，删除Schema元字段'}]});
}
// Never change values, invent fields, or overwrite an existing canonical key.
export function normalizeSchemaKeys(value,schema,path=''){
 const changes=[];
 if(Array.isArray(value)&&schema.items){value.forEach((v,n)=>changes.push(...normalizeSchemaKeys(v,schema.items,path+'/'+n)));return changes;}
 if(!value||typeof value!=='object'||Array.isArray(value)||!schema.properties)return changes;
 for(const key of Object.keys(value)){
  const canonical=key.replace(/\s/g,'');
  if(!Object.hasOwn(schema.properties,key)&&canonical!==key&&Object.hasOwn(schema.properties,canonical)&&!Object.hasOwn(value,canonical)){value[canonical]=value[key];delete value[key];changes.push({path:path+'/'+key,canonical:path+'/'+canonical});}
 }
 for(const [key,child] of Object.entries(schema.properties))if(Object.hasOwn(value,key))changes.push(...normalizeSchemaKeys(value[key],child,path+'/'+key));
 return changes;
}
