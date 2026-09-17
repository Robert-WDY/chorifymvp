import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTools} from '../server/context-agent/tools.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {createSession,appendRecord,HistoryStore,currentSummary} from '../server/context-agent/history.mjs';
import {buildContext,estimateTokens} from '../server/context-agent/context.mjs';
import {maintainMemory} from '../server/context-agent/memory.mjs';
import {resultView} from '../server/context-agent/result-view.mjs';
const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(name,args,id)=>[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}];
const ctx=(state,id='call')=>({state,ownerId:state.ownerId,turnId:'turn',callId:id,save:async()=>{}});
const msg=(state,text,role='user')=>appendRecord(state,{kind:'message',role,content:text});
async function evidence(name,data){if(process.env.SOURCE_MEMORY_EVIDENCE){await mkdir(process.env.SOURCE_MEMORY_EVIDENCE,{recursive:true});await writeFile(join(process.env.SOURCE_MEMORY_EVIDENCE,name+'.json'),JSON.stringify(data,null,2));}}

test('A exact source selection rejects wrong ID and excludes wrappers without deleting original history',async()=>{
 const state=createSession(),tools=createTools();
 const long=msg(state,'请保留下面原稿：\n湖畔茶香，陪伴午后。预约要求未知。\n以上仅存档。'),short=msg(state,'湖畔茶香。','assistant');
 const sourceText='湖畔茶香，陪伴午后。预约要求未知。',args={parentMessageId:short.id,sourceText,content:'湖畔茶香，陪伴清晨。预约要求未知。'};
 const selectionState=structuredClone(state);
 const missing=await tools.execute('save_document',{parentMessageId:short.id,content:args.content},{...ctx(selectionState,'missing'),fromModel:true});assert.equal(missing.ok,true);assert.equal(missing.parentEvidence.content,short.content);
 const wrong=await tools.execute('save_document',args,ctx(state));assert.equal(wrong.error.code,'original_content_mismatch');assert.equal(Object.keys(state.assets).length,0);
 const saved=await tools.execute('save_document',{...args,parentMessageId:long.id},ctx(state,'correct'));
 assert.equal(saved.ok,true);assert.equal(saved.parentEvidence.content,sourceText);assert.equal(state.assets[saved.asset.parentId].content,sourceText);assert.equal(saved.parentEvidence.sourceMessageId,long.id);
 const range=saved.parentEvidence.sourceRange;assert.equal(long.content.slice(range.start,range.end),sourceText);assert.equal(state.records.find(r=>r.id===long.id).content,long.content);
 const projected=resultView({kind:'tool_result',output:JSON.stringify(saved)},{maxDataChars:5});assert.equal(projected.parentEvidence.id,saved.asset.parentId);assert.equal(projected.parentEvidence.content,sourceText);
 await evidence('A-source-identity',{wrong,saved,state,projected});
});

test('A excerpts have distinct identity, reuse matching original, retain full-message archival compatibility',async()=>{
 const state=createSession(),tools=createTools(),original=msg(state,'说明\n第一段作品。\n第二段作品。');
 const full=await tools.execute('save_document',{sourceMessageId:original.id},ctx(state,'full'));
 const a=await tools.execute('save_document',{sourceMessageId:original.id,sourceText:'第一段作品。'},ctx(state,'a'));
 const b=await tools.execute('save_document',{sourceMessageId:original.id,sourceText:'第二段作品。'},ctx(state,'b'));
 assert.equal(new Set([full.asset.id,a.asset.id,b.asset.id]).size,3);assert.equal(full.asset.content,original.content);
 const again=await tools.execute('save_document',{sourceMessageId:original.id,sourceText:'第一段作品。'},ctx(state,'again'));assert.equal(again.asset.id,a.asset.id);
 const repeated=msg(state,'重复。重复。');assert.equal((await tools.execute('save_document',{sourceMessageId:repeated.id,sourceText:'重复。'},ctx(state,'repeat'))).error.code,'ambiguous_source_text');
 const partial=await tools.execute('save_document',{parentId:full.asset.id,sourceText:'第一段作品。',content:'新稿'},ctx(state,'partial'));assert.equal(partial.ok,true);assert.equal(partial.parentEvidence.content,original.content);
 const before=Object.keys(state.assets);const failed=await tools.execute('save_document',{parentMessageId:original.id,sourceText:'第二段作品。',content:'新稿'},{...ctx(state,'failure'),save:async()=>{throw new Error('disk failure');}});assert.equal(failed.ok,false);assert.deepEqual(Object.keys(state.assets),before);
});

