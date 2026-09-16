import {fieldPatchFor} from './runtime-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {structuredOutput,specializeMediaSchema,restoreContractConstants} from '../server/goal-compiler.mjs';
import {readFile} from 'node:fs/promises';
import Ajv from 'ajv';
import {understandGoal} from './intake-compat.mjs';
import {validatePlan,validateSemantic} from '../server/intent.mjs';
import {Verifier} from '../server/verification.mjs';
import {intakeSnapshot,itemContext,methodContext,mediaRequirements} from '../server/model-context.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {mediaSkills} from '../server/media-skill-contracts.mjs';
const message=value=>[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}];
const signal=()=>new AbortController().signal;

test('recorded malformed JSON is not fed back as a draft during schema recovery',async()=>{
 const fixtures=JSON.parse(await readFile(new URL('./fixtures/malformed-stability-output.json',import.meta.url),'utf8'));
 for(const f of fixtures){let calls=0;assert.throws(()=>JSON.parse(f.raw));
  const out=await structuredOutput({respond:async input=>{if(++calls===1)return [{type:'message',content:[{type:'output_text',text:f.raw}]}];assert.ok(!input.some(m=>m.role==='assistant'));assert.ok(input.some(m=>m.role==='user'&&m.content.includes('original_request')));return message({content:'recovered'});}},'write',{query:'original_request'},{type:'object',required:['content'],additionalProperties:false,properties:{content:{type:'string'}}},signal());
  assert.equal(calls,2);assert.equal(out.content,'recovered');
 }
});
test('repair carries the rejected output so unaffected fields can be preserved',async()=>{
 let calls=0;const previous={prompt:'17:9 coffee',duration:5,ratio:'16:9'};
 const result=await structuredOutput({respond:async input=>{
  if(++calls===1)return message(previous);
  assert.ok(input.some(m=>m.role==='assistant'&&m.content.includes('17:9 coffee')),'missing rejected candidate');
  return message({...previous,prompt:'16:9 coffee'});
 }},'prepare',{}, {type:'object'},signal(),v=>{if(v.prompt.includes('17:9'))throw new Error('wrong ratio in prompt');});
 assert.equal(result.duration,5);
});
test('routing cannot silently turn modification into creation',()=>{
 const semantic={deliverables:[{kind:'text',action:'modify',purpose:'marketing',requiredEvidence:'none'}]};
 assert.throws(()=>validatePlan({routes:[{deliverableIndex:0,operation:'marketing_script',skills:[]}]},semantic,{skills:[]}),/修改|动作/);
});
test('text verifier receives original query and assumptions with source provenance',async()=>{
 const task={query:'产品是猫抓板，只写三条文案',goal:{assumptions:['材质未知，不能当作产品事实'],semantic:{gaps:[{description:'材质未知',level:'factual',resolution:'不声明'}]}},items:[]};
 const state={taskStore:{activeTaskId:'t',tasks:{t:task},artifacts:{},inputs:{},executions:{}}};
 const verifier=new Verifier({respond:async input=>{const p=JSON.parse(input[1].content[0].text);assert.equal(p.evidenceContext.query,task.query);assert.deepEqual(p.evidenceContext.assumptions,task.goal.assumptions);return message({passed:false,uncertain:false,issues:['无材质依据']});}});
 await verifier.verifyText({id:'i',operation:'marketing_script',description:'猫抓板文案',references:[],dependsOn:[],constraints:[],spec:{}},'双面瓦楞纸',state,signal());
});
test('word count keeps text before an internal colon',async()=>{
 const verifier=new Verifier({respond:async input=>{const p=JSON.parse(input[1].content[0].text);assert.equal(p.lengthEvidence[0].body,'猫说：沙发不错，你说：请用猫抓板');return message({passed:true,uncertain:false,issues:[]});}});
 await verifier.verifyText({operation:'marketing_script',description:'文案',references:[],dependsOn:[],constraints:[]},'猫说：沙发不错，你说：请用猫抓板',{},signal());
});
test('intake projection removes execution prompts but preserves facts, IDs and confirmation',()=>{
 const source={id:'task',status:'WAIT_CONFIRM',query:'按原图改蓝背景',goal:{summary:'修改',assumptions:['无材质信息'],semantic:{deliverables:[{spec:{exactTexts:['原文']}}]}},approval:{required:true,planHash:'hash',payload:{items:[{prompt:'用户待确认的方案'}]}},items:[{id:'item',references:['image'],spec:{ratio:'16:9'},methods:[{input:{methodReferences:['旧宫格内容']}}]}],artifacts:[{id:'image',purpose:'deliverable',url:'https://a.invalid/source.png'},{id:'internal',purpose:'support',content:'旧宫格内容'}]};
 const before=JSON.stringify(source),out=intakeSnapshot(source);
 assert.ok(!JSON.stringify(out).includes('旧宫格内容'));assert.equal(out.items[0].references[0],'image');assert.equal(out.items[0].spec.exactTexts[0],'原文');assert.equal(out.approval.payload.items[0].prompt,'用户待确认的方案');assert.equal(JSON.stringify(source),before);
});
test('media method context uses explicit workflows and excludes legacy fixture assumptions',async()=>{
 const catalog=await loadCatalog();const methods=methodContext(catalog,mediaSkills[1]);
 assert.equal(methods.length,3);assert.ok(methods.every(m=>m.workflow.length));assert.ok(JSON.stringify(methods).length<600);assert.doesNotMatch(JSON.stringify(methods),/前序已锁定|宫格|首帧/);
});
test('text item context preserves exact constraints and excludes recursive execution metadata',()=>{
 const item={id:'i',description:'改稿',constraints:['禁止治疗宣称'],spec:{exactTexts:['重点不可截断']},methods:[{input:'noise'}],artifactIds:['unrelated'],issues:['old issue']};
 assert.deepEqual(itemContext(item).spec,item.spec);assert.deepEqual(itemContext(item).constraints,item.constraints);assert.equal(itemContext(item).methods,undefined);
});
test('compiler owns fixed media parameters while missing creative content still fails',async()=>{
 const schema=specializeMediaSchema(mediaSkills[1],{spec:{durationSeconds:5,ratio:'16:9'}},1);
 const plan=items=>({concept:'coffee',preservedConstraints:[],safety:{passed:true,reason:'safe'},items});
 let calls=0;const result=await structuredOutput({respond:async()=>{calls++;return message(plan([{prompt:'coffee'}]));}},'contract',{},schema,signal());
 assert.equal(calls,1);assert.equal(result.items[0].duration,5);assert.equal(result.items[0].ratio,'16:9');
 const fixed=await structuredOutput({respond:async()=>message(plan([{prompt:'coffee',duration:9,ratio:'720p'}]))},'contract',{},schema,signal());
 assert.deepEqual(fixed.items[0],{prompt:'coffee',duration:5,ratio:'16:9'});
 await assert.rejects(()=>structuredOutput({respond:async()=>message(plan([{duration:5,ratio:'16:9'}]))},'contract',{},schema,signal()));
});
test('four recorded DeepSeek omissions fail raw schema and survive compiler restoration without changing prose',async()=>{
 const fixtures=JSON.parse(await readFile(new URL('./fixtures/context-failures.json',import.meta.url),'utf8'));
 for(const c of fixtures){const validate=new Ajv({strict:false}).compile(specializeMediaSchema(mediaSkills[1],c.goal,c.goal.count));
  assert.equal(validate(c.output),false,c.id+' originally rejected');
  const repaired=restoreContractConstants(structuredClone(c.output),specializeMediaSchema(mediaSkills[1],c.goal,c.goal.count));
  assert.equal(validate(repaired),true,c.id+' compiled constants restored');
  assert.deepEqual(repaired.items.map(i=>i.prompt),c.output.items.map(i=>i.prompt));
 }
});
test('upstream script sees the same video defaults as compiler, excluding unrelated media',()=>{
 const script={id:'script',index:0},storyboard={id:'board',index:1,dependsOn:[0]},video={id:'video',operation:'generate_video',dependsOn:[1],spec:{}},independent={id:'other',operation:'generate_video',dependsOn:[],spec:{durationSeconds:12,ratio:'9:16'}};
 const req=mediaRequirements([script,storyboard,video,independent],script);
 assert.equal(req.length,1);assert.equal(req[0].durationSeconds,5);assert.equal(req[0].ratio,'16:9');assert.equal(req[0].origin.ratio,'default');
 const schema=specializeMediaSchema(mediaSkills[1],video,1);assert.equal(schema.properties.items.items.properties.duration.const,req[0].durationSeconds);
 assert.equal(mediaRequirements([independent],independent)[0].ratio,'9:16');
});
test('media references cannot create an unfulfillable text-observation obligation',async()=>{
 const value={summary:'参考图生成品牌海报',deliverables:[{description:'品牌海报',kind:'image',count:1,action:'create',purpose:'marketing',requiredEvidence:'image',references:['https://example.invalid/source.png'],dependsOn:[],constraints:['无文字'],requestEvidence:'生成海报'}],gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''},continuation:{mode:'new',taskId:''}};
 assert.throws(()=>validateSemantic(structuredClone(value)),/媒体.*none/);
 const corrected=structuredClone(value);corrected.deliverables[0].requiredEvidence='none';let calls=0;
 const goal=await understandGoal({respond:async input=>message(++calls===1?value:fieldPatchFor(input,corrected))},{skills:[]},{query:'参考图生成品牌海报',assets:[{url:'https://example.invalid/source.png',kind:'image'}],strictControl:true},signal());
 assert.equal(calls,2);assert.equal(goal.tasks[0].requiredEvidence,'none');assert.deepEqual(goal.tasks[0].references,value.deliverables[0].references);
});
