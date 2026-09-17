import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceCases,acceptanceCategories,selectAcceptanceCases,withAcceptanceFault,canContinueAcceptance} from '../evals/context-agent-acceptance-cases.mjs';
import {loadAgentCatalog,readAgentSkill} from '../server/context-agent/skills.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {createSession} from '../server/context-agent/history.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {interactions} from '../server/context-agent/interactions.mjs';

test('acceptance extension covers six themes with reviewable multi-turn evidence',()=>{
 assert.equal(new Set(acceptanceCases.map(c=>c.theme)).size,6);
 assert.equal(new Set(acceptanceCases.map(c=>c.id)).size,acceptanceCases.length);
 for(const c of acceptanceCases){assert.ok(c.turns.length>=1);assert.ok(c.expected);assert.ok(c.evidence.length>=2);}
 assert.ok(acceptanceCases.find(c=>c.id==='AC_PRODUCT').blockedReason);
 assert.ok(acceptanceCases.find(c=>c.id==='AC_MEMORY').requires.includes('summary_coverage_and_eviction'));
});
test('injected failure has no side effect, is scoped to round/tool, retries execute real tool',async()=>{
 let calls=0;const base={definitions:[],execute:async()=>{calls++;return {ok:true};}},log=[];
 const fault={tool:'read_asset',round:2};
 await withAcceptanceFault(base,fault,1,log).execute('read_asset',{},{});
 const tools=withAcceptanceFault(base,fault,2,log);
 await tools.execute('list_assets',{},{});
 assert.equal(calls,2);
 assert.equal((await tools.execute('read_asset',{id:'a'},{})).status,'not_executed');
 assert.equal(calls,2);assert.equal(log.length,1);
 assert.equal((await tools.execute('read_asset',{id:'a'},{})).ok,true);
 assert.equal(calls,3);
 const isolated=[];
 assert.equal((await withAcceptanceFault(base,fault,2,isolated).execute('read_asset',{},{})).ok,false);
});

test('seven categories partition all cases and filter without losing session boundaries',()=>{
 assert.equal(Object.keys(acceptanceCategories).length,7);
 for(const category of Object.keys(acceptanceCategories)){
  const cases=selectAcceptanceCases({categories:[category]});assert.ok(cases.length>=4);
  for(const c of cases){assert.equal(c.category,category);assert.equal(c.sessionMode,category.startsWith('new_')?'new':'multi');assert.ok(c.sessionMode==='new'?c.turns.length===1:c.turns.length>1);}
 }
 assert.equal(Object.keys(acceptanceCategories).flatMap(category=>selectAcceptanceCases({categories:[category]})).length,acceptanceCases.length);
 assert.throws(()=>selectAcceptanceCases({categories:['typo']}));
 assert.throws(()=>selectAcceptanceCases({categories:['new_text'],ids:['AC_SOURCE']}));
 assert.equal(selectAcceptanceCases({categories:['new_text'],ids:['AC_NEW_COPY']}).length,1);
});

test('Skill cases reference readable current methods with explicit and inferred selection',async()=>{
 const catalog=await loadAgentCatalog(),cases=acceptanceCases.filter(c=>c.skill);
 assert.ok(cases.length>=5);
 assert.deepEqual(new Set(cases.map(c=>c.skill.selection)),new Set(['explicit','inferred']));
 for(const c of cases){
  assert.equal(c.category,'new_text');
  const method=await readAgentSkill(catalog,c.skill.slug);
  assert.ok(method.content.length>100);assert.equal(method.slug,c.skill.slug);
  assert.ok(c.evidence.some(e=>e.includes('read_skill')));
 }
});

test('intentional missing inputs remain runnable without fabricated fixtures or blocking flags',()=>{
 const cases=acceptanceCases.filter(c=>c.missingInputs);
 assert.ok(cases.length>=8);
 for(const c of cases){
  assert.ok(c.missingInputs.length);assert.equal(c.blockedReason,undefined);
  assert.deepEqual(c.fixtures,[]);assert.equal(c.expectedBehavior,'clarify_or_partial_delivery');
  assert.ok(c.evidence.some(e=>e.includes('空附件')));
 }
 assert.ok(cases.some(c=>c.id==='AC_MISSING_IMAGE'));
 assert.ok(cases.some(c=>c.id==='AC_MISSING_PROMPT'));
});

test('scripted follow-up resumes actual waiting_user with only the authored user text',async()=>{
 const c=acceptanceCases.find(c=>c.id==='AC_MULTI_MISSING_DRAFT'),state=createSession();
 let calls=0;const inputs=[];
 const agent=new ContextAgent({tools:createTools(),memory:{enabled:false},brain:{respond:async input=>{
  inputs.push(structuredClone(input));
  return !calls++?[{type:'function_call',name:'request_user_input',call_id:'need-original',arguments:JSON.stringify({message:'这里没有昨天的文案，请提供原稿。',questions:[{key:'draft',label:'原稿正文',allowFreeText:true}]})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'雨天也轻松出门。雾桥折叠伞，深蓝色，售价69元。'}]}];
 }}});
 const results=[];
 for(const turn of c.turns){
  const result=await agent.run(state,turn.user);results.push(result);
  if(!canContinueAcceptance(result))break;
 }
 assert.deepEqual(results.map(r=>r.status),['waiting_user','completed']);
 assert.deepEqual(state.records.filter(r=>r.kind==='message'&&r.role==='user').map(r=>r.content),c.turns.map(t=>t.user));
 assert.equal(interactions(state)[0].status,'answered_in_text');
 assert.ok(JSON.stringify(inputs[1]).includes('售价69元'));
 assert.equal(Object.keys(state.assets).length,0);assert.equal(Object.keys(state.approvals).length,0);
 for(const status of ['error','cancelled','budget_exceeded','declined'])assert.equal(canContinueAcceptance({status}),false);
});