test('A original evidence and versions survive SQLite restart and repeated calls',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'source-boundary-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new HistoryStore(dir),state=await store.create('owner'),tools=createTools();
 const original=msg(state,'操作说明\n实际正文\n操作结束'),args={parentMessageId:original.id,sourceText:'实际正文',content:'修订正文'},c={...ctx(state),save:s=>store.save(s,'owner')};
 const saved=await tools.execute('save_document',args,c),restored=await store.load(state.id,'owner');
 const replay=await tools.execute('save_document',args,{...c,state:restored});assert.deepEqual(replay,saved);assert.equal(Object.keys(restored.assets).length,2);assert.equal(restored.records[0].content,original.content);
});

function memoryFixture(){
 const state=createSession();state.assets.short={id:'short',type:'text',version:1,content:'真实短稿。',title:'助手错误命名的长稿'};
 const first=msg(state,'用户原稿和约束。');
 msg(state,'资产short已保存长稿。','assistant');
 for(let i=0;i<12;i++)msg(state,('旧讨论'+i+' 保留米白，容量未知。').repeat(45),i%2?'assistant':'user');
 msg(state,'最新修正只改价格。');msg(state,'当前要求。');
 return {state,first,options:{contextOptions:{systemPrompt:'保留真实事实',toolDefinitions:[],tokenBudget:6000,reservedTokens:1000},config:{summaryMaxTokens:700,inputMaxTokens:3500,maxCallsPerTurn:2},save:async()=>{},remainingCalls:()=>10,turnId:'current'}};
}

test('B oversized summary gets smaller explicit byte target, shared envelope budget and actual asset evidence',async()=>{
 const {state,first,options}=memoryFixture();const originals=JSON.stringify(state.records),inputs=[];
 const result=await maintainMemory(state,{...options,respond:async input=>{const p=JSON.parse(input[1].content);inputs.push(p);assert.equal(p.assetEvidence[0].content,'真实短稿。');assert.ok(!JSON.stringify(p.assetEvidence).includes('错误命名'));
  return say(JSON.stringify({summaryText:inputs.length===1?'长'.repeat(1000):'保存的是短稿，原稿需回读；米白保持，容量未知。',sourceRefs:[{kind:'asset',id:'short',version:1},{kind:'message',id:first.id}]}));}});
 assert.equal(result.calls,2);assert.ok(inputs[1].summaryTextMaxUtf8Bytes<inputs[0].summaryTextMaxUtf8Bytes);assert.equal(inputs[1].feedback.code,'summary_budget');
 const summary=currentSummary(state);assert.ok(summary);assert.ok(estimateTokens(summary)<=700);assert.equal(JSON.stringify(state.records.slice(0,JSON.parse(originals).length)),originals);
 const view=buildContext(state,{systemPrompt:'继续',tokenBudget:12000});const summaryView=view.input.find(m=>typeof m.content==='string'&&m.content.includes('"sessionSummary"'));
 assert.match(summaryView.content,/真实短稿/);assert.match(summaryView.content,/assetEvidence/);
 await evidence('B-budget-and-identity',{inputs,result,summary,state,summaryView});
});

test('B repeated oversize remains bounded, preserves source and does not retry same range without new information',async()=>{
 const {state,options}=memoryFixture(),before=JSON.stringify(state.records);let calls=0;
 const run=()=>maintainMemory(state,{...options,respond:async()=>{calls++;return say(JSON.stringify({summaryText:'长'.repeat(5000),sourceRefs:[]}));}});
 await run();assert.equal(calls,2);assert.equal(currentSummary(state),null);assert.equal(JSON.stringify(state.records.slice(0,JSON.parse(before).length)),before);
 await run();assert.equal(calls,2);assert.equal(state.records.filter(r=>r.event==='summary_failed').length,2);
});

test('B non-budget faults do not spend another summary call or change coverage',async()=>{
 for(const fault of ['reference','transport']){const {state,options}=memoryFixture();let calls=0;
  await maintainMemory(state,{...options,respond:async()=>{calls++;if(fault==='transport')throw new Error('offline transport failure');return say(JSON.stringify({summaryText:'短',sourceRefs:[{kind:'message',id:'foreign'}]}));}});
  assert.equal(calls,1);assert.equal(currentSummary(state),null);
 }
});

