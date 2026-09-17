import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {applyEdits} from '../server/context-agent/incremental-edit.mjs';
import {createSession,appendRecord,HistoryStore} from '../server/context-agent/history.mjs';
import {createTools,approveProposals} from '../server/context-agent/tools.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {buildContext} from '../server/context-agent/context.mjs';
import {publicEvents} from '../server/context-agent/public-events.mjs';
import {resultView} from '../server/context-agent/result-view.mjs';
const ctx=(state,callId='c')=>({state,ownerId:state.ownerId,turnId:'turn',callId,fromModel:true,save:async()=>{},maxMediaCalls:2});
const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(name,args,id)=>[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}];
const draft=(s,content='价格20元。\r\n预约待确认。')=>s.assets.a={id:'a',type:'text',content,version:3};
async function evidence(name,value){if(process.env.INCREMENTAL_EVIDENCE){await mkdir(process.env.INCREMENTAL_EVIDENCE,{recursive:true});await writeFile(join(process.env.INCREMENTAL_EVIDENCE,name+'.json'),JSON.stringify({validation:{model:'scripted',media:'local_mock_or_simulation',networkCalls:0},...value},null,2)+'\n');}}

test('retained original identities cover early long text and mixed messages in exact history order',async()=>{
 const s=createSession(),tools=createTools();
 appendRecord(s,{kind:'message',role:'assistant',content:'早期原稿'+ '正文'.repeat(1200)});
 appendRecord(s,{kind:'message',role:'user',content:[{type:'input_text',text:'看图'},{type:'input_image',image_url:'https://example.com/a.png'}]});
 for(let i=0;i<12;i++)appendRecord(s,{kind:'message',role:i%2?'user':'assistant',content:'继续'+i});
 const before=JSON.stringify(s),view=buildContext(s,{toolDefinitions:tools.definitions,tokenBudget:24000});
 const index=view.input.find(m=>typeof m.content==='string'&&m.content.includes('"originalMessages":'));
 const rows=JSON.parse(index.content.slice(index.content.indexOf('\n')+1)).originalMessages;
 assert.equal(view.metrics.omittedRecords,0);assert.deepEqual(rows.map(x=>x.messageId),s.records.map(x=>x.id));assert.equal(rows[1].textOriginal,false);
 assert.equal(view.input.find(m=>m.content===s.records[0].content).content,s.records[0].content);assert.equal(JSON.stringify(s),before);
 await evidence('original-identities',{view,state:s});
});

test('patches resolve simultaneously against original and preserve every unmentioned byte',()=>{
 const original='甲20元。\r\n  保留😀格式。\n乙30元。结尾';
 const r=applyEdits(original,[{before:'乙30元',after:'乙25元'},{before:'甲20元',after:'甲30元'},{before:'结尾',after:''}]);
 assert.equal(r.content,'甲30元。\r\n  保留😀格式。\n乙25元。');assert.equal(r.evidence.changes.length,3);
 assert.equal(original,'甲20元。\r\n  保留😀格式。\n乙30元。结尾');
 for(const [base,edits,code]of [
  ['重复重复',[{before:'重复',after:'新'}],'ambiguous_edit'],
  ['abcdef',[{before:'abc',after:'x'},{before:'bcde',after:'y'}],'overlapping_edits'],
  ['abc',[{before:'missing',after:'x'}],'edit_source_mismatch'],
  ['abc',[{before:'a',after:'a'}],'unchanged_edit'],
  ['ab',[{before:'a',after:''},{before:'b',after:'ab'}],'unchanged_edit'],
 ])assert.throws(()=>applyEdits(base,edits),{code});
});

