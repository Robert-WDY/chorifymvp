import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {memoryThresholds,memoryDefaults} from '../server/context-agent/memory.mjs';
import {loadAgentCatalog} from '../server/context-agent/skills.mjs';
import {finalDeliveryCheck} from '../server/context-agent/delivery-check.mjs';
const context=(state,id)=>({state,ownerId:state.ownerId,turnId:'turn',callId:id,fromModel:true,save:async()=>{}});
const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(name,args,id)=>[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}];
async function perform(state,tools,name,args,id){
 appendRecord(state,{kind:'tool_call',turnId:'turn',callId:id,name,arguments:JSON.stringify(args)});
 const result=await tools.execute(name,args,context(state,id));
 appendRecord(state,{kind:'tool_result',turnId:'turn',callId:id,output:JSON.stringify(result)});return result;
}
async function evidence(name,data){if(process.env.STAGED_CLOSURE_EVIDENCE){await mkdir(process.env.STAGED_CLOSURE_EVIDENCE,{recursive:true});await writeFile(process.env.STAGED_CLOSURE_EVIDENCE+'/'+name+'.json',JSON.stringify(data,null,2)+'\n');}}

test('stage1 separate reply parts do not inherit other objects counts; omitted part still rejected',async()=>{
 let n=0;const state=createSession();const result=await new ContextAgent({tools:createTools(),memory:{enabled:false},brain:{respond:async()=>{
  if(!n++)return call('measure_text',{text:'标题',unit:'characters',items:['标题'],requirements:{itemCount:1},target:{kind:'reply',id:'title'}},'title');
  if(n===2)return call('measure_text',{text:'甲\n\n乙\n\n丙',unit:'characters',items:['甲','乙','丙'],requirements:{itemCount:3},target:{kind:'reply',id:'directions'}},'directions');
  if(n===3)return say('甲\n\n乙\n\n丙');
  return say('标题\n\n甲\n\n乙\n\n丙');
 }}}).run(state,'一个标题，加三个方向');assert.equal(result.status,'completed');assert.equal(result.modelCalls,4);
 await evidence('stage1-parts',{result,state});
});
test('stage1 explicit correction replaces mistaken constraints using current original, not historic or invented quotes',async()=>{
 const state=createSession(),tools=createTools();const user=appendRecord(state,{kind:'message',role:'user',turnId:'turn',content:'正文40到60字。'});
 await perform(state,tools,'measure_text',{text:'甲'.repeat(80),unit:'characters',requirements:{min:80,max:120}},'wrong');
 const base={text:'甲'.repeat(50),unit:'characters',requirements:{min:40,max:60}};
 assert.equal((await perform(state,tools,'measure_text',base,'unannounced')).deliveryCheck.status,'failed');
 const correction={callId:'unannounced',messageId:user.id,quote:'正文40到60字',reason:'之前误把下限理解为80，用户实际要求40到60'};
 const invalid=await tools.execute('measure_text',{...base,correction:{...correction,quote:'至少80字'}},context(state,'invalid'));assert.equal(invalid.ok,false);
 const fixed=await perform(state,tools,'measure_text',{...base,correction},'fixed');assert.equal(fixed.deliveryCheck.status,'passed');
 const again=await perform(state,tools,'measure_text',base,'again');assert.equal(again.deliveryCheck.status,'passed');
 await evidence('stage1-correction',{fixed,again,state});
});
test('stage1 checked document can be saved and followed by normal status; changed or failed draft cannot use receipt',async()=>{
 const state=createSession(),tools=createTools();let n=0;const draft='桂花入茶，午后慢饮。';
 const result=await new ContextAgent({tools,memory:{enabled:false},brain:{respond:async()=>{
  if(!n++)return call('measure_text',{text:draft,unit:'characters',requirements:{min:8,max:20}},'measure');
  if(n===2)return call('save_document',{content:draft,measurementCallId:'measure'},'save');return say('文稿已保存。');
 }}}).run(state,'写8到20字并保存，最后告诉我已保存');assert.equal(result.status,'completed');assert.equal(Object.keys(state.assets).length,1);
 const resultState=createSession();await perform(resultState,tools,'measure_text',{text:'短',unit:'characters',requirements:{min:4},target:{kind:'document',id:'doc'}},'bad');
 assert.equal((await tools.execute('save_document',{content:'短',measurementCallId:'bad'},context(resultState,'save'))).error.code,'document_check_failed');
 await perform(resultState,tools,'measure_text',{text:'正文四字',unit:'characters',requirements:{min:4},target:{kind:'document',id:'doc'}},'good');
 assert.equal((await tools.execute('save_document',{content:'换了正文',measurementCallId:'good'},context(resultState,'changed'))).ok,false);
 await evidence('stage1-saved-document',{result,state});
});
test('stage1 failed document/asset checks cannot be bypassed by a final status message',async()=>{
 const s=createSession(),tools=createTools();
 await perform(s,tools,'measure_text',{text:'太短',unit:'characters',requirements:{min:4},target:{kind:'document',id:'draft'}},'bad');
 assert.equal(finalDeliveryCheck(s,'turn','已保存。')?.ok,false);
 await perform(s,tools,'measure_text',{text:'满足字数',unit:'characters',requirements:{min:4},target:{kind:'document',id:'draft'}},'good');
 assert.equal(finalDeliveryCheck(s,'turn','已保存。')?.ok,false);
 await perform(s,tools,'save_document',{content:'满足字数',measurementCallId:'good'},'saved');
 assert.equal(finalDeliveryCheck(s,'turn','已保存。'),null);
 s.assets.a={id:'a',type:'text',version:1,content:'短'};
 await perform(s,tools,'measure_text',{assetId:'a',assetVersion:1,unit:'characters',requirements:{min:4}},'asset');
 assert.equal(finalDeliveryCheck(s,'turn','全部完成。')?.ok,false);
});

