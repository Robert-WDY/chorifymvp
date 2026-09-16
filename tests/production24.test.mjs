import test from 'node:test';
import assert from 'node:assert/strict';
import {score} from '../evals/production24/scorer.mjs';
import {cases} from '../evals/production24/cases.mjs';
const fixture=()=>({state:{status:'simulated',events:[],taskStore:{activeTaskId:'t',tasks:{t:{id:'t',items:[{id:'i',count:1,output:'image'}]}},executions:{e:{status:'succeeded',result:{images:[{url:'https://fixtures.invalid/one.png'}]}}},artifacts:{a:{id:'a',taskId:'t',itemId:'i',type:'image',purpose:'deliverable',url:'https://fixtures.invalid/one.png',sourceExecutionId:'e',metadata:{simulated:true},verification:{technical:'passed',semantic:'simulated_passed'}}}}},calls:[],submissions:[],snapshots:[],provider:{faults:[]}});
const c={id:'test',expect:{image:1}};
test('production suite preserves 24 source cases and adds four explicit variants',()=>{assert.equal(cases.length,28);assert.equal(new Set(cases.map(c=>c.sourceId)).size,24);assert.equal(new Set(cases.map(c=>c.id)).size,28);for(const c of cases){assert.ok(c.queries.length);assert.ok(c.queries.every(q=>typeof q==='string'&&q.trim()));}});
test('scorer rejects invented artifact URL despite completed status',()=>{const t=fixture();t.state.taskStore.artifacts.a.url='https://fixtures.invalid/invented.png';assert.equal(score(c,t).hard.noFakeMedia,false);assert.equal(score(c,t).passed,false);});
test('scorer rejects completed status without artifact',()=>{const t=fixture();t.state.taskStore.artifacts={};assert.equal(score(c,t).hard.noFalseCompletion,false);});
test('scorer separates simulated and production completion',()=>{const t=fixture();t.state.status='completed';assert.equal(score(c,t).hard.simulationLabel,false);});

test('scorer recognizes multiline text dependency without losing JSON escaping',()=>{
 const t=fixture(),s=t.state.taskStore;s.artifacts.a={id:'a',taskId:'t',itemId:'i',type:'text',purpose:'deliverable',content:'第一镜\n第二镜',metadata:{unitCount:3},verification:{technical:'passed',semantic:'passed'}};s.tasks.t.items[0]={id:'i',count:3,output:'text'};s.tasks.t.executionPlan={nodes:[{kind:'media',dependsOn:['i']}]};t.calls=[{tools:[],input:[{content:JSON.stringify({methodReferences:[],sources:[{content:'第一镜\n第二镜'}]})}]}];const r=score({id:'test',expect:{text:1,states:['simulated'],dependency:true}},t);assert.equal(r.checks.consumedSource,true);assert.equal(r.hard.noFalseCompletion,true);
});
test('scorer rejects approval followed by changed parameters',()=>{const t=fixture();t.snapshots=[{task:{status:'WAIT_CONFIRM',approval:{planHash:'frozen',payload:{items:[{prompt:'original'}]}}},submissionCount:0}];t.submissions=[{tool:'generate_image',args:{prompt:'changed'},completedItemIds:[]}];assert.equal(score({id:'test',expect:{image:1,confirm:true}},t).hard.approvalIntegrity,false);});
test('scorer rejects duplicate unknown submissions',()=>{const t=fixture();t.state.status='blocked';t.state.taskStore.executions.e.status='unknown';t.submissions=[{args:{prompt:'x'}},{args:{prompt:'x'}}];t.provider.faults=['unknown'];assert.equal(score({id:'test',expect:{states:['blocked'],fault:'unknown'}},t).hard.noUnknownRetry,false);});
