import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function intentSnapshot(query,draft,{origin='first_parsed_intent'}={}){
 const data={version:1,origin,query,goal:draft.summary||query,parsedSummary:draft.summary||null,operation:structuredClone(draft.turnOperation||null),
  globalConstraints:structuredClone(draft.globalConstraints||[]),
  deliverables:(draft.deliverables||[]).map((d,index)=>({id:'r'+(index+1),index,goal:d.description||'',type:d.kind??null,action:d.action??null,count:d.count??null,artifactCount:d.artifactCount??null,dependsOn:structuredClone(d.dependsOn||[]),constraints:structuredClone(d.constraints||[]),requestEvidence:d.requestEvidence||'',spec:structuredClone(d.spec||{}),changeContract:structuredClone(d.changeContract||null),requiredMethods:structuredClone(d.requiredMethods||[])}))};
 return freeze({...data,hash:hash(data)});
}
export function assertIntentSnapshot(snapshot){
 if(!snapshot)return;
 const {hash:expected,...data}=snapshot;if(expected!==hash(data))throw new Error('Intent Snapshot 已被修改；必须以新请求创建新版本');
}
export function assertIntentPreserved(snapshot,draft){
 if(!snapshot)return;
 assertIntentSnapshot(snapshot);
 const fail=field=>{throw Object.assign(new Error('字段修复改变了用户义务：'+field),{code:'intent_preservation'});};
 if(snapshot.parsedSummary&&snapshot.parsedSummary!==draft.summary)fail('summary');
 if(snapshot.deliverables.length!==(draft.deliverables||[]).length)fail('deliverables.length');
 snapshot.deliverables.forEach((r,i)=>{
  const d=draft.deliverables[i];
  for(const [key,value] of [['description',r.goal],['kind',r.type],['action',r.action],['count',r.count],['artifactCount',r.artifactCount],['dependsOn',r.dependsOn],['constraints',r.constraints]]){
   if(value===null||key==='count'&&(!Number.isInteger(value)||value<1))continue;
   if(key==='description'&&!value)continue;
   if(key==='kind'&&!['text','image','video','audio'].includes(value))continue;
   if(key==='action'&&!['create','modify','respond','inspect','query','present','retain'].includes(value))continue;
   if(JSON.stringify(value)!==JSON.stringify(d[key]??(['dependsOn','constraints'].includes(key)?[]:undefined)))fail('deliverables/'+i+'/'+key);
  }
  for(const key of ['spec','changeContract'])if(r[key]){
   // Existing values are locked; a missing subfield can still be supplied.
   for(const [field,value] of Object.entries(r[key])){
    if(key==='spec'&&r.type==='image'&&!['ratio','exactTexts'].includes(field))continue;
    if(JSON.stringify(value)!==JSON.stringify(d[key]?.[field]))fail('deliverables/'+i+'/'+key+'/'+field);
   }
  }
  if(r.requiredMethods?.length&&JSON.stringify(r.requiredMethods)!==JSON.stringify(d.requiredMethods))fail('deliverables/'+i+'/requiredMethods');
 });
 if(JSON.stringify(snapshot.globalConstraints)!==JSON.stringify(draft.globalConstraints||[]))fail('globalConstraints');
}
