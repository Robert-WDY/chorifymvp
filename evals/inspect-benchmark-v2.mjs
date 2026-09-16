import {readFile,readdir,writeFile} from 'node:fs/promises';
const root=new URL('../data/benchmark-v2-200/',import.meta.url);
const rows=await Promise.all((await readdir(new URL('runs/',root))).filter(p=>p.endsWith('.json')).sort().map(async p=>JSON.parse(await readFile(new URL('runs/'+p,root),'utf8'))));
const frequencies=items=>Object.fromEntries([...new Set(items)].map(k=>[k,items.filter(x=>x===k).length]).sort((a,b)=>b[1]-a[1]));
const detailed=rows.map(({result:r,state,modelCalls})=>({id:r.id,category:r.category,query:r.query,status:r.status,ops:r.actualOps,counts:r.goal?.tasks.map(t=>t.count),references:r.goal?.tasks.map(t=>t.references),dependencies:r.goal?.tasks.map(t=>t.dependsOn),
 selectedSkills:r.goal?.skills,loadedSkills:state.events.filter(e=>e.type==='tool_result'&&['use_skill','read_skill'].includes(e.name)&&!e.result?.isError).map(e=>e.result.slug),
 safety:r.goal?.safety,missingInputs:r.goal?.missingInputs,raw:r.rawPassed,compatible:r.compatiblePassed,artifacts:r.artifacts,mediaCount:r.mediaCountCheck,called:r.called,
 toolErrors:state.events.filter(e=>e.type==='tool_result'&&e.result?.isError).map(e=>({name:e.name,error:e.result.text})),
 calls:modelCalls.map(c=>({phase:c.phase,ms:c.durationMs,error:c.error})),intakeError:r.intakeError,answer:r.answer,
 mediaArguments:state.messages.filter(m=>m.type==='function_call'&&['generate_image','edit_image','generate_video','get_video_task','wait_video_task'].includes(m.name)).map(m=>({name:m.name,args:JSON.parse(m.arguments)}))}));
const phaseTimes=Object.fromEntries(['understand','select_capabilities','execution'].map(phase=>{const values=detailed.flatMap(r=>r.calls).filter(c=>c.phase===phase).map(c=>c.ms).sort((a,b)=>a-b);return [phase,{calls:values.length,medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]}];}));
const stats={finished:rows.length,statuses:frequencies(detailed.map(r=>r.status)),categoryCounts:frequencies(detailed.map(r=>r.category)),phaseTimes,
 skillRuns:detailed.filter(r=>r.loadedSkills.length).length,skillCalls:frequencies(detailed.flatMap(r=>r.loadedSkills)),toolCalls:frequencies(detailed.flatMap(r=>r.called)),
 errors:detailed.filter(r=>r.toolErrors.length||r.intakeError).map(r=>({id:r.id,toolErrors:r.toolErrors,intakeError:r.intakeError})),
 mediaCounts:detailed.filter(r=>r.mediaCount).map(r=>({id:r.id,status:r.status,...r.mediaCount})),
 schemaFailures:detailed.filter(r=>!r.ops.length&&r.intakeError).map(r=>r.id)};
await writeFile(new URL('diagnostics.json',root),JSON.stringify({stats,cases:detailed},null,2));
console.log(JSON.stringify(stats));
