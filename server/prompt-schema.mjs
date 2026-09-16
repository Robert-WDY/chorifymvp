// Share repeated schema fragments without dropping validation information.
// Only the model-facing representation changes; runtime validators stay authoritative.
export function compactPromptSchema(schema){
 // Hoisting changes the base of relative references. Keep reference-bearing
 // schemas intact; compression is optional, validation equivalence is not.
 const scoped=value=>value&&typeof value==='object'&&(Object.keys(value).some(k=>['$id','$ref','$anchor','$dynamicRef','$dynamicAnchor','$recursiveRef'].includes(k))||Object.values(value).some(scoped));
 if(scoped(schema))return structuredClone(schema);
 const maps=new Set(['properties','patternProperties','$defs','definitions','dependentSchemas']);
 const arrays=new Set(['allOf','anyOf','oneOf','prefixItems']);
 const singles=new Set(['additionalProperties','unevaluatedProperties','propertyNames','contains','additionalItems','unevaluatedItems','not','if','then','else','contentSchema']);
 // Map containers and annotation data never become schema nodes themselves.
 const children=(node,fn)=>Object.fromEntries(Object.entries(node).map(([key,value])=>{
  if(maps.has(key))return [key,Object.fromEntries(Object.entries(value).map(([name,child])=>[name,fn(child)]))];
  if(arrays.has(key))return [key,value.map(child=>fn(child))];
  if(key==='items')return [key,Array.isArray(value)?value.map(child=>fn(child)):fn(value)];
  if(key==='dependencies')return [key,Object.fromEntries(Object.entries(value).map(([name,child])=>[name,Array.isArray(child)?structuredClone(child):fn(child)]))];
  return [key,singles.has(key)?fn(value):structuredClone(value)];
 }));
 const counts=new Map(),values=new Map();
 const visit=value=>{
  if(!value||typeof value!=='object')return;
  if(value!==schema){const key=JSON.stringify(value);if(key.length>=100){counts.set(key,(counts.get(key)||0)+1);values.set(key,value);}}
  children(value,child=>{visit(child);return child;});
 };
 visit(schema);
 let serial=0;const used=new Set(Object.keys(schema.$defs||{}));
 const names=new Map([...counts].filter(([,n])=>n>1).map(([key])=>{while(used.has('shared'+serial))serial++;return [key,'shared'+serial++];}));
 const definitions={};
 const encode=(value,root=false)=>{
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(v=>encode(v));
  const key=JSON.stringify(value),name=!root&&names.get(key);
  if(name){if(!definitions[name])definitions[name]=encode(values.get(key),true);return {$ref:'#/$defs/'+name};}
  return children(value,child=>encode(child));
 };
 const result=encode(schema,true);
 return Object.keys(definitions).length?{...result,$defs:{...result.$defs,...definitions}}:result;
}