test('revision read pairs actual current user request with original and preserves pagination',async()=>{
 const s=createSession(),tools=createTools();draft(s);
 appendRecord(s,{kind:'message',role:'user',turnId:'older',content:'旧轮要求'});
 const source=appendRecord(s,{kind:'message',role:'assistant',turnId:'older',content:'原稿价格20元。'});
 const u=appendRecord(s,{kind:'message',role:'user',turnId:'turn',content:'仅将价格改为18元，预约条件不动。'});
 appendRecord(s,{kind:'message',role:'assistant',turnId:'turn',content:'错误复述：要改预约'});
 const asset=await tools.execute('read_asset',{id:'a',forRevision:true,limit:4},ctx(s));
 assert.equal(asset.asset.content,s.assets.a.content.slice(0,4));assert.equal(asset.nextOffset,4);
 const history=await tools.execute('read_history',{messageId:source.id,forRevision:true},ctx(s));
 const p=await tools.execute('generate_image',{prompt:'白瓶米白背景',size:'1K'},ctx(s,'p'));
 const proposal=await tools.execute('read_approval',{proposalId:p.proposalId,forRevision:true},ctx(s));
 for(const r of [asset,history,proposal]){assert.equal(r.ok,true);assert.equal(r.revisionRequest.messageId,u.id);assert.equal(r.revisionRequest.content,u.content);}
 assert.equal((await tools.execute('read_asset',{id:'a'},ctx(s))).revisionRequest,undefined);
 await evidence('revision-input',{asset,history,proposal});
});

test('versioned document edits preserve parent, bind measured reconstructed body, and replay once',async()=>{
 const s=createSession(),tools=createTools();draft(s);const before=structuredClone(s.assets.a),text='价格18元。\r\n预约待确认。';
 appendRecord(s,{kind:'tool_call',turnId:'turn',callId:'m',name:'measure_text',arguments:JSON.stringify({text,unit:'characters',requirements:{min:4},target:{kind:'document',id:'d'}})});
 const measured=await tools.execute('measure_text',{text,unit:'characters',requirements:{min:4},target:{kind:'document',id:'d'}},ctx(s,'m'));
 appendRecord(s,{kind:'tool_result',turnId:'turn',callId:'m',output:JSON.stringify(measured)});
 const args={parentId:'a',parentVersion:3,edits:[{before:'20元',after:'18元'}],measurementCallId:'m'};
 const result=await tools.execute('save_document',args,ctx(s));assert.equal(result.ok,true);assert.equal(result.asset.content,text);assert.equal(result.asset.parentId,'a');assert.equal(result.asset.version,4);assert.deepEqual(s.assets.a,before);
 assert.equal(result.changeEvidence.changed,true);assert.deepEqual(result.changeEvidence.changes.map(c=>[c.before,c.after]),[['20','18']]);
 assert.equal((await tools.execute('save_document',args,ctx(s))).asset.id,result.asset.id);assert.equal(Object.keys(s.assets).length,2);
 const wrong=await tools.execute('save_document',{...args,edits:[{before:'20元',after:'19元'}]},ctx(s,'other'));assert.equal(wrong.ok,false);assert.equal(Object.keys(s.assets).length,2);
 await evidence('document-revision',{result,measured,state:s});
});

test('invalid and stale edits have no document or invocation side effects',async()=>{
 const s=createSession(),tools=createTools();draft(s,'甲乙甲乙，价格20元。');const before=JSON.stringify(s);
 for(const patch of [
  {parentVersion:2},{parentVersion:undefined},{edits:[{before:'甲乙',after:'丙'}]},
  {edits:[{before:'不在原稿',after:'丙'}]},{content:'全篇重写'},
  {edits:[{before:s.assets.a.content,after:''}]},{edits:[{before:'20元',after:'20元'}]},
  {edits:[{before:'甲乙甲乙',after:'丙'},{before:'乙甲',after:'丁'}]},
 ]){const args={parentId:'a',parentVersion:3,edits:[{before:'20元',after:'18元'}],...patch};if(args.parentVersion===undefined)delete args.parentVersion;assert.equal((await tools.execute('save_document',args,ctx(s))).ok,false);assert.equal(JSON.stringify(s),before);}
 const deletion=await tools.execute('save_document',{parentId:'a',parentVersion:3,edits:[{before:'价格20元。',after:''}]},ctx(s));assert.equal(deletion.asset.content,'甲乙甲乙，');
});

