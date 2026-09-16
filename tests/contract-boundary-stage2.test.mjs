import test from 'node:test';import assert from 'node:assert/strict';import Ajv from 'ajv';
import {hardTextChecks,enforceHardChecks,countBody,renderTextUnits} from '../server/hard-requirements.mjs';
import {reconcileFixedSpec} from '../server/fixed-spec.mjs';
import {semanticSchema} from '../server/intent.mjs';import {operationInputSchema} from '../server/turn-operation.mjs';
import {Verifier} from '../server/verification.mjs';import {currentTask,taskArtifacts,reconcileTask} from '../server/task-state.mjs';
import {fixture,contract,textItem,archived,signal} from './contract-boundary-fixture.mjs';
const budget={min:80,max:120,unit:'non_punctuation_characters'};
const item={output:'text',form:'copy',count:1,spec:{bodyLength:budget}};
const result=body=>{const structure={textUnits:[{body,titleAfter:'短标题'}]};return{structure,content:renderTextUnits(structure.textUnits)};};
test('stage2 body count excludes title, punctuation, whitespace and Markdown with exact inclusive boundaries',()=>{
 for(const n of [79,80,120,121]){const r=result('文'.repeat(n)+'，。 **！');r.structure.textUnits[0].titleAfter='题'.repeat(80);r.content=renderTextUnits(r.structure.textUnits);assert.equal(hardTextChecks(item,r).status,n>=80&&n<=120?'passed':'failed');}
 assert.equal(countBody('甲 🌱，乙','non_punctuation_characters'),3);assert.equal(countBody('甲 乙，','characters'),4);
});
test('stage2 actual rendered content must match measured body; missing evidence is uncertain, not false success',()=>{
 const r=result('文'.repeat(90));r.content=r.content.slice(0,50);const report=hardTextChecks(item,r);
 assert.equal(report.status,'not_evaluated');const v=enforceHardChecks({passed:true,issues:[]},report);assert.equal(v.passed,false);assert.equal(v.uncertain,true);
 assert.equal(hardTextChecks(item,{content:'无法确认标题边界的旧正文'}).status,'not_evaluated');
});
test('stage2 body-only rendering cannot conceal undelivered structured shots behind a passing numeric count',()=>{
 const r=result('文'.repeat(90));r.structure.shots=[{content:'隐藏镜头',durationSeconds:2}];
 assert.equal(hardTextChecks({...item,form:'script',spec:{...item.spec,shotCount:1,durationSeconds:2}},r).status,'not_evaluated');
});
test('stage2 historical short bodies fail under the new typed requirement; archive remains unchanged',()=>{
 for(const id of ['11-text-casual','12-text-terse']){const a=archived(id,'result').artifacts[0],parts=a.content.trim().split(/\n\s*\n/),body=parts.slice(0,-1).join('');
  const report=hardTextChecks(item,result(body));assert.equal(report.status,'failed');assert.ok(report.checks[0].actual<80);
 }
});
test('stage2 literal constraint normalization and wire schema use one length contract',()=>{
 for(const text of ['正文80到120字','正文 80—120 字','正文80-120字。']){const d=textItem({constraints:[text]});reconcileFixedSpec(d);assert.deepEqual(d.spec.bodyLength,budget);const v=new Ajv({strict:false}).compile(operationInputSchema(semanticSchema));assert.ok(v(contract([d])),JSON.stringify(v.errors));}
 assert.throws(()=>reconcileFixedSpec({spec:{bodyLength:{...budget,min:130}}}),/冲突/);
 assert.throws(()=>reconcileFixedSpec({constraints:['正文80到120字'],spec:{bodyLength:{...budget,max:99}}}),/不一致/);
});
test('stage2 known shot mismatch fails; the two former summary-only fixture outputs remain unverified',()=>{
 const i={operation:'storyboard',form:'script',spec:{shotCount:4,durationSeconds:8,secondsPerShot:2}};
 for(const r of [{content:'蓝色静物，四镜各2秒。'},{content:'蓝色静物：镜1 0–2秒；镜2 2–4秒；镜3 4–6秒；镜4 6–8秒。',structure:{hook:'蓝色静物',body:'四镜各2秒',cta:'收尾'}}]){const v=enforceHardChecks({passed:true,issues:[]},hardTextChecks(i,r));assert.equal(v.passed,false);assert.equal(v.uncertain,true);}
 const bad={structure:{shots:Array.from({length:4},()=>({content:'镜头',durationSeconds:1}))},content:'分镜'};assert.equal(hardTextChecks(i,bad).status,'failed');
});
test('stage2 delivery-only retries the failed candidate, records exact accepted body hash and preserves its sibling',async()=>{
 const draft=contract([textItem({description:'第一份'}),textItem({description:'第二份',spec:{bodyLength:budget}})]),generated=[];
 const f=fixture({draft,generate:(p)=>{generated.push(p.item.description);return p.item.description==='第一份'?{content:'已完成的第一份'}:{structure:{textUnits:[{body:'文'.repeat(generated.filter(x=>x==='第二份').length===1?60:90),titleAfter:'标题'}]}};}});
 await f.run('两份独立文字，第二份正文80到120字');assert.equal(currentTask(f.state).status,'COMPLETED');assert.equal(generated.filter(x=>x==='第一份').length,1);
 const artifacts=taskArtifacts(f.state),failed=artifacts.find(a=>a.publication==='audit'),passed=artifacts.find(a=>a.metadata.structure?.textUnits&&a.publication==='current');assert.ok(failed);assert.equal(failed.acceptance.hardRequirements.status,'failed');assert.equal(passed.acceptance.hardRequirements.status,'passed');assert.equal(passed.acceptance.hardRequirements.inputHash,passed.metadata.conversion.outputHash);
 passed.content+='篡改';reconcileTask(f.state);assert.notEqual(currentTask(f.state).status,'COMPLETED');
});
test('stage2 repeated underlength output is retained for audit and never completes',async()=>{
 const f=fixture({draft:contract([textItem({spec:{bodyLength:budget}})]),generate:()=>({structure:{textUnits:[{body:'短正文',titleAfter:'再长的标题也不是正文'}]}})});
 await f.run('正文80到120字，标题放末尾');assert.notEqual(currentTask(f.state).status,'COMPLETED');assert.equal(taskArtifacts(f.state).filter(a=>a.publication==='current').length,0);assert.equal(taskArtifacts(f.state).length,1);assert.equal(f.calls.filter(c=>c.phase==='text_generation').length,2);
});
test('stage2 compiled media cannot complete on mismatched or absent metadata; no vision or regeneration is faked',async()=>{
 const verifier=new Verifier({respond:()=>{throw Error('must not call model');}},{policy:'delivery_only'}),state={taskStore:{activeTaskId:'t',tasks:{t:{protocol:'compiled-v1'}}}};
 for(const [i,a] of [[{spec:{ratio:'9:16'}},{type:'image',url:'https://example.invalid/a',metadata:{provider:{size:'1024x1024'}}}],[{spec:{durationSeconds:5,ratio:'16:9'}},{type:'video',url:'https://example.com/offline-video.mp4',metadata:{provider:{duration:3,ratio:'16:9'}}}]]){assert.equal((await verifier.verifyArtifact(i,a,state,signal())).passed,false);delete a.metadata.provider;const v=await verifier.verifyArtifact(i,a,state,signal());assert.equal(v.passed,false);assert.equal(v.uncertain,true);}
 const originalEdit={type:'image',url:'https://example.com/action-2.png',metadata:{args:{size:'2048x2048'},provider:{}}};assert.equal((await verifier.verifyArtifact({operation:'edit_image',spec:{}},originalEdit,state,signal())).uncertain,true);
});
