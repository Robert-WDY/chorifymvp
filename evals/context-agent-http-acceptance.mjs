// Evaluate the selected live localhost service; never substitutes an in-process agent.
import {mkdir,writeFile,appendFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {HistoryStore} from '../server/context-agent/history.mjs';
import {acceptanceCases,acceptanceCategories,canContinueAcceptance} from './context-agent-acceptance-cases.mjs';

const args=process.argv.slice(2),value=(key,fallback)=>args.find(a=>a.startsWith(key+'='))?.slice(key.length+1)||fallback;
const base=value('--url','http://127.0.0.1:3217'),url=new URL(base);
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.protocol!=='http:')throw new Error('Local HTTP target required');
const out=resolve(value('--out',join('evaluation-runs','http-3217-'+new Date().toISOString().replace(/[:.]/g,'-'))));
const data=resolve(value('--data','data/isolated-local')),budget=Number(value('--budget','512'));
if(!Number.isInteger(budget)||budget<16||budget>1024)throw new Error('Budget must be 16..1024');
const config=await(await fetch(base+'/api/config')).json(),{csrf,...publicConfig}=config;
if(config.engine!=='context-agent'||!config.modelEnabled||config.mediaMode!=='simulation')throw new Error('Expected enabled Context Agent with simulated media');
if(!args.includes('--run')){console.log(JSON.stringify({base,data,out,budget,config:publicConfig,cases:acceptanceCases.length}));process.exit(0);}
await mkdir(out,{recursive:false});
const write=(name,obj)=>writeFile(join(out,name),JSON.stringify(obj,null,2)+'\n');
const store=new HistoryStore(data),results=[];let modelCalls=0;
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceHashes={};
for(const file of ['server/context-agent/loop.mjs','server/context-agent/prompt.md','server/context-agent/tools.mjs','server/context-agent/context.mjs'])sourceHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
const manifest={startedAt:new Date().toISOString(),base,data,workingTreeSha:sha,sourceHashes,config:publicConfig,budget,entry:'live HTTP service; only newly created evaluation sessions exported',realVideo:false,realMedia:false,semanticReview:'pending',note:'Working tree revision observed at run start; service PID/startup identity recorded separately. No fault injection through live HTTP.'};
await write('manifest.json',manifest);await write('cases.json',acceptanceCases);
const checkpoint=()=>write('run.json',{...manifest,modelCalls,results,updatedAt:new Date().toISOString()});
const post=(path,body,signal)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-context-token':csrf},body:JSON.stringify(body),signal});
// Short single-turn probes first, then independent journeys, pressure case last.
const order=Object.keys(acceptanceCategories);
const cases=[...acceptanceCases].sort((a,b)=>a.id==='AC_MEMORY'?1:b.id==='AC_MEMORY'?-1:order.indexOf(a.category)-order.indexOf(b.category));
for(const c of cases){
 if(c.blockedReason){results.push({id:c.id,category:c.category,status:'not_run',reason:c.blockedReason});await checkpoint();continue;}
 if(modelCalls+config.limits.maxModelCalls>budget){results.push({id:c.id,category:c.category,status:'not_run',reason:'Insufficient remaining call budget for one bounded service turn'});await checkpoint();continue;}
 await mkdir(join(out,c.id));
 const created=await post('/api/session',{});if(!created.ok)throw new Error('Session create failed '+created.status);
 const {id:sessionId}=await created.json(),row={id:c.id,category:c.category,sessionId,rounds:[],semantic:'pending',faultCoverage:c.fault?'not_exercised_live_http':null};results.push(row);await checkpoint();
 for(const [i,turn]of c.turns.entries()){
  if(modelCalls+config.limits.maxModelCalls>budget){row.reason='Call budget';break;}
  const prefix=c.id+'/round-'+(i+1),request={sessionId,message:turn.user,requestId:c.id+':'+i};
  await write(prefix+'-request.json',request);
  let events=[],status,httpStatus;const started=Date.now();
  try{
   const response=await post('/api/chat',request,AbortSignal.timeout(240000));httpStatus=response.status;
   if(!response.ok)throw new Error('Chat HTTP '+response.status);
   const decoder=new TextDecoder();let pending='';
   for await(const chunk of response.body){
    const text=decoder.decode(chunk,{stream:true});await appendFile(join(out,prefix+'-events.ndjson'),text);pending+=text;
    const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line.trim())events.push(JSON.parse(line));
   }
   pending+=decoder.decode();if(pending.trim())events.push(JSON.parse(pending));
   status=events.findLast(e=>e.type==='end')?.status||'missing_end';
  }catch(error){
   status='transport_error';row.error=error.message;
   await post('/api/cancel',{sessionId});
   // Wait only for this request's cancellation to settle before exporting its trace.
   for(let k=0;k<20;k++){const s=await(await fetch(base+'/api/session/'+sessionId)).json();if(!s.running)break;await new Promise(r=>setTimeout(r,500));}
  }
  const trace=await store.exportSession(sessionId,'local');await write(c.id+'/session.json',trace);
  const calls=trace.records.filter(r=>r.kind==='run_event'&&r.event==='model_request').length;
  row.modelCalls=calls;modelCalls=results.reduce((n,r)=>n+(r.modelCalls||0),0);
  const snapshot=await(await fetch(base+'/api/session/'+sessionId)).json();await write(prefix+'-snapshot.json',snapshot);
  row.rounds.push({round:i+1,user:turn.user,status,httpStatus,elapsedMs:Date.now()-started,modelCalls:events.findLast(e=>e.type==='end')?.modelCalls});
  row.status=status;await write(c.id+'/rounds.json',row.rounds);await checkpoint();
  console.log(JSON.stringify({case:c.id,round:i+1,status,calls,totalCalls:modelCalls}));
  if(!canContinueAcceptance({status}))break;
 }
 await write(c.id+'/review.json',{status:'pending',expected:c.expected,evidenceRequirements:c.evidence,skill:c.skill||null,missingInputs:c.missingInputs||[],faultCoverage:row.faultCoverage,earliestFailureStage:null,evidence:[]});
}
manifest.finishedAt=new Date().toISOString();await checkpoint();console.log(JSON.stringify({out,modelCalls,cases:results.length}));