test('reconstructed document and revision history envelope obey existing size limits',async()=>{
 const s=createSession(),tools=createTools();draft(s,'甲'.repeat(400000)+'末尾');
 const tooBig=await tools.execute('save_document',{parentId:'a',parentVersion:3,edits:[{before:'末尾',after:'乙'.repeat(100001)}]},ctx(s));assert.equal(tooBig.ok,false);assert.equal(Object.keys(s.assets).length,1);
 const original=appendRecord(s,{kind:'message',role:'assistant',content:'原稿'.repeat(4000)});
 appendRecord(s,{kind:'message',role:'user',turnId:'turn',content:'保留'.repeat(600)});
 const read=await tools.execute('read_history',{messageId:original.id,forRevision:true,maxChars:5000},ctx(s));assert.equal(read.ok,true);assert.ok(JSON.stringify(read).length<=5000);assert.equal(read.revisionRequest.content,'保留'.repeat(600));
 const tight=await tools.execute('read_history',{messageId:original.id,forRevision:true,maxChars:2000},ctx(s));assert.equal(tight.error.code,'HISTORY_BUDGET_EXCEEDED');
});

test('chat originals archive separately; mismatch gives actual identity and incremental child keeps correct lineage',async()=>{
 const s=createSession(),tools=createTools();const long='原长稿价格20元。其余内容保留。';
 const a=appendRecord(s,{kind:'message',role:'assistant',content:'长稿如下：\n'+long+'\n以上是长稿。'}),b=appendRecord(s,{kind:'message',role:'assistant',content:'短稿价格20元。'});
 const wrong=await tools.execute('save_document',{sourceMessageId:b.id,sourceText:long},ctx(s,'wrong'));assert.equal(wrong.ok,false);assert.equal(wrong.sourceEvidence.messageId,b.id);assert.equal(wrong.sourceEvidence.excerpt,b.content);assert.equal(Object.keys(s.assets).length,0);
 const short=await tools.execute('save_document',{sourceMessageId:b.id,sourceText:b.content},ctx(s,'short'));
 const revised=await tools.execute('save_document',{parentMessageId:a.id,sourceText:long,edits:[{before:'20元',after:'18元'}]},ctx(s,'rev'));
 assert.equal(revised.ok,true);const parent=s.assets[revised.asset.parentId];assert.equal(parent.sourceMessageId,a.id);assert.equal(parent.content,long);assert.equal(parent.parentId,undefined);assert.notEqual(parent.id,short.asset.id);assert.equal(revised.asset.content,'原长稿价格18元。其余内容保留。');
 assert.equal(s.records[0].content,a.content);await evidence('chat-lineage',{wrong,revised,state:s});
});

test('failed persistence rolls back both archived original and incremental child',async()=>{
 const s=createSession(),tools=createTools(),source=appendRecord(s,{kind:'message',role:'assistant',content:'原稿20元。'});const before=JSON.stringify(s);
 const r=await tools.execute('save_document',{parentMessageId:source.id,sourceText:source.content,edits:[{before:'20元',after:'18元'}]},{...ctx(s),save:async()=>{throw new Error('disk unavailable');}});
 assert.equal(r.ok,false);assert.equal(JSON.stringify(s),before);
});

test('long original local edit reaches Agent feedback within unchanged context budget',async()=>{
 const s=createSession(),tools=createTools(),original='原稿'.repeat(2500)+'句末';draft(s,original);let n=0;
 const agent=new ContextAgent({tools,memory:{enabled:false},brain:{respond:async input=>{
  n++;if(n===1)return call('read_asset',{id:'a',forRevision:true,limit:3000},'read');
  if(n===2){const r=JSON.parse(input.find(x=>x.call_id==='read'&&x.type==='function_call_output').output);assert.equal(r.data.asset.content,original.slice(0,3000));assert.equal(r.data.nextOffset,3000);return call('read_asset',{id:'a',forRevision:true,offset:r.data.nextOffset,limit:3000},'rest');}
  if(n===3){const r=JSON.parse(input.find(x=>x.call_id==='rest'&&x.type==='function_call_output').output);assert.equal(r.data.asset.content,original.slice(3000));assert.equal(r.data.nextOffset,null);assert.match(JSON.stringify(input),/revisionRequest/);return call('save_document',{parentId:'a',parentVersion:3,edits:[{before:'句末',after:'句末。'}]},'patch');}
  const r=input.find(x=>x.type==='function_call_output'&&x.call_id==='patch');assert.equal(JSON.parse(r.output).changeEvidence.changed,true);return say('已保存新版本。');
 }}});
 const result=await agent.run(s,'在原稿末尾加句号并保存，其他字都不动。');assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.modelCalls,4);assert.equal(Object.values(s.assets).find(a=>a.parentId==='a').content,original+'。');
 assert.ok(s.records.filter(r=>r.kind==='tool_call'&&r.name==='save_document').every(r=>r.arguments.length<180));await evidence('long-agent-trace',{result,state:s});
});

