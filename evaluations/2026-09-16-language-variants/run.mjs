import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const fixtureDir=path.dirname(fileURLToPath(import.meta.url));
const out=process.env.CHORIFY_EVAL_OUT?path.resolve(process.env.CHORIFY_EVAL_OUT):fixtureDir;
if(!process.argv.includes('--preflight')&&out===fixtureDir)throw Error('Set CHORIFY_EVAL_OUT to a new empty directory; archived evidence is immutable');
fs.mkdirSync(out,{recursive:true});
if(out!==fixtureDir&&!fs.existsSync(path.join(out,'cases.json')))fs.copyFileSync(path.join(fixtureDir,'cases.json'),path.join(out,'cases.json'));
const root=process.env.CHORIFY_ROOT||path.resolve(fixtureDir,path.basename(fixtureDir)==='media-controls'?'../../..':'../..');
process.chdir(root);if(fs.existsSync(root+'/.env'))process.loadEnvFile(root+'/.env');
const mod=f=>import(pathToFileURL(root+'/server/'+f));
const {Agent}=await mod('agent.mjs'),{createBrain,brainConfig}=await mod('adapters.mjs'),{loadCatalog}=await mod('catalog.mjs'),{ToolRuntime}=await mod('tools.mjs'),{Verifier}=await mod('verification.mjs'),{redact}=await mod('trace-context.mjs');
const catalog=await loadCatalog(),config=brainConfig(),cases=JSON.parse(fs.readFileSync(path.join(out,'cases.json'),'utf8'));
const write=(name,v)=>fs.writeFileSync(path.join(out,name),JSON.stringify(redact(v),null,2));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const oldManifest=JSON.parse(fs.readFileSync(path.join(path.basename(fixtureDir)==='media-controls'?path.dirname(fixtureDir):fixtureDir,'source-baseline.json')));
const baseline=oldManifest.after,drift=Object.entries(baseline).filter(([f,h])=>!fs.existsSync(path.join(root,f))||hash(path.join(root,f))!==h).map(([f])=>f);
const safe={provider:config.provider,model:config.model,keyConfigured:!!config.key,actionMode:process.env.BUSINESS_ACTION_MODE||'core',acceptancePolicy:process.env.RESULT_ACCEPTANCE||'delivery_only',protocol:'compiled',effectPolicy:'explicit_approval',imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL,entry:'direct Agent.run on current source; not HTTP/UI',caseCount:cases.length,maxCalls:80,maxCallsPerCase:8,caseTimeoutMs:420000,independentWorkers:2,actualMediaSubmissions:0,baselineDrift:drift};
if(process.argv.includes('--preflight')){write('preflight.json',safe);console.log(JSON.stringify(safe));process.exit(drift.length?1:0);}
if(!config.key||drift.length)throw Error('PREFLIGHT_BLOCKED');
if(fs.existsSync(path.join(out,'started.json')))throw Error('Existing run; refusing duplicate paid requests');
write('started.json',{startedAt:new Date().toISOString(),config:safe,sourceHashes:baseline,casesHash:hash(path.join(out,'cases.json')),origin:'Constructed natural language variants, not collected production user data'});
let totalCalls=0,next=0;const results=[];
async function run(c){
 const dir=path.join(out,c.id);fs.mkdirSync(dir,{recursive:true});
 const state={id:randomUUID(),messages:[],events:[]};
 const initial={sessionId:state.id,messages:0,tasks:0,artifacts:0,inputs:0};
 const brain=createBrain(),base=brain.respond.bind(brain);let calls=0,mediaAttempts=0;
 brain.respond=async(...args)=>{if(calls>=8||totalCalls>=80)throw Object.assign(Error('TEST_BUDGET_REACHED'),{repairTarget:'transport'});calls++;totalCalls++;console.log(JSON.stringify({case:c.id,call:calls,totalCalls,time:new Date().toISOString()}));return base(...args);};
 const blockMedia=async()=>{mediaAttempts++;throw Error('TEST_MEDIA_SUBMISSION_FORBIDDEN');};
 const runtime=new ToolRuntime({catalog,brain,media:{config:{imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL},image:blockMedia,video:blockMedia,getVideo:blockMedia}});
 const verifier=new Verifier(brain,{policy:safe.acceptancePolicy});
 const save=s=>fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(redact(s),null,2));
 const events=[];let error;const start=Date.now();
 try{await new Agent({catalog,brain,runtime,verifier,actionMode:safe.actionMode,save}).run(state,c.query,e=>events.push(e),AbortSignal.timeout(420000),{requestId:randomUUID()});}catch(e){error=e.message;}
 save(state);
 const final=events.findLast(e=>e.type==='final'),artifacts=Object.values(state.taskStore?.artifacts||{}).filter(a=>a.purpose==='deliverable'&&a.publication!=='superseded');
 const result={id:c.id,query:c.query,group:c.group,tone:c.tone,expected:c.expected,initial,status:final?.status||state.lastTurn?.status,error,durationMs:Date.now()-start,calls,mediaAttempts,actualMediaSubmissions:0,final:final?.text,tasks:Object.values(state.taskStore?.tasks||{}),artifacts,modelCalls:(state.modelCalls||[]).map(x=>({id:x.id,nodeId:x.nodeId,tracePhase:x.tracePhase,methodId:x.methodId,status:x.status,startedAt:x.startedAt,finishedAt:x.finishedAt,usage:x.providerResponse?.usage,validations:x.validations,error:x.error}))};
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(redact(result),null,2));
 fs.writeFileSync(path.join(dir,'final.md'),final?.text||error||'No final response');
 for(let i=0;i<artifacts.length;i++)if(artifacts[i].type==='text')fs.writeFileSync(path.join(dir,`artifact-${i+1}.md`),artifacts[i].content||'');
 results.push(result);write('summary.json',{config:safe,totalCalls,finishedCases:results.length,results:[...results].sort((a,b)=>a.id.localeCompare(b.id))});
 console.log(JSON.stringify({case:c.id,done:true,status:result.status,calls,artifacts:artifacts.length,mediaAttempts,error,reason:result.tasks.map(t=>t.reason)}));
}
await Promise.all([0,1].map(async()=>{while(next<cases.length){const c=cases[next++];await run(c);}}));
write('finished.json',{finishedAt:new Date().toISOString(),totalCalls,cases:results.length,actualMediaSubmissions:0,sourceDrift:Object.entries(baseline).filter(([f,h])=>hash(path.join(root,f))!==h).map(([f])=>f),casesUnchanged:hash(path.join(out,'cases.json'))===JSON.parse(fs.readFileSync(path.join(out,'started.json'))).casesHash});