test('C full delivery covers all items and body counting cannot include the title',async()=>{
 const state=createSession(),tools=createTools(),c=ctx(state);
 const bad=await tools.execute('measure_text',{text:'第一项\n\n第二项',unit:'characters',items:['第一项'],requirements:{itemCount:1}},c);assert.ok(bad.deliveryCheck.issues.includes('items_do_not_cover_entire_delivery'));
 const tooMany=await tools.execute('measure_text',{text:'第一项\n\n第二项',unit:'characters',items:['第一项','第二项'],requirements:{itemCount:1}},c);assert.ok(tooMany.deliveryCheck.issues.includes('item_count_mismatch'));
 const short=await tools.execute('measure_text',{text:'标题很长\n正文',bodyText:'正文',unit:'non_punctuation_characters',requirements:{min:4,max:6}},c);assert.equal(short.count,2);assert.equal(short.deliveryCheck.status,'failed');
 const invalid=await tools.execute('measure_text',{text:'正文',bodyText:'并不存在',unit:'characters',requirements:{min:2}},c);assert.equal(invalid.error.code,'original_content_mismatch');
});

test('C measured draft changed by final extra option is withheld and repaired by same Agent within budget',async()=>{
 const state=createSession(),tools=createTools(),events=[];let step=0;
 const args={text:'山野茶香。',unit:'characters',items:['山野茶香。'],requirements:{itemCount:1}};
 const result=await new ContextAgent({tools,brain:{respond:async input=>{
  if(step++===0)return call('measure_text',args,'measure');
  if(step===2)return say('山野茶香。\n\n备选：一杯清香。');
  assert.match(JSON.stringify(input),/final_text_changed_after_measurement/);return say(args.text);
 }}}).run(state,'只给一个，不要备选',e=>events.push(e));
 assert.equal(result.status,'completed');assert.equal(result.text,args.text);assert.equal(result.modelCalls,3);
 assert.deepEqual(state.records.filter(r=>r.kind==='message'&&r.role==='assistant').map(r=>r.content),[args.text]);
 assert.equal(events.filter(e=>e.kind==='message'&&e.role==='assistant').length,1);
 await evidence('C-final-drift',{result,state,events});
});

test('C failed requirements cannot be finalized, even if exact draft is repeated or a later bare measurement succeeds',async()=>{
 const state=createSession();let n=0;
 const result=await new ContextAgent({maxSteps:4,tools:createTools(),brain:{respond:async()=>{
  if(!n++)return call('measure_text',{text:'短',unit:'characters',requirements:{min:4}},'bad');
  if(n===2)return call('measure_text',{text:'短',unit:'characters'},'bare');
  return say('短');
 }}}).run(state,'至少四字');assert.equal(result.status,'budget_exceeded');assert.equal(state.records.filter(r=>r.kind==='message'&&r.role==='assistant').length,0);
});

test('C remeasurement of fixed draft passes; constraints do not leak into another turn',async()=>{
 const state=createSession();let n=0;
 const result=await new ContextAgent({tools:createTools(),brain:{respond:async()=>{
  if(!n++)return call('measure_text',{text:'短',unit:'characters',requirements:{min:4}},'bad');
  if(n===2)return call('measure_text',{text:'四个汉字',unit:'characters',requirements:{min:4}},'fixed');
  return say('四个汉字');
 }}}).run(state,'至少四字');assert.equal(result.status,'completed');
 const next=await new ContextAgent({tools:createTools(),brain:{respond:async()=>say('好')}}).run(state,'收到，只需说好');assert.equal(next.status,'completed');assert.equal(next.toolCalls,0);
});

test('C invalid measurement cannot silently remove declared constraints',async()=>{
 const state=createSession();let n=0;const result=await new ContextAgent({maxSteps:2,tools:createTools(),brain:{respond:async()=>!n++?call('measure_text',{text:'正文',bodyText:'不在正文',unit:'characters',requirements:{min:3}},'invalid'):say('正文')}}).run(state,'至少三字');
 assert.equal(result.status,'budget_exceeded');assert.equal(state.records.filter(r=>r.kind==='message'&&r.role==='assistant').length,0);
});