test('image proposal changes only selected background; inherits sources and waits for new approval',async()=>{
 const s=createSession();s.assets.img={id:'img',type:'image',version:2,url:'https://example.com/source.png'};let sent=[];
 // This adapter is local only; no network or real generation.
 const tools=createTools({mode:'live',media:{image:async args=>(sent.push(args),{status:'succeeded',images:[{url:'https://example.com/mock-result.png'}]})}});
 const original={prompt:'透明方瓶、白色瓶盖。米白背景，柔和光。无文字。',size:'1440x2560',referenceImages:['img'],sourceIds:['img']};
 const first=await tools.execute('generate_image',original,ctx(s,'first'));const snapshot=structuredClone(s.approvals[first.proposalId]);
 const approved=await approveProposals(s,{proposalIds:[first.proposalId],ownerId:s.ownerId},async()=>{});
 const args={replacesProposalId:first.proposalId,edits:[{before:'米白背景',after:'浅蓝背景'}]};
 const r=await tools.execute('generate_image',args,ctx(s,'patch'));assert.equal(r.ok,true);assert.equal(r.submitted,false);assert.equal(sent.length,0);assert.deepEqual(s.approvals[first.proposalId],snapshot);
 assert.deepEqual(r.args,{...original,prompt:'透明方瓶、白色瓶盖。浅蓝背景，柔和光。无文字。'});assert.deepEqual(r.changeEvidence.changedFields,['prompt']);
 assert.equal((await tools.execute('generate_image',args,ctx(s,'patch'))).proposalId,r.proposalId);
 const denied=await tools.execute('execute_approved',{proposalId:r.proposalId,approvalId:approved.approvalId},ctx(s,'denied'));assert.equal(denied.ok,false);assert.equal(sent.length,0);
 const permission=await approveProposals(s,{proposalIds:[r.proposalId],ownerId:s.ownerId},async()=>{});
 const done=await tools.execute('execute_approved',{proposalId:r.proposalId,approvalId:permission.approvalId},ctx(s,'submit'));assert.equal(done.ok,true);assert.equal(sent.length,1);assert.deepEqual(sent[0].prompt,r.args.prompt);assert.equal(sent[0].edits,undefined);
 await tools.execute('execute_approved',{proposalId:r.proposalId,approvalId:permission.approvalId},ctx(s,'again'));assert.equal(sent.length,1);
 await evidence('media-revision',{first,r,denied,done,sent,state:s});
});

test('video scalar revision and image editing proposal retain unrelated original parameters',async()=>{
 const s=createSession(),tools=createTools();s.assets.img={id:'img',type:'image',version:2,size:'1024x1024'};
 const video=await tools.execute('generate_video',{prompt:'固定镜头，只让光移动。',duration:5,ratio:'9:16',resolution:'720p',firstFrameId:'img'},ctx(s,'v'));
 const r=await tools.execute('generate_video',{replacesProposalId:video.proposalId,duration:8},ctx(s,'vr'));assert.equal(r.ok,true);assert.deepEqual(r.args,{...video.args,duration:8});assert.deepEqual(r.changeEvidence.changedFields,['duration']);
 const image=await tools.execute('edit_image',{imageId:'img',instruction:'保持杯子、构图，仅背景改为米白。'},ctx(s,'i'));
 const edit=await tools.execute('edit_image',{replacesProposalId:image.proposalId,edits:[{before:'米白',after:'蓝色'}]},ctx(s,'ir'));assert.equal(edit.ok,true);assert.deepEqual(edit.args,{...image.args,instruction:'保持杯子、构图，仅背景改为蓝色。'});
});

