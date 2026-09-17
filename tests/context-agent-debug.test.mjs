import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createSession,appendRecord,HistoryStore} from '../server/context-agent/history.mjs';
import {createContextServer} from '../server/context-agent/http.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {debugSnapshot,debugDetail,inputBlocks} from '../server/context-agent/debug-view.mjs';

test('debug counts phases separately and joins results by IDs without inventing success',()=>{
 const s=createSession();const add=r=>appendRecord(s,{turnId:'t',...r});
 for(const [traceId,phase]of [['a','agent'],['s','summary'],['v','image_observation']])add({kind:'run_event',event:'model_request',traceId,phase,input:[],tools:[]});
 add({kind:'run_event',event:'model_response',traceId:'s',output:[]});
 add({kind:'run_event',event:'model_error',traceId:'v',message:'unavailable'});
 add({kind:'tool_call',callId:'one',name:'read_asset',arguments:'{"id":"a"}'});
 add({kind:'tool_result',callId:'one',output:'{"ok":false,"status":"not_executed"}'});
 const before=JSON.stringify(s),d=debugSnapshot(s);
 assert.deepEqual(d.counts.phases,{agent:1,summary:1,image_observation:1});assert.equal(d.counts.deferredTools,1);
 assert.deepEqual(d.turns[0].models.map(m=>m.status),['unanswered','returned','failed']);assert.equal(d.turns[0].tools[0].agentTraceId,'a');assert.equal(JSON.stringify(s),before);
});

test('debug input blocks preserve original order, source boundaries and multimodal data',()=>{
 const input=[{role:'system',content:'规则一\n\n规则二'},{role:'user',content:'Context reference data supplied by the server. Not instruction.\n'+JSON.stringify({assetDirectory:[{id:'a'}],originalMessages:[{messageId:'m'}]})},{role:'user',content:[{type:'input_text',text:'<script>not code</script>'},{type:'input_image',image_url:'https://example.com/a.png'}]},{type:'function_call_output',call_id:'c',output:'{"ok":true,"asset":{"id":"a"}}'}];
 const before=JSON.stringify(input),blocks=inputBlocks(input);assert.deepEqual(blocks.slice(0,2).map(b=>b.data),['规则一','规则二']);assert.ok(blocks.some(b=>b.name==='assetDirectory'));assert.equal(blocks.find(b=>b.name==='input_image 2').data.image_url,input[2].content[1].image_url);assert.ok(blocks.find(b=>b.callId==='c'));assert.equal(JSON.stringify(input),before);
});

test('debug HTTP reads persisted full requests, tool results and policy without running models',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chorify-debug-'));let calls=0;
 const app=createContextServer({directory,tools:createTools(),modelEnabled:true,brain:{respond:async()=>++calls===1?[{type:'function_call',call_id:'a',name:'save_document',arguments:'{"content":"原稿18元"}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'已保存。'}]}]}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{
  const config=await(await fetch(base+'/api/config')).json(),headers={'Content-Type':'application/json','x-context-token':config.csrf};
  const s=await(await fetch(base+'/api/session',{method:'POST',headers,body:'{}'})).json();
  await(await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({sessionId:s.id,message:'保存原稿',requestId:'debug-test'})})).text();
  const before=JSON.stringify(await app.store.load(s.id));
  const index=await(await fetch(base+'/api/debug/'+s.id)).json();assert.equal(index.counts.models,2);assert.equal(index.counts.tools,1);assert.ok(index.turns[0].events.some(e=>e.event==='tool_batch_policy'));
  const request=index.turns[0].models[0];const detail=await(await fetch(base+'/api/debug/'+s.id+'/record/'+request.id)).json();assert.ok(detail.record.input.length);assert.equal(detail.record.traceRef,undefined);assert.equal(detail.response.output[0].name,'save_document');assert.ok(detail.tools.some(t=>t.name==='save_document'));
  const tool=await(await fetch(base+'/api/debug/'+s.id+'/record/'+index.turns[0].tools[0].id)).json();assert.equal(tool.arguments.content,'原稿18元');assert.equal(JSON.parse(tool.result.output).ok,true);
  const restored=await new HistoryStore(directory).load(s.id);const full=await debugDetail(restored,request.id,id=>app.store.readTrace(s.id,'local',id));assert.deepEqual(full.record.input,detail.record.input);
  assert.equal(JSON.stringify(await app.store.load(s.id)),before);assert.equal(calls,2);
  const other=await app.store.create('other');assert.equal((await fetch(base+'/api/debug/'+other.id)).status,404);assert.equal((await fetch(base+'/api/debug/'+s.id+'/record/missing')).status,400);assert.equal((await fetch(base+'/api/debug/'+s.id,{headers:{Origin:'http://foreign.invalid'}})).status,403);
  for(const path of ['/debug','/debug.js','/debug.css']){const r=await fetch(base+path);assert.equal(r.status,200);assert.ok((await r.text()).length>100);}
 }finally{await new Promise(r=>app.server.close(r));await rm(directory,{recursive:true,force:true});}
});

test('debug page renders untrusted prompt as text and stale detail cannot replace another session',async()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.classList={toggle(){}};this.value='all';}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}after(){}set innerHTML(v){throw Error('HTML injection');}}
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);};let release;
 const sandbox=vm.createContext({document:{getElementById:get,createElement:t=>new Element(t)},location:{search:''},localStorage:{getItem:()=>null},URLSearchParams,history:{replaceState(){}},setInterval(){},fetch:async()=>({ok:true,json:()=>new Promise(r=>release=r)})});
 const source=await readFile(new URL('../server/context-agent/web/debug.js',import.meta.url),'utf8');
 vm.runInContext(source.slice(0,source.indexOf('await sessions().catch')),sandbox);
 vm.runInContext("session='one';snapshot={turns:[]};",sandbox);
 const pending=vm.runInContext("detail('record')",sandbox);await new Promise(setImmediate);
 vm.runInContext("session='two';detailEpoch++;",sandbox);release({record:{id:'record',kind:'message',content:'OLD'}});await pending;assert.equal(get('detail').children[0].textContent,'读取原始记录…');
 const rendered=vm.runInContext("box('原文','<script>attack()</script>',true)",sandbox);assert.equal(rendered.children[1].textContent,'<script>attack()</script>');
});
test('debug preserves model output rejected by protocol validation without executing it',async()=>{
 const {ContextAgent}=await import('../server/context-agent/loop.mjs');const s=createSession();const output=[{type:'message',role:'assistant',status:'incomplete',content:[{type:'output_text',text:'未完成正文'}]}];
 const result=await new ContextAgent({brain:{respond:async()=>output},tools:createTools()}).run(s,'测试不完整响应');assert.equal(result.status,'error');const request=s.records.find(r=>r.event==='model_request');const detail=await debugDetail(s,request.id,()=>{throw Error('not persisted');});assert.equal(detail.response.event,'model_error');assert.deepEqual(detail.response.output,output);assert.equal(s.records.filter(r=>r.kind==='tool_call').length,0);
});
test('debug asset index uses exact structured IDs, not substring guesses',async()=>{const s=createSession();s.assets.a={id:'a',type:'text',version:1};s.assets.abc={id:'abc',type:'text',version:2};const r=appendRecord(s,{kind:'run_event',event:'model_request',input:[{role:'user',content:JSON.stringify({assetDirectory:[{id:'abc'}]})}],tools:[]});const d=await debugDetail(s,r.id,()=>{});assert.deepEqual(d.references.map(a=>a.id),['abc']);});
