import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const out=path.dirname(fileURLToPath(import.meta.url)),root=process.env.CHORIFY_ROOT||path.resolve(out,path.basename(out)==='media-controls'?'../../..':'../..');
const read=p=>JSON.parse(fs.readFileSync(path.join(out,p),'utf8')),write=(p,v)=>fs.writeFileSync(path.join(out,p),JSON.stringify(v,null,2));
const req=createRequire(path.join(root,'package.json')),Ajv=req('ajv'),ajv=new Ajv({strict:false,allErrors:true,useDefaults:true});
const {semanticSchema}=await import(pathToFileURL(root+'/server/intent.mjs')),{operationInputSchema}=await import(pathToFileURL(root+'/server/turn-operation.mjs'));
const wire=ajv.compile(operationInputSchema(semanticSchema));
const allCases=[...read('cases.json'),...read('media-controls/cases.json')],summaries=[read('summary.json'),read('media-controls/summary.json')],rows=[];
let inputTokens=0,outputTokens=0,cachedTokens=0;
const text=c=>(c.output||[]).flatMap(o=>o.content||[]).filter(p=>p.type==='output_text').map(p=>p.text).join('');
const payload=c=>{try{return JSON.parse(c.input.find(m=>m.role==='user').content);}catch{return null;}};
for(const c of allCases){
 const dir=Number(c.id.slice(0,2))>20?'media-controls/'+c.id:c.id;
 const r=read(dir+'/result.json'),s=read(dir+'/state.json'),calls=s.modelCalls||[],tasks=Object.values(s.taskStore?.tasks||{}),items=tasks.flatMap(t=>t.items||[]),arts=r.artifacts,gens=calls.filter(x=>x.tracePhase==='text_generation');
 const checks=[],check=(name,passed,evidence)=>checks.push({name,passed:!!passed,evidence});
 const inputs=calls.map(x=>JSON.stringify(x.normalizedRequest||x.input));
 const foreign=allCases.filter(x=>x.id!==c.id&&x.marker).filter(x=>inputs.some(i=>i.includes(x.marker))).map(x=>x.marker);
 check('emptyInitial',Object.entries(r.initial).every(([k,v])=>k==='sessionId'||v===0),r.initial);
 check('noForeignMarkers',foreign.length===0,foreign);
 check('noPreviousResponseId',calls.every(x=>!x.normalizedRequest?.previous_response_id));
 const firstPayload=payload(calls[0]),ev=firstPayload?.relevantEvidence,conv=ev?.conversation;
 check('emptyModelHistory',!!firstPayload&&!firstPayload.userMemory?.length&&!firstPayload.activeTaskState&&!!ev&&['references','sourceDocuments','relatedTasks'].every(k=>Array.isArray(ev[k])&&!ev[k].length)&&!!conv&&['recentMessages','messageIndex','recentAttempts'].every(k=>Array.isArray(conv[k])&&!conv[k].length)&&!conv.pendingRequest,{memory:firstPayload?.userMemory,activeTask:firstPayload?.activeTaskState,references:ev?.references?.length,documents:ev?.sourceDocuments?.length,relatedTasks:ev?.relatedTasks?.length,recentMessages:conv?.recentMessages?.length});
 check('noMediaSubmission',r.mediaAttempts===0,r.mediaAttempts);
 if(c.expected.texts!==undefined)check('artifactCount',arts.length===c.expected.texts,{expected:c.expected.texts,actual:arts.length});
 if(c.expected.texts>0)check('completed',r.status==='completed',r.status);
 if(c.expected.needsInput)check('clarifiesMissingReference',r.status==='needs_input'&&tasks.every(t=>t.status==='NEEDS_INPUT'),{status:r.status,tasks:tasks.map(t=>t.status)});
 const skills=Object.values(s.taskStore?.toolCalls||{}).filter(x=>x.name==='run_skill').map(x=>({slug:x.args.slug,status:x.status,artifactId:x.result?.artifactId,contractValidated:x.result?.contractValidated}));
 for(const slug of c.expected.skills||[])check('skill:'+slug,skills.some(x=>x.slug===slug&&x.contractValidated),skills);
 const windows=gens.map(x=>({nodeId:x.nodeId,start:x.startedAt,end:x.finishedAt}));
 const overlap=windows.some((a,i)=>windows.slice(i+1).some(b=>a.nodeId!==b.nodeId&&Date.parse(a.start)<Date.parse(b.end)&&Date.parse(b.start)<Date.parse(a.end)));
 if(c.expected.noDependencies)check('noDependencyEdges',items.length===2&&items.every(i=>!i.dependsOn?.length),items.map(i=>i.dependsOn));
 if(c.expected.parallel)check('actualParallelCalls',overlap,windows);
 if(c.expected.fullDependency){
  const upstream=arts.find(a=>a.itemId===items[0]?.id),down=gens.find(x=>x.nodeId===items[1]?.id),p=down&&payload(down),source=p?.sources?.find(x=>x.id===upstream?.id);
  check('dependencyEdge',items[1]?.dependsOn?.includes(0),items[1]?.dependsOn);
  check('fullUpstreamContent',!!upstream&&source?.content===upstream.content,{artifactId:upstream?.id,sourceId:source?.id});
  check('correctVersion',!!upstream&&source?.version===upstream.version,{artifactVersion:upstream?.version,sourceVersion:source?.version});
  check('upstreamFinishesFirst',!!down&&Date.parse(gens[0]?.finishedAt)<=Date.parse(down.startedAt),windows);
 }
 let selection;
 if(c.expected.indexes){
  const down=gens.find(x=>x.nodeId===items[1]?.id),sources=down?payload(down)?.sources:[],binding=items[1]?.resolvedSelectorBinding,up=arts.find(a=>a.id===binding?.sourceArtifactId),downArt=arts.find(a=>a.itemId===items[1]?.id),source=sources?.find(x=>x.id===up?.id),units=up?.metadata?.structure?.[c.expected.unitType]||[];
  selection={binding,artifactBinding:downArt?.metadata?.sourceSelectionBinding,sources};
  check('boundRequestedIndexes',JSON.stringify(binding?.indexes)===JSON.stringify(c.expected.indexes),binding);
  check('upstreamUnitCount',units.length===c.expected.upstreamUnits,{expected:c.expected.upstreamUnits,actual:units.length});
  check('realSourceVersion',!!up&&binding?.version===up.version&&source?.version===up.version,{artifactId:up?.id,version:up?.version});
  check('bindingReceiptMatches',!!binding&&JSON.stringify(binding)===JSON.stringify(downArt?.metadata?.sourceSelectionBinding));
  if(c.expected.unitType==='directions'){
   const idx=c.expected.indexes[0],selected=units[idx-1];
   check('onlySelectedDirectionContent',!!selected&&source?.selectedDirection?.content===selected.content&&!source.content&&!source.structure?.directions,{index:source?.selectedDirection?.index});
   check('noUnselectedUnitBody',units.length>0&&units.filter((_,i)=>!c.expected.indexes.includes(i+1)).every(u=>!JSON.stringify(sources).includes(JSON.stringify(u.content).slice(1,-1))));
  }else check('onlySelectedShotBodies',units.length>0&&JSON.stringify(source?.structure?.shots)===JSON.stringify(c.expected.indexes.map(i=>units[i-1])),source?.structure?.shots);
 }
 if(c.expected.waitApproval){
  const task=tasks[0],ap=task?.approval,nodes=task?.executionPlan?.nodes||[];
  check('savedPendingMediaPlan',task?.status==='WAIT_CONFIRM'&&ap?.required&&ap?.status==='pending'&&!!ap.planHash&&ap.payload?.tool==='generate_'+c.expected.mediaType&&nodes.some(n=>n.status==='prepared'),{status:task?.status,approval:ap,nodes});
  check('mediaQuantity',ap?.payload?.items?.length===c.expected.quantity,ap?.payload?.items?.length||0);
 }
 let copy;
 if(c.expected.bodyMin){
  const parts=(arts[0]?.content||'').trim().split(/\n\s*\n/),title=parts.at(-1),body=parts.slice(0,-1).join('').replace(/\s/g,'');
  copy={title,body,bodyCharacters:[...body].length,bodyWithoutPunctuation:[...body.replace(/[\p{P}\p{Z}\s]/gu,'')].length,contentCharacters:[...(arts[0]?.content||'').replace(/\s/g,'')].length};
  check('bodyLength',copy.bodyWithoutPunctuation>=c.expected.bodyMin&&copy.bodyWithoutPunctuation<=c.expected.bodyMax,copy);
  for(const fact of c.expected.facts)check('fact:'+fact,(arts[0]?.content||'').includes(fact));
 }
 const rounds=calls.map((x,index)=>{
  const p=payload(x);let parsed;try{parsed=JSON.parse(text(x));}catch{}
  let wireValid,wireErrors;
  if(x.tracePhase==='understand'&&index===0){wireValid=wire(structuredClone(parsed));wireErrors=structuredClone(wire.errors);}
  const errors=(x.validations||[]).filter(v=>v.error).map(v=>({phase:v.phase,error:v.error,failureStage:v.failureStage}));
  const patch=(x.validations||[]).find(v=>v.phase==='fill_missing_fields');
  const usage=x.providerResponse?.usage||{};inputTokens+=usage.input_tokens||0;outputTokens+=usage.output_tokens||0;cachedTokens+=usage.input_tokens_details?.cached_tokens||0;
  return {index,phase:x.tracePhase,methodId:x.methodId,nodeId:x.nodeId,characters:inputs[index].length,systemCharacters:x.input.filter(m=>m.role==='system').reduce((n,m)=>n+JSON.stringify(m.content).length,0),payloadKeys:Object.keys(p||{}),recentMessages:p?.conversation?.recentMessages?.length,wireValid,wireErrors,errors,repairPaths:patch?.paths,patch:patch?.patch,usage};
 });
 const row={id:c.id,dir,group:c.group,tone:c.tone,query:c.query,expected:c.expected,status:r.status,sessionId:s.id,calls:r.calls,checks,strictPassed:checks.every(x=>x.passed),failedChecks:checks.filter(x=>!x.passed).map(x=>x.name),taskStatus:tasks.map(t=>t.status),taskReason:tasks.map(t=>t.reason),artifactCount:arts.length,skills,windows,parallelOverlap:overlap,selection,copy,rounds,final:r.final};
 rows.push(row);
 write(dir+'/checks.json',row);
 write(dir+'/model-inputs.json',calls.map(x=>({id:x.id,phase:x.tracePhase,nodeId:x.nodeId,input:x.input,normalizedRequest:x.normalizedRequest,output:x.output})));
}
const report={cases:rows.length,totalModelCalls:summaries.reduce((n,s)=>n+s.totalCalls,0),recordedModelCalls:rows.reduce((n,r)=>n+r.rounds.length,0),strictPassed:rows.filter(r=>r.strictPassed).length,strictUnmet:rows.filter(r=>!r.strictPassed).length,usage:{inputTokens,outputTokens,cachedTokens,totalTokens:inputTokens+outputTokens},uniqueSessions:new Set(rows.map(r=>r.sessionId)).size,allIsolationChecksPass:rows.every(r=>r.checks.filter(c=>['emptyInitial','noForeignMarkers','noPreviousResponseId'].includes(c.name)).every(c=>c.passed)),actualMediaSubmissions:0,mediaAttempts:summaries.flatMap(s=>s.results).reduce((n,r)=>n+r.mediaAttempts,0),sourceUnchanged:[read('finished.json'),read('media-controls/finished.json')].every(x=>!x.sourceDrift.length&&x.casesUnchanged),firstWirePasses:rows.filter(r=>r.rounds[0]?.wireValid).length,rows};
write('evidence-summary.json',report);
console.log(JSON.stringify({...report,rows:rows.map(r=>({id:r.id,status:r.status,passed:r.strictPassed,failed:r.failedChecks,calls:r.calls,copy:r.copy,errors:r.rounds.flatMap(x=>x.errors),wire:r.rounds[0]?.wireValid}))},null,2));
