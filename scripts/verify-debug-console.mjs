// Offline archive integration check: no Agent, recovery, provider, or network imports.
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {DebugTraceStore} from '../server/debug-trace.mjs';
const [archiveArg,outputArg]=process.argv.slice(2);
if(!archiveArg||!outputArg)throw new Error('node scripts/verify-debug-console.mjs <Stage-A archive directory> <new evidence directory>');
const archive=resolve(archiveArg),out=resolve(outputArg),sessions=join(archive,'sessions');
if(out===archive||out.startsWith(archive+'/')||out.startsWith(archive+'\\'))throw new Error('Evidence output must be outside the original archive');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function manifest(){const files=[];for(const name of await readdir(sessions))if(name.endsWith('.json'))files.push({file:name,sha256:hash(await readFile(join(sessions,name)))});return files;}
const before=await manifest(),samples=JSON.parse(await readFile(join(archive,'sample-index.json'),'utf8'));
const store=new DebugTraceStore([sessions],{boundaryDirectory:join(archive,'boundaries')});
const results=[];await mkdir(out,{recursive:true});
for(const sample of samples){
 const r=await store.run(sample.requestId,{sessionId:sample.sessionId,source:'source0'});
 assert.equal(r.userInput.content,sample.query);assert.ok(r.contextSnapshots.every(c=>c.actualRequest));
 assert.equal(r.tools.length,0);assert.equal(r.delivery.newArtifacts,0);
 const native=JSON.parse(await readFile(join(sessions,sample.sessionId+'.json'),'utf8'));
 assert.equal(r.contextSnapshots.length,native.modelCalls.filter(c=>c.runId===sample.requestId).length);
 if(sample.caseId==='A5'){
  assert.equal(r.intent.acceptedContract,null);assert.equal(r.contextSnapshots.length,3);assert.equal(r.evaluation.cutoff,false);
  assert.equal(r.intent.candidates.filter(c=>c.validations.some(v=>v.accepted===false)).length,3);
  assert.ok(r.errors.some(e=>String(e.message).includes('方案增量必须唯一绑定原视频方案')));
 }else{assert.ok(r.intent.acceptedContract);assert.equal(r.evaluation.cutoff,true);}
 results.push({sampleId:sample.sampleId,runId:r.runId,sessionId:r.sessionId,status:r.status,modelCalls:r.contextSnapshots.length,accepted:!!r.intent.acceptedContract,cutoff:r.evaluation.cutoff,tools:r.tools.length,newArtifacts:r.delivery.newArtifacts,usage:r.contextSnapshots.map(c=>c.usage),diagnostics:r.diagnostics.map(d=>({category:d.category,severity:d.severity})),sourceSha256:r.evidence.sha256});
 if(['A5-1','A6-2','A1-1'].includes(sample.sampleId))await writeFile(join(out,sample.sampleId+'.debug.json'),JSON.stringify(r,null,2));
}
const after=await manifest();assert.deepEqual(after,before);
const dashboard=await store.failures({});assert.equal(dashboard.window,18);assert.equal(dashboard.groups.evaluation_cutoff.length,15);assert.equal(dashboard.groups.recorded_error.length,3);
const report={checkedAt:new Date().toISOString(),offline:true,newProviderCalls:0,sourceFilesUnchanged:true,caseCount:results.length,archivedModelCalls:results.reduce((n,r)=>n+r.modelCalls,0),accepted:results.filter(r=>r.accepted).length,cutoff:results.filter(r=>r.cutoff).length,results,dashboard,sourceManifest:after};
await writeFile(join(out,'archive-validation.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({caseCount:report.caseCount,archivedModelCalls:report.archivedModelCalls,accepted:report.accepted,cutoff:report.cutoff,newProviderCalls:0,sourceFilesUnchanged:true}));