test('stage1 feedback distinguishes ordinary counting from checked saving and body selection from parent selection',async()=>{
 const s=createSession(),tools=createTools();
 await perform(s,tools,'measure_text',{text:'普通文稿',unit:'characters'},'count');
 const wrongReceipt=await perform(s,tools,'save_document',{content:'普通文稿',measurementCallId:'count'},'invalid');
 assert.equal(wrongReceipt.error.code,'document_check_failed');assert.match(wrongReceipt.error.message,/普通计数/);
 assert.equal((await perform(s,tools,'save_document',{content:'普通文稿'},'plain-save')).ok,true);
 const badBody=await perform(s,tools,'measure_text',{text:'**完整正文**',bodyText:'完整 正文',unit:'characters'},'body');
 assert.match(badBody.error.message,/bodyText/);assert.doesNotMatch(badBody.error.message,/资产ID/);
 assert.equal((await perform(s,tools,'measure_text',{bodyText:'不能代替text',unit:'characters'},'missing')).ok,false);
});

test('stage1 measuring a saved version reads its actual body and rejects a different supplied text/version',async()=>{
 const s=createSession(),tools=createTools();s.assets.a={id:'a',type:'text',version:2,content:'实际正文'};
 const args={assetId:'a',assetVersion:2,unit:'characters',requirements:{min:4}};
 const result=await tools.execute('measure_text',args,context(s,'m'));assert.equal(result.count,4);assert.equal(result.deliveryCheck.status,'passed');
 assert.equal((await tools.execute('measure_text',{...args,text:'冒充正文'},context(s,'wrong'))).ok,false);
 assert.equal((await tools.execute('measure_text',{...args,assetVersion:1},context(s,'old'))).ok,false);
});
test('stage2 long source revision uses exact version without copying source and reaches final feedback',async()=>{
 const state=createSession(),tools=createTools(),original='原稿'.repeat(2000);state.assets.a={id:'a',type:'text',version:3,content:original};
 let n=0;const result=await new ContextAgent({tools,memory:{enabled:false},brain:{respond:async()=>!n++?call('save_document',{parentId:'a',parentVersion:3,content:original+'。'},'revision'):say('已保存新版本。')}}).run(state,'原稿末尾加句号保存新版本');
 assert.equal(result.status,'completed');assert.equal(Object.values(state.assets).find(a=>a.parentId==='a').content,original+'。');assert.equal(state.assets.a.content,original);
 assert.equal((await tools.execute('save_document',{parentId:'a',parentVersion:2,content:'旧版本'},context(state,'stale'))).error.code,'asset_version_mismatch');
 await evidence('stage2-long-revision',{result,state});
});
test('stage2 summary thresholds account for irreducible prompt/catalog/tool cost',async()=>{
 const catalog=await loadAgentCatalog(),tools=createTools({mode:'live',media:{image:async()=>{}},observeImages:async()=>{}}),prompt=await readFile(new URL('../server/context-agent/prompt.md',import.meta.url),'utf8');
 const threshold=memoryThresholds(createSession(),{systemPrompt:prompt,skillDirectory:catalog.skills,toolDefinitions:tools.definitions,tokenBudget:24000,reservedTokens:6000},memoryDefaults);
 assert.ok(threshold.target>threshold.floor);assert.ok(threshold.trigger>threshold.target);assert.ok(threshold.trigger<threshold.effective);
 await evidence('stage2-thresholds',threshold);
});
test('stage3 observation respects Agent material selection, reports candidates and never auto-adds another product',async()=>{
 const s=createSession();s.assets.img={id:'img',type:'image',version:1,url:'https://fixture.invalid/source.png'};
 s.assets.facts={id:'facts',type:'text',version:1,content:'容量未知；价格20元。'};s.assets.other={id:'other',type:'text',version:1,content:'另一商品79元'};
 appendRecord(s,{kind:'message',role:'user',content:'分析这件商品',attachments:[{id:'img'},{id:'facts'},{id:'other'}]});
 let observed;const tools=createTools({observeImages:async args=>(observed=args,{text:'容量无法判断'})});
 const args={imageIds:['img'],question:'商品有哪些可见特征？'};
 const missing=await tools.execute('analyze_image',args,context(s,'missing'));assert.equal(missing.ok,true);assert.deepEqual(observed.materials,[]);assert.deepEqual(missing.materialCandidates.map(a=>a.id),['facts','other']);
 const result=await tools.execute('analyze_image',{...args,materials:[{sourceId:'facts',status:'unknown'}]},context(s,'observe'));
 assert.equal(result.ok,true);assert.equal(observed.materials[0].content,s.assets.facts.content);assert.equal(observed.materials.length,1);
 const empty=await tools.execute('analyze_image',{...args,materials:[],contextNote:'只比较背景，不涉及商品属性，两份资料均无关'},context(s,'explicit-empty'));assert.equal(empty.ok,true);assert.deepEqual(observed.materials,[]);
 await evidence('stage3-observation',{missing,result});
});
test('stage3 visual lineage stays provenance; only explicit image binding appears as actual visual input',async()=>{
 const s=createSession(),tools=createTools();s.assets.img={id:'img',type:'image',version:2,url:'https://fixture.invalid/source.png'};
 const args={prompt:'保持原商品',size:'1024x1024',sourceIds:['img']};
 const missing=await tools.execute('generate_image',args,context(s,'missing'));assert.equal(missing.ok,true);assert.deepEqual(missing.inputEvidence.visualSources,[]);assert.equal(missing.submitted,false);
 const result=await tools.execute('generate_image',{...args,referenceImages:['img']},context(s,'valid'));assert.equal(result.submitted,false);assert.deepEqual(result.inputEvidence.visualSources,[{id:'img',version:2}]);
 await evidence('stage3-generation',{missing,result});
});