test('incremental media rejects incomplete new proposals, invalid merged values and foreign identities',async()=>{
 const s=createSession(),tools=createTools();const p=await tools.execute('generate_image',{prompt:'白瓶米白背景',size:'1K'},ctx(s,'p'));
 const base={replacesProposalId:p.proposalId,edits:[{before:'米白',after:'蓝色'}]},before=JSON.stringify(s);
 for(const args of [{replacesProposalId:p.proposalId},{edits:base.edits},{prompt:'new'}, {...base,prompt:'全新'},{...base,size:'bad'},{...base,sourceIds:['missing']},{...base,replacesProposalId:'missing'}]){assert.equal((await tools.execute('generate_image',args,ctx(s,'bad'))).ok,false);assert.equal(JSON.stringify(s),before);}
 assert.equal((await tools.execute('generate_video',{replacesProposalId:p.proposalId,duration:6},ctx(s,'wrong-tool'))).ok,false);
 const other=createSession();other.approvals[p.proposalId]=s.approvals[p.proposalId];assert.equal((await tools.execute('generate_image',base,ctx(other,'foreign'))).ok,false);
});

test('stored document display and changes survive restart independently of an incorrect Agent reply',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'incremental-'));t.after(()=>rm(dir,{force:true,recursive:true}));
 const store=new HistoryStore(dir),s=await store.create('owner'),tools=createTools();draft(s);let n=0;
 const agent=new ContextAgent({tools,save:s=>store.save(s,'owner'),memory:{enabled:false},brain:{respond:async()=>!n++?call('save_document',{parentId:'a',parentVersion:3,edits:[{before:'20元',after:'18元'}]},'save'):say('已保存20元。')}});
 const result=await agent.run(s,'仅改为18元并保存。');assert.equal(result.status,'completed');const restored=await store.load(s.id,'owner');
 const events=publicEvents(restored).events,card=events.find(e=>e.kind==='document');assert.equal(card.asset.content,'价格18元。\r\n预约待确认。');assert.equal(card.asset.content,restored.assets[card.asset.id].content);assert.equal(card.changed,true);assert.equal(card.asset.parentId,'a');
 assert.ok(events.some(e=>e.kind==='message'&&e.text==='已保存20元。')); // Known semantic limit; do not mask it.
 const raw=s.records.find(r=>r.kind==='tool_result');const projected=resultView(raw,{maxDataChars:10});assert.equal(projected.changeEvidence.changed,true);assert.equal(projected.changeEvidence.meaningVerified,false);
 const noop=await tools.execute('save_document',{parentId:'a',parentVersion:3,content:s.assets.a.content},ctx(s,'noop'));assert.equal(noop.changeEvidence.changed,false);assert.deepEqual(noop.changeEvidence.changes,[]);
 await evidence('stored-display',{result,events,projected,noop});
});

test('failed proposal replacement persistence does not withdraw its original',async()=>{
 const s=createSession(),tools=createTools();const p=await tools.execute('generate_image',{prompt:'白瓶，米白背景。',size:'1K'},ctx(s,'p'));const before=JSON.stringify(s);
 const result=await tools.execute('generate_image',{replacesProposalId:p.proposalId,edits:[{before:'米白',after:'蓝色'}]},{...ctx(s,'fail'),save:async()=>{throw new Error('disk unavailable');}});
 assert.equal(result.ok,false);assert.equal(JSON.stringify(s),before);assert.equal((await tools.execute('read_approval',{proposalId:p.proposalId},ctx(s))).unavailable,false);
});

test('document card renders persisted text safely and deduplicates event replay in DOM harness',async()=>{
 class Element{constructor(tag){this.tagName=tag;this.children=[];this.dataset={};}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}}
 const elements=new Map(),document={getElementById:id=>{if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);},createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
 const source=await readFile(new URL('../server/context-agent/web/app.js',import.meta.url),'utf8');
 const sandbox=vm.createContext({document,localStorage:{getItem:()=>null}});vm.runInContext(source.replace(/await initialize\(\);\s*$/,''),sandbox);
 const e={type:'public_event',eventId:'event',kind:'document',seq:1,asset:{id:'a',version:4,title:'价格稿',content:'18元\n<img src=x onerror=alert(1)>'},changed:true};sandbox.event=e;
 vm.runInContext('ingest(event);ingest(event);ingest({...event,eventId:"another"});',sandbox);
 const cards=elements.get('messages').children;assert.equal(cards.length,1);assert.equal(cards[0].dataset.assetId,'a');assert.equal(cards[0].children.at(-1).textContent,e.asset.content);assert.equal(cards[0].children.at(-1).innerHTML,undefined);
});
