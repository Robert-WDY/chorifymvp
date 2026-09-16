import fs from 'node:fs';
const ids={'G01-T1':'85682e8c-cc6e-4730-a9a3-3c8ecfd63cb4','G02-T8':'67c8e027-5610-4049-9fa2-392bc0fc8282','C01-T4':'89e44c77-2d43-4615-9a34-8921fcb6641d','C02-T4':'25b90337-b5d4-44b4-875b-3337a4b9fa3d','C03-T4':'8f499fcf-00e8-439b-86d0-8b5cb066078f','C04-T2':'2ec464cd-c773-49e6-9359-0559e80a3dd0'};
const cases=Object.entries(ids).map(([id,callId])=>{
 const record=JSON.parse(fs.readFileSync('data/user-multiturn-reeval-20260914/'+id+'.json')),call=record.state.modelCalls.find(c=>c.id===callId),input=JSON.parse(call.input[1].content),raw=JSON.parse(call.output.flatMap(o=>o.content||[]).map(p=>p.text||'').join('\n'));
 const replace=v=>typeof v==='string'?input.referenceCatalog.entries.find(e=>e.handle===v)?.id||v:Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
 const artifacts=Object.values(record.state.taskStore.artifacts).filter(a=>a.createdAt<=call.startedAt);
 const candidates=Object.values(record.state.taskStore.tasks).filter(t=>t.createdAt<=call.startedAt).map(t=>({...t,artifacts:artifacts.filter(a=>a.taskId===t.id)}));
 return {id,callId,query:input.query,raw:replace(raw),artifacts,candidates,taskId:input.taskSnapshot?.id,history:input.history};
});
fs.writeFileSync('tests/fixtures/operation-contract-raw.json',JSON.stringify(cases,null,2));
console.log(cases.map(c=>({id:c.id,operation:c.raw.turnOperation,refs:c.raw.deliverables.map(d=>d.references),spec:c.raw.spec})));
