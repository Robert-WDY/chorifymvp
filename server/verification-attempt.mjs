import {verificationSources} from './sources.mjs';
import {createHash} from 'node:crypto';
import {withNode} from './trace-context.mjs';
const running=new WeakMap();
// All runtime entry points share one verification attempt per artifact and run.
// A new explicit run can retry observation, never resubmit the media for this reason.
export async function verifyArtifactOnce(verifier,item,artifact,state,signal){
 const runId=state.currentRunId||'standalone';
 let sources;try{sources=artifact.type==='image'?verificationSources(state,item,artifact):[];}catch(error){sources={unresolved:error.message};}
 const evidenceHash=createHash('sha256').update(JSON.stringify({policy:verifier.policy||'strict',operation:item.operation,description:item.description,constraints:item.constraints,spec:item.spec,references:item.references,dependsOn:item.dependsOn,url:artifact.url,version:artifact.version,metadata:artifact.metadata,sources})).digest('hex');
 const key=runId+':'+evidenceHash;
 const active=running.get(artifact);if(active?.key===key)return active.promise;
 const previous=artifact.verificationAttempts?.findLast(a=>a.runId===runId&&a.evidenceHash===evidenceHash&&a.status==='completed');
 if(previous)return structuredClone(previous.verdict);
 const attempt={runId,evidenceHash,status:'running',startedAt:new Date().toISOString()};(artifact.verificationAttempts??=[]).push(attempt);
 const promise=Promise.resolve().then(()=>withNode(item.id,'artifact_verification',async()=>{
  try{const verdict=await verifier.verifyArtifact(item,artifact,state,signal);attempt.verdict=structuredClone(verdict);attempt.status='completed';return verdict;}
  catch(error){attempt.status='failed';attempt.error=error.message;throw error;}
  finally{attempt.finishedAt=new Date().toISOString();if(running.get(artifact)?.key===key)running.delete(artifact);}
 }));running.set(artifact,{key,promise});return promise;
}
