import test from 'node:test';
import assert from 'node:assert/strict';
import {cases,originals} from '../evals/production500/cases.mjs';
import {score} from '../evals/production500/scorer.mjs';
test('full benchmark retains all 500 original queries and contexts without deduplication',()=>{assert.equal(cases.length,500);assert.equal(new Set(cases.map(c=>c.id)).size,500);assert.equal(new Set(cases.map(c=>c.queries[0])).size,24);for(let i=0;i<500;i++){assert.deepEqual(cases[i].queries,originals[i].conversation.filter(m=>m.role==='user').map(m=>m.content));assert.deepEqual(cases[i].businessContext,originals[i].business_context);}});
test('missing fixture is not counted as task completion',()=>{const c=cases.find(c=>c.name==='继续刚才没有完成的视频'),r=score(c,{state:{status:'needs_input',events:[],taskStore:{activeTaskId:'t',tasks:{t:{id:'t',status:'NEEDS_INPUT',goal:{missingInputs:['缺历史']},items:[]}},artifacts:{},executions:{}}},calls:[],submissions:[],snapshots:[],provider:{faults:[]}});assert.equal(r.passed,true);assert.equal(r.classification,'missing_fixture_or_input');assert.equal(r.realMediaArtifacts,0);});
