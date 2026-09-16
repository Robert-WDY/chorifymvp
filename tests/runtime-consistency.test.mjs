import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import Ajv from 'ajv';
import {compactPromptSchema} from '../server/prompt-schema.mjs';
import {semanticSchema,intentPrompt} from '../server/intent.mjs';
import {operationInputSchema,inspectionGoal} from '../server/turn-operation.mjs';
import {composeFinalResponse,responseContext} from '../server/final-response.mjs';
import {queryChecks} from '../server/runtime-facts.mjs';
import {runtimeVersion} from '../server/runtime-version.mjs';
import {hasPlatformDependency} from '../scripts/platform-check.mjs';
const reply=text=>[{type:'message',content:[{type:'output_text',text}]}];
const safety={disposition:'allow',untrustedInstructions:false,reason:''};
const draft={summary:'模型查询',turnOperation:{kind:'inspect',query:{kind:'model_identity'}},deliverables:[],approval:{required:false,reason:''},safety};
test('prompt schema deduplication expands to the identical contract and keeps validators strict',()=>{
 const original=operationInputSchema(semanticSchema),compact=compactPromptSchema(original);
 const expand=v=>!v||typeof v!=='object'?v:Array.isArray(v)?v.map(expand):v.$ref?expand(compact.$defs[v.$ref.split('/').at(-1)]):Object.fromEntries(Object.entries(v).filter(([k])=>k!=='$defs').map(([k,v])=>[k,expand(v)]));
 assert.deepEqual(expand(compact),original);
 assert.ok(JSON.stringify(compact).length<JSON.stringify(original).length*0.8);
 const validate=new Ajv({strict:false}).compile(compact);
 assert.equal(validate(structuredClone(draft)),true);assert.equal(validate({...draft,extra:'not allowed'}),false);
 const bad={...draft,deliverables:[{kind:'image',action:'create',description:'image',count:0}]};assert.equal(validate(bad),false);
 assert.ok(intentPrompt().includes('"$defs"'));
});
test('empty deliverables and explicit empty question dimensions retain the actual user question',()=>{
 for(const answerContract of [undefined,{questionDimensions:[]}]){
  const semantic={...structuredClone(draft),turnOperation:{...draft.turnOperation,answerContract}};
  const goal=inspectionGoal('你是什么模型',semantic,[],[]);
  assert.deepEqual(goal.tasks[0].runtimeQuery.answerContract.questionDimensions,['你是什么模型']);
 }
});
test('retrieved facts and generated prose never masquerade as verified answer coverage',async()=>{
 const facts={query:{type:'model_identity'},modelIdentity:{configuredModel:'fixture'}};
 assert.equal(queryChecks(facts).queryResolved,true);assert.equal(queryChecks(facts).answerCovered,false);
 const turn={rawInput:'你是什么模型',queryReceipt:{facts}};
 await composeFinalResponse({respond:async()=>reply('收到。')},{messages:[]},turn,{text:'',artifacts:[]},new AbortController().signal);
 assert.equal(turn.responseReceipt.status,'composed');assert.equal(turn.responseReceipt.coverage.status,'unverified');assert.equal(turn.responseReceipt.coverage.semanticVerified,false);
});
test('composer supplements requested ledger counts even when model omits them, without mutating task',async()=>{
 const task={id:'t',query:'两张依赖图片',status:'PENDING',completionStatus:'pending',intentSnapshot:{origin:'first_parsed_intent'},goal:{},requirements:[{id:'r1',type:'image',goal:'第一张',count:1,produced:1,status:'fulfilled'},{id:'r2',type:'image',goal:'第二张',count:1,produced:0,status:'pending'}]};
 const state={messages:[],taskStore:{activeTaskId:'t',tasks:{t:task},artifacts:{a:{id:'a',taskId:'t',type:'image',purpose:'deliverable',sourceExecutionId:'e'}},executions:{e:{status:'succeeded'}}}};
 const before=JSON.stringify(state),turn={rawInput:'完成了吗？要求几张？生成几张？',queryReceipt:{facts:{query:{type:'task_inspect',taskIds:['t'],answerContract:{scope:'task',questionDimensions:['completion_status','required_count','produced_count','remaining_count']}}}}};
 const answer=await composeFinalResponse({respond:async()=>reply('已读取记录。')},state,turn,{artifacts:[],text:'',status:'completed'},new AbortController().signal);
 assert.match(answer,/尚未全部完成/);assert.match(answer,/要求 2，已生成 1，待交付 1/);assert.equal(turn.responseReceipt.coverage.status,'evidence_presented');assert.equal(JSON.stringify(state),before);
 task.intentSnapshot.origin='legacy_accepted_contract';
 await composeFinalResponse({respond:async()=>reply('已读取记录。')},state,turn,{artifacts:[],text:''},new AbortController().signal);
 assert.equal(turn.responseReceipt.coverage.status,'unverified');
});
test('identity composer does not receive unrelated task/history bodies; history query retains selected original evidence',()=>{
 const state={messages:[{role:'assistant',content:'irrelevant old answer'},{role:'user',content:'你是什么模型'},{role:'assistant',content:'placeholder'}],taskStore:{tasks:{old:{id:'old',query:'unrelated task',goal:{},items:[]}},artifacts:{},executions:{}}};
 const turn={rawInput:'你是什么模型',queryReceipt:{facts:{query:{type:'model_identity'}}}},event={artifacts:[]};
 const context=responseContext(state,turn,event);assert.deepEqual(context.state.selectedTasks,[]);assert.equal(context.priorAnswer,undefined);assert.equal(context.state.sessionMedia,undefined);
 turn.queryReceipt.facts={query:{type:'history'},message:{messageId:'m',content:'exact original answer'}};
 assert.equal(responseContext(state,turn,event).facts.message.content,'exact original answer');
});
test('runtime fingerprint detects edits while preserving loaded version and excluding env/session data',async t=>{
 const root=await mkdtemp(join(tmpdir(),'runtime-version-'));
 t.after(async()=>{if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error('unsafe test directory');await rm(root,{recursive:true,force:true});});
 for(const d of ['server','dist','skills'])await mkdir(join(root,d));
 for(const f of ['package.json','package-lock.json'])await writeFile(join(root,f),'{}');
 await writeFile(join(root,'server','test.mjs'),'export const version=1;');const build=await runtimeVersion(root);
 assert.equal((await build.inspect()).matches,true);await writeFile(join(root,'.env'),'TEST_VALUE=private');assert.equal((await build.inspect()).matches,true);
 await writeFile(join(root,'server','test.mjs'),'export const version=2;');const current=await build.inspect();assert.equal(current.matches,false);assert.equal(current.loaded,build.loaded);assert.notEqual(current.current,build.loaded);
});
test('platform dependency check allows branding but rejects legacy imports and endpoint dependency',()=>{
 assert.equal(hasPlatformDependency("console.log('Chorify Debug')"),false);
 assert.equal(hasPlatformDependency('import x from '+JSON.stringify('@'+'chorify/runtime')),true);
 assert.equal(hasPlatformDependency('const endpoint='+JSON.stringify('/api/'+'mcp')),true);
 assert.equal(hasPlatformDependency("import {Agent} from './agent.mjs'"),false);
});
