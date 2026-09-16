import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {createBrain,brainConfig,Doubao} from '../server/adapters.mjs';
import {ArkMedia} from '../server/media.mjs';
import {ExtendedMedia,extendedMediaNames} from '../server/extended-media.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {redact} from '../server/trace-context.mjs';

const suite=process.env.EVAL_SUITE||'C:/Users/asus/Desktop/codex-workspace/chorify-eval-v2-20260914/chorify_focused_eval_v2';
const out=path.resolve(process.env.EVAL_OUT||'data/focused-eval-v2-text-20260914');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const digest=b=>createHash('sha256').update(b).digest('hex');
const write=async(f,x)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(redact(x),null,2));};
const cases=await read(suite+'/cases.json'),profiles=await read(suite+'/config/profiles.json');
const selected=profiles.text_plan_first.case_ids;
const catalog=await loadCatalog();
const denyNames=new Set(['generate_image','edit_image','generate_video','get_video_task','wait_video_task','get_media_task','wait_media_task',...extendedMediaNames]);
const kindFor=n=>['generate_image','edit_image'].includes(n)?'image':['generate_voiceover','clone_voice'].includes(n)?'audio':'video';
let globalRequests=0,queue=0;const results=[],allGuards=[];
const runId=randomUUID(),startedAt=new Date().toISOString();
const limit={totalModelRequests:600,modelRequestsPerTurn:30,turnTimeoutMs:300000,imageSubmissions:0,videoSubmissions:0,audioSubmissions:0,caseConcurrency:3,repeat:1};
const hashes=[];
async function snapshot(root){for(const e of await fs.readdir(root,{withFileTypes:true})){const f=path.join(root,e.name);if(e.isDirectory())await snapshot(f);else{const bytes=await fs.readFile(f);hashes.push({file:f.replaceAll('\\','/'),sha256:digest(bytes)});const target=path.join(out,'source',f);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(f,target);}}}
if(await fs.stat(out+'/version.json').catch(()=>null))throw Error('Refuse overwriting existing evaluation');
await snapshot('server');await snapshot('skills');
for(const f of ['package.json','package-lock.json']){const b=await fs.readFile(f);hashes.push({file:f,sha256:digest(b)});await fs.copyFile(f,out+'/source/'+f);}
await fs.cp(suite,out+'/suite',{recursive:true});
const config={...brainConfig(),key:undefined,hasLLMKey:!!brainConfig().key,hasMediaKey:!!process.env.DOUBAO_API_KEY,imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL,mediaBaseUrl:process.env.DOUBAO_BASE_URL,AGENT_VERIFY:process.env.AGENT_VERIFY||'on',maxSteps:Math.max(2,Math.min(32,Number(process.env.MAX_AGENT_STEPS)||16)),node:process.version};
await write(out+'/version.json',{runId,startedAt,entry:'current-source Agent.run CLI; HTTP/UI/background NOT_TESTED',mode:'text_and_plan_only',selected,limit,config,hashes,suiteZipSHA256:digest(await fs.readFile('C:/Users/asus/Downloads/chorify_focused_eval_v2_no_video.zip')),runningHTTP:{used:false,reloaded:false},productionCodeChanged:false});
await fs.copyFile('scripts/eval-focused-v2-text.mjs',out+'/runner.executed.mjs');

// Guards do not supply capabilities or outputs. They stop media effects and log attempts.
function guard(log,boundary,name,args){const entry={at:new Date().toISOString(),boundary,name,kind:kindFor(name),args};log.push(entry);throw Error('EVAL_MEDIA_FORBIDDEN:'+name);}
async function selftest(){let realNetwork=0;const checks=[];
 for(const name of denyNames){const log=[];try{guard(log,'tool',name,{});}catch{}checks.push({name,passed:log.length===1});}
 const m=new ArkMedia({key:'selftest',baseUrl:'https://example.invalid',imageModel:'image',videoModel:'video'},async()=>{realNetwork++;throw Error('Unexpected network');});
 const actual=m.request.bind(m);m.request=async(p,b,s,method)=>guard(checks,'provider',p.includes('/images/')?'generate_image':'generate_video',b);
 for(const name of ['image','video']){try{await m[name]({prompt:'guard selftest'},AbortSignal.timeout(1000));}catch(e){if(!e.message.startsWith('EVAL_MEDIA_FORBIDDEN'))throw e;}}
 if(realNetwork)throw Error('Guard selftest failed');await write(out+'/guard-selftest.json',{kind:'harness_selftest_NOT_agent_results',passed:true,realNetwork,checks});
}
await selftest();

