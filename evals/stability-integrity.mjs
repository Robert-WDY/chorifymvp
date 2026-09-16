import {isDeepStrictEqual} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export function auditTrace(t){
 const store=t.state.taskStore||{},artifacts=Object.values(store.artifacts||{}),inputs=Object.values(store.inputs||{});
 const checks={submittedArgsMatchPersistedPlan:true,explicitParametersPreserved:true,toolReturnsPaired:true,sourceBodyPreserved:true,referenceURLsKnown:true};
 for(const s of t.submissions||[]){
  const support=store.artifacts?.[s.skillArtifactId];
  checks.submittedArgsMatchPersistedPlan&&=!!support?.metadata?.structure?.items?.some(i=>isDeepStrictEqual(i,s.args));
  const item=store.tasks?.[s.taskId]?.items.find(i=>i.id===support?.itemId);
  if(s.tool==='generate_video')checks.explicitParametersPreserved&&=!!item&&(!item.spec.durationSeconds||s.args.duration===item.spec.durationSeconds)&&(!item.spec.ratio||s.args.ratio===item.spec.ratio);
  const known=new Set([...inputs,...artifacts,...(t.state.assets||[])].map(a=>a.url).filter(Boolean));
  checks.referenceURLsKnown&&=[...(s.args.referenceImages||[]),...(s.args.firstFrameUrl?[s.args.firstFrameUrl]:[])].every(url=>known.has(url));
 }
 const messages=t.state.messages||[];
 for(const call of messages.filter(m=>m.type==='function_call')){
  const returns=messages.filter(m=>m.type==='function_call_output'&&m.call_id===call.call_id);
  checks.toolReturnsPaired&&=returns.length===1;try{if(returns.length)JSON.parse(returns[0].output);else checks.toolReturnsPaired=false;}catch{checks.toolReturnsPaired=false;}
 }
 for(const call of t.calls||[])for(const m of call.input||[]){
  if(m.role!=='user'||typeof m.content!=='string')continue;let p;try{p=JSON.parse(m.content);}catch{continue;}
  for(const source of p.sources||[])if(source.content!==undefined)checks.sourceBodyPreserved&&=artifacts.some(a=>a.id===source.id&&a.content===source.content);
 }
 return {checks,passed:Object.values(checks).every(Boolean)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const root=process.argv[2],results=JSON.parse(await readFile(root+'/results.json','utf8')),out=[];
 for(const r of results)out.push({id:r.id,...auditTrace(JSON.parse(await readFile(root+'/'+r.id+'/trace.json','utf8')))});
 await writeFile(root+'/integrity-audit.json',JSON.stringify(out,null,2));console.log(JSON.stringify({total:out.length,passed:out.filter(x=>x.passed).length,failed:out.filter(x=>!x.passed)},null,2));
}
