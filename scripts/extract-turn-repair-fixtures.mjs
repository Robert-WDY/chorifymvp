import fs from 'node:fs';
const parse=c=>JSON.parse(c.output.filter(o=>o.type==='message').flatMap(o=>o.content||[]).map(p=>p.text||'').join(''));
const cases=[];
for(const id of ['G02-T2','G02-T5','G02-T6','C01-T4','C03-T1','C03-T2','C04-T4']){
 const x=JSON.parse(fs.readFileSync('data/user-multiturn-eval-20260914/'+id+'.json')),calls=x.state.modelCalls.filter(c=>c.runId===x.assessment.requestId),call=calls[0],input=JSON.parse(call.input[1].content),raw=parse(call),lookup=new Map((input.referenceCatalog?.entries||[]).map(e=>[e.handle,e.id]));
 for(const d of raw.deliverables){d.references=d.references.map(r=>lookup.get(r)||r);if(d.sourceSelection)d.sourceSelection.source=lookup.get(d.sourceSelection.source)||d.sourceSelection.source;}
 const ids=new Set((input.referenceCatalog?.entries||[]).map(e=>e.id)),artifacts=Object.values(x.state.taskStore.artifacts).filter(a=>ids.has(a.id));
 const candidates=(input.taskIndex||[]).map(t=>({...x.state.taskStore.tasks[t.id],...t,artifacts:artifacts.filter(a=>a.taskId===t.id)}));
 cases.push({id,callId:call.id,query:x.turn.user_query,raw,candidates,artifacts,taskId:input.taskSnapshot?.id,originalOutcome:x.assessment.outcome});
}
fs.writeFileSync('tests/fixtures/turn-semantics-raw.json',JSON.stringify(cases,null,2));
