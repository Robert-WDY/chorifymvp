import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createBrain} from '../server/adapters.mjs';
import {understandGoal} from '../server/intent.mjs';
import {loadCatalog} from '../server/catalog.mjs';
const root=process.argv[2]||'data/context-continuation-01';await mkdir(root,{recursive:false});
const cases=JSON.parse(await readFile('data/context-ab-retry-01/cases.json','utf8'));
const original=cases.find(c=>c.id==='intent-C019');
const payload=JSON.parse(original.before.find(m=>m.role==='user').content),catalog=await loadCatalog();
const results=await Promise.all(Array.from({length:3},async(_,repeat)=>{
 const base=createBrain(),calls=[],result={repeat,calls};
 try{result.goal=await understandGoal({respond:async(...args)=>{const c={input:structuredClone(args[0])};calls.push(c);try{c.output=await base.respond(...args);return c.output;}finally{c.metrics=base.lastCall;}}},catalog,{...payload,strictControl:true},AbortSignal.timeout(90000));
 const g=result.goal;result.checks={clarify:g.semantic.continuation.mode==='clarify',sameTask:g.semantic.continuation.taskId===payload.taskSnapshot.id,operation:g.tasks[0]?.operation==='edit_image',mediaEvidence:g.tasks[0]?.requiredEvidence==='none',reference:!!g.tasks[0]?.references?.length};result.passed=Object.values(result.checks).every(Boolean);
 }catch(e){result.error=e.message;result.passed=false;}return result;
}));
await writeFile(root+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(({calls,goal,...r})=>({...r,calls:calls.length})),null,2));
