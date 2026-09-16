import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createBrain} from '../server/adapters.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {methodContext} from '../server/model-context.mjs';
import {mediaSkills} from '../server/media-skill-contracts.mjs';
import {understandGoal} from '../server/intent.mjs';
import {Verifier} from '../server/verification.mjs';
const root=process.argv[2]||'data/context-ab-20260911-a';await mkdir(root,{recursive:false});
const catalog=await loadCatalog(),cases=[];
const get=async(run,id)=>JSON.parse(await readFile(`data/${run}/${id}/trace.json`,'utf8'));
for(const id of ['C002-supported','C003','C013']){
 const t=await get('production24-ds-v41flash-20260911-a',id),call=t.calls.find(c=>c.input[0].content.includes('必须执行的媒体Skill'));
 const before=call.input,after=structuredClone(before),p=JSON.parse(after[1].content),skill=mediaSkills[1];
 p.methodReferences=methodContext(catalog,skill);after[1].content=JSON.stringify(p);
 after[0].content='你是必须执行的媒体Skill：'+JSON.stringify({slug:skill.slug,workflow:skill.workflow})+after[0].content.slice(after[0].content.indexOf('。工具权限由系统控制'));
 cases.push({id:'media-'+id,before,after,check:v=>({count:v.items?.length===p.goal.count,parameters:!!v.items?.length&&v.items.every(i=>i.duration===(p.goal.spec.durationSeconds||5)&&i.ratio===(p.goal.spec.ratio||'16:9')),noPhantomReference:!v.items?.some(i=>/所附首帧|所附.*宫格/.test(i.prompt||'')),ratioConsistency:!v.items?.some(i=>/17:9/.test(i.prompt||''))})});
}
for(const [run,id,index] of [['production500-v1','L1_understanding-028',0],['production24-doubao-20260911-a','C019',1],['production500-v1','L2_planning-022',0],['production500-v1','L3_execution-066',0]]){
 const t=await get(run,id),before=t.calls[index].input,p=JSON.parse(before.find(m=>m.role==='user').content);let after;
 try{await understandGoal({respond:async input=>{after=structuredClone(input);throw new Error('capture only');}},catalog,{...p,strictControl:true},AbortSignal.abort());}catch{}
 // Capture uses an already-aborted signal so no retry modifies the first request.
 after=after.filter(m=>!m.content.startsWith('系统格式/一致性校验反馈'));
 cases.push({id:'intent-'+id,before,after,check:v=>({dependencies:v.deliverables?.every((d,i)=>d.dependsOn?.every(n=>n>=0&&n<i))===true,...(id==='C019'?{continuation:v.continuation?.mode==='clarify'&&v.continuation?.taskId===p.taskSnapshot.id,source:v.deliverables?.some(d=>d.kind==='image'&&d.action==='modify'&&d.references?.length>0)===true}:{}),...(['L2_planning-022','L3_execution-066'].includes(id)?{requiresMissingSource:v.gaps?.some(g=>g.level==='blocking')===true,retainsMediaGoal:v.deliverables?.some(d=>['image','video'].includes(d.kind))===true}:{})})});
}
for(const provider of ['ds-v41flash','doubao']){
 const t=await get(`production24-${provider}-20260911-a`,'C016'),call=t.calls.find(c=>c.input[0].content.includes('任务交付验证器'));
 const before=call.input,p=JSON.parse(before[1].content[0].text),task=Object.values(t.state.taskStore.tasks)[0];let after;
 const verifier=new Verifier({respond:async input=>{after=structuredClone(input);return [{type:'message',content:[{type:'output_text',text:'{"passed":false,"issues":[],"uncertain":false}'}]}];}});
 await verifier.verifyText(task.items[0],p.content,t.state,new AbortController().signal);
 cases.push({id:'facts-'+provider,before,after,check:v=>({rejectsUnsupportedClaims:v.passed===false&&v.uncertain===false})});
}
await writeFile(root+'/cases.json',JSON.stringify(cases.map(({check,...c})=>c),null,2));
if(process.argv.includes('--prepare-only')){
 const sizes=cases.map(c=>({id:c.id,before:JSON.stringify(c.before).length,after:JSON.stringify(c.after).length}));
 await writeFile(root+'/input-sizes.json',JSON.stringify(sizes,null,2));console.log(JSON.stringify(sizes,null,2));process.exit(0);
}
const jobs=cases.flatMap(c=>Array.from({length:3},(_,repeat)=>['before','after'].map(arm=>({c,repeat,arm})))).flat(),results=[];let cursor=0,blocked=false;
await Promise.all(Array.from({length:4},async()=>{const brain=createBrain();while(!blocked&&cursor<jobs.length){const {c,repeat,arm}=jobs[cursor++],row={id:c.id,repeat,arm,inputChars:JSON.stringify(c[arm]).length};
 try{row.output=await brain.respond(c[arm],[],AbortSignal.timeout(90000),{json:true});const v=JSON.parse(row.output.filter(m=>m.type==='message').flatMap(m=>m.content||[]).map(p=>p.text||'').join('\n'));row.checks=c.check(v);row.passed=Object.values(row.checks).every(Boolean);}catch(e){row.error=e.message;row.passed=null;if([401,402].includes(brain.lastCall?.httpStatus))blocked=true;}row.metrics=brain.lastCall;results.push(row);await writeFile(root+'/results.json',JSON.stringify(results,null,2));
}}));
const summary={blocked,cases:cases.map(c=>({id:c.id,...Object.fromEntries(['before','after'].map(arm=>{const r=results.filter(x=>x.id===c.id&&x.arm===arm);return [arm,{passed:r.filter(x=>x.passed).length,scored:r.filter(x=>x.checks).length,attempted:r.length,inputChars:JSON.stringify(c[arm]).length,checks:r.map(x=>x.checks)}];}))}))};
await writeFile(root+'/summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
