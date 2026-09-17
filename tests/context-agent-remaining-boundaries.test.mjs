import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSession,appendRecord,HistoryStore} from '../server/context-agent/history.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {buildContext} from '../server/context-agent/context.mjs';
const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(args,id)=>[{type:'function_call',name:'measure_text',arguments:JSON.stringify(args),call_id:id}];
const context=(state,id='save')=>({state,ownerId:state.ownerId,turnId:'turn',callId:id,save:async()=>{},fromModel:true});
async function evidence(name,value){if(process.env.REMAINING_EVIDENCE){await mkdir(process.env.REMAINING_EVIDENCE,{recursive:true});await writeFile(join(process.env.REMAINING_EVIDENCE,name+'.json'),JSON.stringify(value,null,2));}}

test('remeasurement cannot lower or drop valid same-turn requirements',async()=>{
 const cases=[
  {id:'lower-min',a:{text:'短文',unit:'characters',requirements:{min:4}},b:{text:'短文',unit:'characters',requirements:{min:1}}},
  {id:'higher-max',a:{text:'一二三四五',unit:'characters',requirements:{max:4}},b:{text:'一二三四五',unit:'characters',requirements:{max:6}}},
  {id:'drop-count',a:{text:'甲\n\n乙',items:['甲','乙'],unit:'characters',requirements:{itemCount:1}},b:{text:'甲\n\n乙',items:['甲','乙'],unit:'characters',requirements:{min:1}}},
  {id:'count-title',a:{text:'长标题\n短文',bodyText:'短文',unit:'characters',requirements:{min:4}},b:{text:'长标题\n短文',unit:'characters',requirements:{min:4}}},
 ];
 const outcomes=[];
 for(const item of cases){let n=0;const state=createSession();const result=await new ContextAgent({maxSteps:3,tools:createTools(),brain:{respond:async()=>!n++?call(item.a,'first'):n===2?call(item.b,'second'):say(item.b.text)}}).run(state,'满足指定限制后交付');
  outcomes.push({id:item.id,result,state});
 }
 await evidence('requirements',outcomes);
 for(const item of outcomes){assert.equal(item.result.status,'budget_exceeded',item.id);assert.equal(item.state.records.filter(r=>r.kind==='message'&&r.role==='assistant').length,0,item.id);const result=JSON.parse(item.state.records.filter(r=>r.kind==='tool_result').at(-1).output);assert.equal(result.deliveryCheck.status,'failed',item.id+' tool and final gate agree');}
});

test('all-text message arrays can be archived and revised with the same exact source and range',async()=>{
 const state=createSession(),tools=createTools(),parts=[{type:'input_text',text:'保存以下正文：'},{type:'text',text:'原稿内容。'},{type:'output_text',text:'此句是操作说明。'}];
 const original=appendRecord(state,{kind:'message',role:'user',content:parts});
 const archived=await tools.execute('save_document',{sourceMessageId:original.id,sourceText:'原稿内容。'},context(state,'archive'));
 const revised=await tools.execute('save_document',{parentMessageId:original.id,sourceText:'原稿内容。',content:'修订内容。'},context(state,'revise'));
 await evidence('text-array-source',{archived,revised,state});
 assert.equal(archived.ok,true);assert.equal(revised.ok,true);assert.equal(revised.asset.parentId,archived.asset.id);
 assert.equal(revised.parentEvidence.content,'原稿内容。');assert.deepEqual(revised.parentEvidence.sourceRange,archived.asset.sourceRange);assert.deepEqual(original.content,parts);
 const view=buildContext(state,{toolDefinitions:tools.definitions});const index=JSON.parse(view.input.find(m=>typeof m.content==='string'&&m.content.includes('"originalMessages"')).content.split('\n').slice(1).join('\n'));
 assert.equal(index.originalMessages.find(m=>m.messageId===original.id).characters,parts.map(p=>p.text).join('\n').length);
});

test('non-text message parts are never silently dropped to manufacture an original',async()=>{
 const tools=createTools();for(const parts of [[{type:'input_text',text:'正文'},{type:'input_image',image_url:'https://fixture.test/a.png'}],[{type:'text',text:'正文'},null]]){
  const state=createSession(),m=appendRecord(state,{kind:'message',role:'user',content:parts});
  for(const field of ['sourceMessageId','parentMessageId']){const result=await tools.execute('save_document',{[field]:m.id,sourceText:'正文',...(field==='parentMessageId'?{content:'修订'}:{})},context(state,field));assert.equal(result.ok,false);assert.equal(result.error.code,'text_original_required');assert.equal(Object.keys(state.assets).length,0);}
 }
});

test('valid corrections satisfy earlier declarations and a new user turn may change scope',async()=>{
 const state=createSession();let n=0;const tools=createTools();
 const result=await new ContextAgent({tools,brain:{respond:async()=>!n++?call({text:'短',unit:'characters',requirements:{min:4}},'first'):n===2?call({text:'正文四字',unit:'characters',requirements:{min:1}},'second'):say('正文四字')}}).run(state,'至少四字');
 assert.equal(result.status,'completed');assert.equal(result.text,'正文四字');
 const check=JSON.parse(state.records.filter(r=>r.kind==='tool_result').at(-1).output).deliveryCheck;assert.equal(check.status,'passed');
 n=0;const next=await new ContextAgent({tools,brain:{respond:async()=>!n++?call({text:'好',unit:'characters',requirements:{max:1}},'new'):say('好')}}).run(state,'改为只要一个字');assert.equal(next.status,'completed');
});

test('measurement unit changes cannot evade prior constraints; bare diagnostics do not declare a requirement',async()=>{
 const state=createSession();let n=0;const result=await new ContextAgent({maxSteps:3,tools:createTools(),brain:{respond:async()=>!n++?call({text:'甲，乙。',unit:'non_punctuation_characters',requirements:{min:4}},'first'):n===2?call({text:'甲，乙。',unit:'characters',requirements:{min:4}},'second'):say('甲，乙。')}}).run(state,'正文四字不含标点');assert.equal(result.status,'budget_exceeded');
 n=0;const diagnostic=await new ContextAgent({tools:createTools(),brain:{respond:async()=>!n++?call({text:'仅测量这个临时片段',unit:'characters'},'diagnostic'):say('好')}}).run(createSession(),'测量片段后说好');assert.equal(diagnostic.status,'completed');
});

test('same-turn declarations survive a store reload',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'remaining-boundaries-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new HistoryStore(dir),state=await store.create('owner'),tools=createTools(),turnId='persisted-turn';
 const args={text:'短文',unit:'characters',requirements:{min:4}};
 appendRecord(state,{kind:'tool_call',turnId,callId:'first',name:'measure_text',arguments:JSON.stringify(args)});
 const first=await tools.execute('measure_text',args,{...context(state),turnId});appendRecord(state,{kind:'tool_result',turnId,callId:'first',output:JSON.stringify(first)});await store.save(state,'owner');
 const restored=await store.load(state.id,'owner');const again=await tools.execute('measure_text',{...args,requirements:{min:1}},{...context(restored),turnId});assert.equal(again.deliveryCheck.status,'failed');
});
