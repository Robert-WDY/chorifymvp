import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));
for(const id of process.argv.slice(2)){
 const dir=path.join(out,id),r=JSON.parse(fs.readFileSync(path.join(dir,'result.json'))),s=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));
 console.log(JSON.stringify({id,status:r.status,final:r.final,tasks:r.tasks.map(t=>({status:t.status,reason:t.reason,goal:t.goal,items:t.items,approval:t.approval,executionPlan:t.executionPlan})),calls:s.modelCalls.map(c=>({phase:c.tracePhase,method:c.methodId,start:c.startedAt,end:c.finishedAt,output:c.output,validation:c.validations?.filter(v=>v.error||v.phase==='fill_missing_fields').map(v=>({phase:v.phase,error:v.error,paths:v.paths,patch:v.patch})),input:(process.env.SHOW_INPUT==='1'?c.input:undefined)})),artifacts:r.artifacts.map(a=>({id:a.id,metadata:a.metadata}))},null,2));
}
