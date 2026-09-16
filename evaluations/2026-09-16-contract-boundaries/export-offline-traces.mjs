// Fresh offline fixtures only. This script never loads .env or remote providers.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {understandGoal} from '../../server/intent.mjs';
import {fixture,contract,textItem,catalog,reply,signal,archived,rawDraft} from '../../tests/contract-boundary-fixture.mjs';
const out=new URL('./',import.meta.url),write=(file,data)=>fs.writeFile(new URL(file,out),JSON.stringify({evidenceType:'offline_fixture_not_real_model',realModelCalls:0,mediaSubmissions:0,...data},null,2)+'\n');
const draft=rawDraft('01-dep-casual'),query=archived('01-dep-casual','result').query,calls=[];
const goal=await understandGoal({respond:async input=>{const p=JSON.parse(input[1].content),value=calls.length?{[p.fieldKeys[p.paths[0]]]:p.evidenceRepair.candidates.find(c=>c.text.startsWith('就用后一个')).text}:draft,output=reply(value);calls.push({input:structuredClone(input),output});return output;}},catalog,{query,actionMode:'core',strictControl:true,auditContracts:true},signal());
assert.equal(calls.length,2);await write('stage1-evidence-trace.json',{query,calls,goal});
const length=fixture({draft:contract([textItem({description:'正文',spec:{bodyLength:{min:80,max:120,unit:'non_punctuation_characters'}}})]),generate:(_p,n)=>({structure:{textUnits:[{body:'文'.repeat(n===1?60:90),titleAfter:'标题不计入正文'}]}})});
await length.run('正文80—120字，末尾加短标题');assert.equal(Object.values(length.state.taskStore.tasks)[0].status,'COMPLETED');
await write('stage2-completion-trace.json',{calls:length.calls,state:length.state});
let generated=0;
const facts=fixture({draft:contract([textItem({description:'Brief'}),textItem({description:'文案',dependsOn:[0],references:['task:0']})],{facts:['周日10点，免费，限15人'],gaps:[{description:'预约条件待确认',level:'factual',resolution:'用户补充'}]}),generate:p=>p.item.description==='Brief'?{content:'周日10点，免费，限15人。预约条件待确认。'}:{content:++generated===1?'到店即参与，具体以实际为准。':'周日10点，免费，限15人，预约条件待确认。'},judge:p=>p.content.includes('到店即参与')?{outcome:'failed',issues:['到店即参与把未知预约条件变成承诺']}:{outcome:'passed',issues:[]}});
await facts.run('先Brief再文案，活动周日10点免费限15人，预约条件不知道。');assert.equal(Object.values(facts.state.taskStore.tasks)[0].status,'COMPLETED');
await write('stage3-facts-trace.json',{calls:facts.calls,state:facts.state});
await write('input-projection-comparison.json',{
 before:{evidence:'../2026-09-16-language-variants/01-dep-casual/model-inputs.json',length:'../2026-09-16-language-variants/11-text-casual/model-inputs.json',facts:'../2026-09-16-language-variants/06-ordered-casual/model-inputs.json'},
 after:{evidence:{trace:'stage1-evidence-trace.json',firstPayload:JSON.parse(calls[0].input[1].content),repairPayload:JSON.parse(calls[1].input[1].content)},length:{trace:'stage2-completion-trace.json',generationInputs:length.calls.filter(c=>c.phase==='text_generation').map(c=>JSON.parse(c.input[1].content))},facts:{trace:'stage3-facts-trace.json',generationInputs:facts.calls.filter(c=>c.phase==='text_generation').map(c=>JSON.parse(c.input[1].content)),verificationInputs:facts.calls.filter(c=>c.phase==='verify_facts').map(c=>JSON.parse(c.input[1].content[0].text))}},
 note:'Before files are historical real-model requests; after files are actual runtime requests to deterministic offline fixtures. They are not a real-model A/B quality result.'});
console.log('Exported 3 offline traces and input projection comparison; real model/media calls: 0.');
