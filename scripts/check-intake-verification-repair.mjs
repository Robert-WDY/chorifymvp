import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createBrain} from '../server/adapters.mjs';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {understandGoal} from '../server/intent.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {taskSnapshot} from '../server/task-state.mjs';
import {Verifier} from '../server/verification.mjs';
import {verifyArtifactOnce} from '../server/verification-attempt.mjs';
import {withTrace,tracedBrain,redact} from '../server/trace-context.mjs';
const file='data/manual-fixed-server/5d574506-77bc-4ae5-b29f-8bc66a60e9e0.json';
const before=await readFile(file),original=JSON.parse(before),catalog=await loadCatalog();
const failedCall=original.modelCalls.find(c=>c.id==='4d7d6367-bc6a-4ff6-b84a-a88938332ccf');
const oldPayload=JSON.parse(failedCall.input.at(-1).content),brain=createBrain();
const directory=process.argv[2]||'data/repair-replay-20260911';await mkdir(directory,{recursive:true});
const report={createdAt:new Date().toISOString(),sourceSession:original.id,provider:brain.config.provider,model:brain.config.model,mediaSubmissions:0,cases:[]};
const save=async()=>writeFile(directory+'/trace.json',JSON.stringify(redact(report),null,2));
async function run(name,fn){
 const state=structuredClone(original);state.currentRunId='repair-'+name;state.modelCalls=[];state.turns=[];
 const result={name,state};report.cases.push(result);
 try{result.result=await withTrace(state,save,()=>fn(state));result.status='passed';}
 catch(error){result.status='failed';result.error=error.message;result.partialSemantic=error.partialSemantic;process.exitCode=1;}
 await save();console.log(JSON.stringify(redact({name,status:result.status,error:result.error,result:result.result,calls:state.modelCalls.length})));
}
async function intake(state,replay){
 let n=0;const adapter=tracedBrain({config:brain.config,respond:async(...args)=>replay&&n++===0?structuredClone(failedCall.output):brain.respond(...args)});
 const snapshots=Object.values(state.taskStore.tasks).map(t=>taskSnapshot(state,t));
 const assets=oldPayload.assets.map(a=>({...a,url:state.taskStore.artifacts[a.assetId]?.url||a.url}));
 const g=await understandGoal(adapter,catalog,{query:oldPayload.query,history:oldPayload.history,assets,taskSnapshot:taskSnapshot(state),taskCandidates:snapshots,strictControl:true,auditContracts:true},AbortSignal.timeout(180000));
 assert.equal(g.semantic.continuation.mode,'new');assert.equal(g.semantic.approval.required,false);assert.equal(g.tasks.length,1);assert.equal(g.tasks[0].output,'text');
 assert.ok(g.tasks[0].references.includes(assets[0].assetId));assert.equal(g.requestContract.media.video,0);
 if(replay)assert.ok(state.modelCalls.some(c=>c.validations?.some(v=>v.phase==='fill_missing_fields')));
 let final;
 if(!replay){
  const forbidden=async()=>{report.mediaSubmissions++;throw new Error('回放禁止媒体提交');};
  const runtime=new ToolRuntime({catalog,brain,media:{config:{},image:forbidden,video:forbidden,getVideo:forbidden}});
  const agent=new Agent({catalog,brain,runtime,verifier:new Verifier(tracedBrain(brain)),intake:async()=>g,save});
  await agent.run(state,oldPayload.query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(240000));
  assert.equal(final?.status,'completed');assert.ok(final.text.length>100);assert.equal(report.mediaSubmissions,0);
 }
 return {goal:g,final,replayedFirstCall:replay?failedCall.id:null};
}
await run('partial-intake',state=>intake(state,true));
await run('fresh-intake',state=>intake(state,false));
await run('reference-verification',async state=>{
 const a=state.taskStore.artifacts['ffdc46ab-a124-49de-aa07-752942d3b976'];
 const item=state.taskStore.tasks[a.taskId].items.find(i=>i.id===a.itemId),v=new Verifier(tracedBrain(brain)),signal=AbortSignal.timeout(120000);
 const verdict=await verifyArtifactOnce(v,item,a,state,signal),calls=state.modelCalls.length;
 const repeated=await verifyArtifactOnce(v,item,a,state,signal);assert.equal(state.modelCalls.length,calls);assert.deepEqual(repeated,verdict);
 assert.equal(state.modelCalls[0].input[1].content.filter(p=>p.type==='input_image').length,2);
 assert.equal(verdict.errorKind,undefined);assert.ok(['passed','failed','uncertain'].includes(verdict.outcome));
 return {artifactId:a.id,verdict,modelCalls:calls,verificationAttempts:a.verificationAttempts.length};
});
report.sourceUnchanged=createHash('sha256').update(before).digest('hex')===createHash('sha256').update(await readFile(file)).digest('hex');
assert.equal(report.sourceUnchanged,true);await save();
