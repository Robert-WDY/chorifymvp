// Offline diagnosis of saved real traces. No model/media calls and no product edits.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const out=path.dirname(fileURLToPath(import.meta.url)),root=process.env.CHORIFY_ROOT||path.resolve(out,path.basename(out)==='media-controls'?'../../..':'../..');
process.chdir(root);const mod=f=>import(pathToFileURL(root+'/server/'+f)),read=p=>JSON.parse(fs.readFileSync(path.join(out,p),'utf8'));
const {bindRequestEvidence}=await mod('request-input.mjs'),{assertWorkflow}=await mod('planning-boundary.mjs'),{isDeferred}=await mod('stage-contract.mjs'),{loadCatalog}=await mod('catalog.mjs'),{Verifier}=await mod('verification.mjs');
const catalog=await loadCatalog(),output={modelCalls:0,mediaCalls:0,productEdits:0,diagnoses:[]};
const s=read('01-dep-casual/state.json'),r=read('01-dep-casual/result.json'),draft=JSON.parse(s.modelCalls[0].output[0].content[0].text),currentMessage={role:'user',content:r.query,messageId:'diagnostic-current'};
let originalError;try{bindRequestEvidence(structuredClone(draft),{query:r.query,currentMessage});}catch(e){originalError={message:e.message,issues:e.issues};}
assert.equal(originalError?.issues?.[0]?.path,'/deliverables/1/requestEvidence');
const corrected=structuredClone(draft);corrected.deliverables[1].requestEvidence='就用后一个接着写8秒的四镜脚本，每镜2秒，脚本另存一份。';
const bound=bindRequestEvidence(corrected,{query:r.query,currentMessage});
assert.deepEqual(bound.deliverables[1].sourceSelection,draft.deliverables[1].sourceSelection);
output.diagnoses.push({case:'01-dep-casual',originalError,localCounterfactual:'Only the saved quote was replaced with a genuine continuous excerpt, in memory; binding then passed. This is not a new real-model success.',repairedEvidence:bound.deliverables[1].evidenceSegments,selectionUnchanged:true});
const empty=read('20-empty-formal/result.json'),task=empty.tasks[0],item=task.items[0];assert.equal(isDeferred(item),true);
let workflowError;try{assertWorkflow(item,task.items,catalog);}catch(e){workflowError={message:e.message,code:e.code};}
assert.equal(workflowError?.code,'missing_dependency');
output.diagnoses.push({case:'20-empty-formal',isDeferred:true,activation:item.activation,workflowError,conclusion:'A deferred missing-source item is rejected by workflow preflight before the later deferred-stage guard.'});
const verifier=new Verifier({respond(){throw Error('NO_MODEL_IN_OFFLINE_DIAGNOSIS');}},{policy:'delivery_only'});
for(const id of ['11-text-casual','12-text-terse']){
 const rr=read(id+'/result.json'),ss=read(id+'/state.json'),verdict=await verifier.verifyText(rr.tasks[0].items[0],rr.artifacts[0].content,ss,AbortSignal.timeout(1000));
 assert.equal(verdict.passed,true);
 const p=rr.artifacts[0].content.trim().split(/\n\s*\n/),body=p.slice(0,-1).join('');
 output.diagnoses.push({case:id,bodyCharacters:[...body.replace(/\s/g,'')].length,bodyWithoutPunctuation:[...body.replace(/[\p{P}\p{Z}\s]/gu,'')].length,verdict,conclusion:'delivery_only accepts the saved short copy; this reproduces the acceptance gap, not a passing business outcome.'});
}
fs.writeFileSync(path.join(out,'offline-diagnosis.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
