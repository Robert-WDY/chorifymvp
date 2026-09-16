import {simulationEvidence} from './eval-simulation-evidence.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {createBrain} from '../server/adapters.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {SessionStore} from '../server/session-store.mjs';
const base='C:/Users/asus/Desktop/codex-workspace/chorify-eval-20260914/agent_multiturn_user_tests_v1';
const out=path.resolve('data/user-multiturn-eval-20260914');fs.mkdirSync(out,{recursive:true});fs.mkdirSync(out+'/sessions',{recursive:true});
const suite=JSON.parse(fs.readFileSync(base+'/cases.json'));const hashes=JSON.parse(fs.readFileSync(base+'/SHA256SUMS.json'));
const hash=x=>createHash('sha256').update(x).digest('hex');const invalid=Object.entries(hashes).filter(([f,h])=>hash(fs.readFileSync(base+'/'+f))!==h);if(invalid.length)throw new Error('Dataset integrity mismatch');
const catalog=await loadCatalog(),sessions=new SessionStore(out+'/sessions');
const safe=v=>typeof v==='string'?v.replace(/\bsk-[\w-]{12,}\b/g,'[REDACTED_KEY]').replace(/(https?:\/\/[^\s"<>?]+)\?[^\s"<>]*/g,'$1?[REDACTED_QUERY]'):Array.isArray(v)?v.map(safe):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/^(apiKey|key|headers|token|secret)$/i.test(k)?'[REDACTED]':safe(x)])):v;
const save=(f,x)=>fs.writeFileSync(out+'/'+f,JSON.stringify(safe(x),null,2));
const limits={G01:6,G02:8,G03:3,C01:6,C02:6,C03:6,C04:4};
const deps={G01:{3:[2]},G02:{2:[1],4:[3],5:[2],6:[2,4,5],7:[4],8:[2,5]},G03:{3:[2]},C01:{2:[1],3:[2],4:[1],5:[2,4],6:[2]},C02:{2:[1],3:[2],4:[3],5:[1],6:[4,5]},C03:{2:[1],3:[2],4:[3],5:[4],6:[5]},C04:{2:[1],4:[2]}};
const missing={G03:'当前无正常本地图片上传接口；不偷偷seed第4轮源图',G04:'当前无文档上传/读取入口',C04:'真实报价/requestKey对账能力未配置；不注入未真实执行的超时事件'};
let networkCalls=0,stopReason=null;const results=[],receipts=[];
const audit=JSON.parse(fs.readFileSync('data/runtime-mechanism-audit-20260914/version-and-registry.json'));const files=audit.files.map(f=>({path:f.path,sha256:hash(fs.readFileSync(f.path))}));
save('run-manifest.json',{startedAt:new Date().toISOString(),suite:suite.suite_name,casesHash:hash(fs.readFileSync(base+'/cases.json')),packageValidation:invalid.length===0,sourceFiles:files,model:process.env.DEEPSEEK_MODEL,provider:process.env.LLM_PROVIDER,mode:'真实Agent/真实模型/真实文本验收；图片为原生simulation回执；视频和其他外部副作用拒绝；直接Agent入口非HTTP/UI',limits:{maxModelCalls:400,perTurnMilliseconds:240000},capabilityScreen:suite.cases.map(c=>({id:c.id,title:c.title,plannedTurns:limits[c.id]||0,totalTurns:c.turns.length,reason:limits[c.id]?'执行支持前缀；后续按真实前置判断':missing[c.id]||'当前compiled工具链不支持本组必需的业务/数据/工作区能力',required:c.required_capabilities})),noProductionSessionChanges:true});
function progress(){save('summary.partial.json',{networkCalls,stopReason,realMediaSubmissions:0,simulatedImages:receipts.length,results});}
async function runGroup(c){
 const state={id:randomUUID(),messages:[],events:[],evaluation:{caseId:c.id,simulatedMedia:true},transportCalls:[]};const done=new Map();
 const transport=async(url,options)=>{
  if(stopReason)throw new Error('EVAL_STOP:'+stopReason);if(networkCalls>=400){stopReason='global_model_call_budget';throw new Error(stopReason);}const target=new URL(url);if(target.origin!==new URL(process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com').origin||!target.pathname.endsWith('/responses'))throw new Error('EVAL_NETWORK_DENIED');
  const body=JSON.parse(options.body);if(body.input?.some(m=>Array.isArray(m.content)&&m.content.some(p=>['input_image','input_video'].includes(p.type))))throw new Error('EVAL_SIMULATED_MEDIA_CANNOT_BE_VISUALLY_OBSERVED');
  networkCalls++;const record={id:randomUUID(),runId:state.currentRunId,startedAt:new Date().toISOString(),request:body};state.transportCalls.push(record);
  try{const response=await fetch(url,options);record.status=response.status;record.body=await response.clone().json().catch(()=>null);if([401,402,403].includes(response.status)){stopReason='provider_access_or_balance_http_'+response.status;}return response;}catch(e){record.error=e.message;throw e;}finally{record.finishedAt=new Date().toISOString();}
 };
 const brain=createBrain(process.env,transport);
 const deny=async()=>{throw Object.assign(new Error('EVAL_EXTERNAL_WRITE_DENIED'),{uncertain:false});};
 const media={config:{imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL},image:async args=>{const id=randomUUID(),result={simulated:true,images:[{url:'https://chorify-simulation.invalid/'+id+'.png',size:args.size||'2048x2048'}]};receipts.push({id,caseId:c.id,runId:state.currentRunId,args,startedAt:new Date().toISOString(),result,finishedAt:new Date().toISOString()});return result;},video:deny,getVideo:deny};
 const runtime=new ToolRuntime({catalog,brain,media,extended:{capabilities:()=>({}),submit:deny}});
 const verifier=new Verifier(brain);const agent=new Agent({brain,runtime,catalog,verifier,simulation:true,save:s=>sessions.save(s)});
 for(const t of c.turns){
  const row={caseId:c.id,turn:t.turn,query:t.user_query,checksRequired:t.expected_checks,sessionId:state.id,mode:['C01','C02'].includes(c.id)?'B':'A',visualQuality:'not_evaluated'};
  if(t.turn>(limits[c.id]||0)){row.outcome=t.turn===(limits[c.id]||0)+1?'CAPABILITY_GAP':limits[c.id]?'BLOCKED_BY_UPSTREAM':'CAPABILITY_GAP';row.reason=missing[c.id]||'当前注册/编译/入口缺少本组必需能力；未执行或伪造fixture工具';results.push(row);continue;}
  if(stopReason){row.outcome='NOT_RUN';row.reason=stopReason;results.push(row);continue;}
  const blocked=(deps[c.id]?.[t.turn]||[]).filter(n=>!done.get(n)?.prerequisiteAvailable);
  if(blocked.length){row.outcome='BLOCKED_BY_UPSTREAM';row.reason='缺少前序真实合格交付：T'+blocked.join(',T');results.push(row);done.set(t.turn,row);continue;}
  row.requestId=randomUUID();row.startedAt=new Date().toISOString();const callsBefore=state.modelCalls?.length||0,transportBefore=state.transportCalls.length,receiptBefore=receipts.length;let final,error;
  try{await agent.run(state,t.user_query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(240000),{requestId:row.requestId});}catch(e){error=e.message;}
  const turn=state.turns?.at(-1),task=state.taskStore?.tasks[turn?.taskId],calls=(state.modelCalls||[]).slice(callsBefore);row.finishedAt=new Date().toISOString();row.taskId=task?.id||null;row.taskStatus=task?.status;row.final=final;row.error=error||turn?.error||task?.reason;row.modelCalls=calls.length;row.transportCalls=state.transportCalls.length-transportBefore;row.simulatedSubmissions=receipts.filter(r=>r.caseId===c.id&&r.runId===row.requestId).length;
  const acceptable=['COMPLETED','SIMULATED'].includes(task?.status)||(c.id==='G03'&&t.turn===1&&task?.status==='NEEDS_INPUT')||(c.id==='C04'&&[1,2].includes(t.turn)&&task?.status==='WAIT_CONFIRM');
  row.outcome=acceptable&&final?'NEEDS_REVIEW':'FAIL';row.prerequisiteAvailable=acceptable&&!!final;
  if(c.id==='C04'&&t.turn===4&&task?.recovery?.kind==='missing_quote'){row.outcome='CAPABILITY_GAP';row.prerequisiteAvailable=false;}
  if(row.error?.includes('EVAL_')||calls.some(k=>k.error?.includes('EVAL_'))){row.outcome='HARNESS_ERROR';row.prerequisiteAvailable=false;}
  row.simulationEvidence=(task?.items||[]).filter(i=>i.coverage||i.resolvedCoverage).map(i=>simulationEvidence(i,Object.values(state.taskStore.executions),Object.values(state.taskStore.artifacts)));
  if(!acceptable&&Object.values(state.taskStore?.artifacts||{}).some(a=>a.taskId===task?.id&&a.metadata?.simulated)&&task?.items.some(i=>i.coverage)){row.outcome=row.simulationEvidence.length&&row.simulationEvidence.every(e=>e.receiptMapping==='passed')?'NEEDS_REVIEW':'HARNESS_ERROR';row.reason='模拟仅核对规划覆盖和执行回执映射；真实画面未评估，生产质量门禁未放行，不能把流程映射通过当成正式成品完成';row.prerequisiteAvailable=false;}
  row.mechanicalChecks=[{name:'final_emitted',passed:!!final},{name:'no_real_external_writes',passed:true},{name:'terminal_or_expected_wait',passed:acceptable}];
  if(c.id==='G01'&&[4,5].includes(t.turn)){const wanted=c.turns[(t.turn===4?3:1)-1].user_query;const exact=!!final?.text.includes(wanted);row.mechanicalChecks.push({name:'exact_user_history',passed:exact,expected:wanted});if(!exact)row.outcome='FAIL';}
  if(!['C01','C02'].includes(c.id)&&row.simulatedSubmissions){row.outcome='FAIL';row.mechanicalChecks.push({name:'no_unrequested_media',passed:false});}
  if(stopReason&&row.outcome==='FAIL'){row.outcome='ENVIRONMENT_BLOCKED';row.reason=stopReason;}
  results.push(row);done.set(t.turn,row);save(c.id+'-T'+t.turn+'.json',{caseId:c.id,turn:t,assessment:row,state,providerReceipts:receipts.filter(r=>r.caseId===c.id)});progress();console.log(JSON.stringify({case:c.id,turn:t.turn,outcome:row.outcome,status:row.taskStatus,calls:row.modelCalls,error:row.error?.slice(0,220)}));
 }
 progress();
}
let next=0;async function worker(){while(next<suite.cases.length)await runGroup(suite.cases[next++]);}await Promise.all([worker(),worker()]);
save('summary.json',{completedAt:new Date().toISOString(),networkCalls,stopReason,realImageSubmissions:0,realVideoSubmissions:0,simulatedImages:receipts.length,results:results.sort((a,b)=>a.caseId.localeCompare(b.caseId)||a.turn-b.turn)});save('simulated-receipts.json',receipts);
const changed=files.filter(f=>hash(fs.readFileSync(f.path))!==f.sha256);save('source-check.json',{changed,productionUnchanged:changed.length===0});console.log('EVAL_COMPLETE '+JSON.stringify({networkCalls,stopReason,turns:results.length,executed:results.filter(r=>r.startedAt).length,changed}));
