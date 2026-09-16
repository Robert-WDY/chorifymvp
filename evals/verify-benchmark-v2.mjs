import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scoreCase} from './benchmark-v2-scoring.mjs';
const root=new URL('../data/benchmark-v2-200/',import.meta.url);
const {metadata,results}=JSON.parse(await readFile(new URL('results.json',root),'utf8'));
const bytes=await readFile(new URL('source.json',root));
const source=JSON.parse(bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'),metadata.sourceHash);
assert.equal(results.length,200);assert.equal(new Set(results.map(r=>r.id)).size,200);
assert.equal((await readdir(new URL('runs/',root))).filter(p=>p.endsWith('.json')).length,200);
assert.ok(Object.values(metadata.unchanged).every(Boolean),'Frozen source changed');
let modelCalls=0;
for(const result of results){
 const c=source.find(c=>c.id===result.id);
 assert.ok(c);assert.equal(result.query,c.query);assert.deepEqual(result.history,c.history);assert.deepEqual(result.expected,c.expected);
 const run=JSON.parse(await readFile(new URL('runs/'+result.id+'.json',root),'utf8'));
 assert.deepEqual(result,run.result);
 const score=scoreCase(c,run.state);
 for(const [key,value] of Object.entries(score))assert.deepEqual(result[key],value,result.id+' score '+key);
 assert.equal(run.modelCalls.length,result.modelCallCount);
 let input=[];
 for(const call of run.modelCalls){
  assert.ok(Number.isInteger(call.inputPrefixLength)&&call.inputPrefixLength>=0&&call.inputPrefixLength<=input.length);
  input=[...input.slice(0,call.inputPrefixLength),...call.inputSuffix];
  assert.equal(input[0]?.role,'system');
  assert.ok(call.output||call.error,'Missing model response record');
  modelCalls++;
 }
 assert.ok(run.state.events.some(e=>e.type==='final'),result.id+' missing final event');
}
const verification={verifiedAt:new Date().toISOString(),rows:results.length,modelCalls,sourceHashMatches:true,frozenCodeUnchanged:true,allScoresRecomputed:true,allTracesMatchSummary:true,allModelInputsReconstructable:true};
await writeFile(new URL('verification.json',root),JSON.stringify(verification,null,2));
console.log(JSON.stringify(verification));
