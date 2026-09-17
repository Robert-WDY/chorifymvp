import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceCases,acceptanceCategories,selectAcceptanceCases,withAcceptanceFault} from '../evals/context-agent-acceptance-cases.mjs';

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
  const cases=selectAcceptanceCases({categories:[category]});assert.ok(cases.length);
  for(const c of cases){assert.equal(c.category,category);assert.equal(c.sessionMode,category.startsWith('new_')?'new':'multi');assert.ok(c.sessionMode==='new'?c.turns.length===1:c.turns.length>1);}
 }
 assert.equal(Object.keys(acceptanceCategories).flatMap(category=>selectAcceptanceCases({categories:[category]})).length,acceptanceCases.length);
 assert.throws(()=>selectAcceptanceCases({categories:['typo']}));
 assert.throws(()=>selectAcceptanceCases({categories:['new_text'],ids:['AC_SOURCE']}));
 assert.equal(selectAcceptanceCases({categories:['new_text'],ids:['AC_NEW_COPY']}).length,1);
});