async function runCase(c){
 const dir=out+'/cases/'+c.id,state={id:randomUUID(),messages:[],actions:{},events:[]};await fs.mkdir(dir,{recursive:true});
 const aliases={},rows=[];let current=null,turnRequests=0,saveChain=Promise.resolve();const guards=[];
 const save=async s=>{const text=JSON.stringify(redact(s));saveChain=saveChain.then(()=>fs.writeFile(dir+'/session.json',text));await saveChain;};
 const cfg=brainConfig(),videoCfg=brainConfig(process.env,'doubao');
 const allowed=new Set([cfg.baseUrl.replace(/\/+$/,'').replace(/\/responses$/,'')+'/responses',new URL('/api/v3/responses',videoCfg.baseUrl).href]);
 const transport=async(url,opts)=>{
  if(!allowed.has(String(url))){guard(guards,'provider_transport','generate_video',{url:String(url)});}
  if(++globalRequests>limit.totalModelRequests||++turnRequests>limit.modelRequestsPerTurn)throw Error('EVAL_MODEL_REQUEST_CAP');
  const rec={turnId:current.id,startedAt:new Date().toISOString(),url:String(url),request:JSON.parse(opts.body)};
  try{const res=await fetch(url,opts);rec.status=res.status;rec.response=await res.clone().json().catch(()=>({unparseable:true}));return res;}
  catch(e){rec.error=e.message;throw e;}finally{rec.finishedAt=new Date().toISOString();await fs.appendFile(dir+'/transport.jsonl',JSON.stringify(redact(rec))+'\n');}
 };
 const brain=createBrain(process.env,transport),videoBrain=brain.config.provider==='deepseek'?new Doubao(videoCfg,transport):brain;
 const media=new ArkMedia({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL||'https://ark.cn-beijing.volces.com',imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL},async(url,opts)=>guard(guards,'provider_transport',String(url).includes('/images/')?'generate_image':'generate_video',{url,body:opts?.body}));
 media.request=async(p,b)=>guard(guards,'provider_request',p.includes('/images/')?'generate_image':'generate_video',{path:p,body:b});
 const extended=new ExtendedMedia(process.env,{fetchImpl:async(url,opts)=>guard(guards,'extended_transport','generate_video',{url,body:opts?.body})});
 extended.request=async(base,p,key,b)=>guard(guards,'extended_provider','generate_video',{base,path:p,body:b});
 const runtime=new ToolRuntime({catalog,brain,media,extended,python:process.env.PYTHON_BIN});const execute=runtime.execute.bind(runtime);
 runtime.execute=async(name,args,s,signal)=>{if(denyNames.has(name))guard(guards,'tool',name,args);return execute(name,args,s,signal);};
 const agent=new Agent({brain,runtime,catalog,save,verifier:process.env.AGENT_VERIFY==='off'?null:new Verifier(brain,{videoBrain}),maxSteps:config.maxSteps});
 for(const t of c.turns){current=t;turnRequests=0;const missing=t.expected.required_source_aliases.filter(a=>!aliases[a]);
  const row={case_id:c.id,turn_id:t.id,run_id:runId,repetition:1,mode:'text_and_plan_only',procedure_status:'EVIDENCE_MISSING',content_status:'NEEDS_REVIEW',quality_status:'NOT_APPLICABLE',trace_refs:[],observed_new_images:0,observed_image_edits:0,observed_video_attempts:0,provider_video_requests:0,notes:'',query:t.user_query};
  if(missing.length){Object.assign(row,{procedure_status:'BLOCKED_BY_UPSTREAM',content_status:'NOT_EVALUATED',executed:false,missing_source_aliases:missing,first_failure_stage:'upstream',notes:'前序没有产生所需可用成果；未补造状态，也未发送依赖轮。'});rows.push(row);results.push(row);await write(dir+'/'+t.id+'-result.json',row);console.log(JSON.stringify({id:t.id,executed:false,missing}));continue;}
  const before=structuredClone(state),start=Date.now(),gs=guards.length;let final,error;
  await write(dir+'/'+t.id+'-before.json',before);
  console.log(JSON.stringify({id:t.id,event:'start'}));
  try{await agent.run(state,t.user_query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(limit.turnTimeoutMs));}catch(e){error=e.message;}await saveChain;
  const turn=state.turns?.at(-1),task=state.taskStore?.tasks[turn?.taskId],calls=(state.modelCalls||[]).filter(x=>x.runId===turn?.runId),attempts=guards.slice(gs);
  const artifacts=Object.values(state.taskStore?.artifacts||{}).filter(a=>!before.taskStore?.artifacts?.[a.id]);
  const delivered=artifacts.filter(a=>a.type==='text'&&a.publication==='current'&&a.purpose==='deliverable'&&a.content);
  const prepared=Object.values(task?.batches||{}).filter(b=>b.items?.length);
  const produced={};
  for(const b of t.expected.produce_bindings){
   if(b.type==='text'&&delivered.length){produced[b.alias]={type:'text',artifactIds:delivered.map(a=>a.id),versions:delivered.map(a=>a.version),taskId:task.id,contentHashes:delivered.map(a=>digest(a.content)),bindingStatus:delivered.length===1?'single_document_requires_semantic_audit':'candidate_set_requires_semantic_audit'};}
   if(b.type==='plan'&&prepared.length&&task?.approval?.payload){produced[b.alias]={type:'plan',taskId:task.id,revision:task.revision,batchIds:prepared.map(b=>b.batchId),planHash:task.approval.planHash,bindingStatus:'persisted_plan_requires_semantic_audit'};}
  }
  Object.assign(aliases,produced);
  Object.assign(row,{executed:true,sessionId:state.id,agentRunId:turn?.runId,status:final?.status,taskStatus:task?.status,durationMs:Date.now()-start,modelRequests:turnRequests,modelCalls:calls.length,error:error||turn?.error||task?.reason||null,final:final?.text||null,produced_bindings:produced,required_bindings:Object.fromEntries(t.expected.required_source_aliases.map(a=>[a,aliases[a]])),guardAttempts:attempts,observed_video_attempts:attempts.filter(a=>a.kind==='video').length,trace_refs:['cases/'+c.id+'/'+t.id+'-after.json','cases/'+c.id+'/transport.jsonl'],first_failure_stage:state.events.filter(e=>e.runId===turn?.runId).some(e=>e.type==='intent_error')?'intake':null});
  if(error||!final||['failed','blocked','needs_input','refused'].includes(final.status)||attempts.length){row.procedure_status='FAIL';row.content_status='NOT_EVALUATED';}
  if(attempts.length)row.first_failure_stage='forbidden_media_attempt';
  rows.push(row);results.push(row);await write(dir+'/'+t.id+'-after.json',state);await write(dir+'/'+t.id+'-result.json',row);await write(dir+'/bindings.json',aliases);
  console.log(JSON.stringify({id:t.id,event:'finished',status:row.status,modelCalls:row.modelCalls,durationMs:row.durationMs,bindings:Object.keys(produced),reason:row.error}));
 }
 allGuards.push(...guards.map(g=>({...g,caseId:c.id})));await write(dir+'/results.json',rows);
}
const jobs=cases.filter(c=>selected.includes(c.id));
await Promise.all(Array.from({length:limit.caseConcurrency},async()=>{while(queue<jobs.length){const c=jobs[queue++];try{await runCase(c);}catch(e){await write(out+'/harness-error-'+c.id+'.json',{error:e.message,stack:e.stack});console.error(JSON.stringify({caseId:c.id,harnessError:e.message}));}}}));
for(const c of cases)for(const t of c.turns)if(!results.some(r=>r.turn_id===t.id))results.push({case_id:c.id,turn_id:t.id,run_id:runId,repetition:1,mode:selected.includes(c.id)?'text_and_plan_only':'UNSET',procedure_status:selected.includes(c.id)?'HARNESS_ERROR':'NOT_RUN',content_status:'NOT_RUN',quality_status:'NOT_RUN',trace_refs:[],observed_new_images:null,observed_image_edits:null,observed_video_attempts:null,provider_video_requests:null,notes:selected.includes(c.id)?'See harness error':'用户选择暂只执行文字测试；未选择此组。'});
results.sort((a,b)=>a.turn_id.localeCompare(b.turn_id,undefined,{numeric:true}));
await fs.writeFile(out+'/results.raw.jsonl',results.map(r=>JSON.stringify(redact(r))).join('\n')+'\n');
const changed=[];for(const h of hashes)if(digest(await fs.readFile(h.file))!==h.sha256)changed.push(h.file);
await write(out+'/execution-summary.json',{runId,startedAt,finishedAt:new Date().toISOString(),globalRequests,selectedTurns:50,executed:results.filter(r=>r.executed).length,upstreamBlocked:results.filter(r=>r.procedure_status==='BLOCKED_BY_UPSTREAM').length,unselected:70,guards:allGuards,videoProviderSubmissions:0,newVideoTaskIds:0,videoOutputs:0,imageProviderSubmissions:0,audioProviderSubmissions:0,sourceChanged:changed,auditStatus:'PENDING; runtime completion is not an evaluation PASS'});
console.log(JSON.stringify({event:'evaluation_finished',out,requests:globalRequests,executed:results.filter(r=>r.executed).length,sourceChanged:changed}));
