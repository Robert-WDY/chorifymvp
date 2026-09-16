import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSession,HistoryStore,appendRecord} from '../server/context-agent/history.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {DeepSeek} from '../server/adapters.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {createImageObserver} from '../server/context-agent/providers.mjs';
import {createContextServer} from '../server/context-agent/http.mjs';

const say=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const call=(id,name,args)=>({type:'function_call',call_id:id,name,arguments:JSON.stringify(args)});
const tools={definitions:[{type:'function',name:'read',parameters:{type:'object',properties:{},additionalProperties:false}}],execute:async()=>({content:'原稿',source:'actual'})};
const run=(brain,options={})=>new ContextAgent({brain,tools,...options});

test('context loop: normal answer is one call with no understanding, planner or final composer',async()=>{
  const state=createSession();let count=0;
  const result=await run({respond:async(input,definitions)=>{count++;assert.match(JSON.stringify(input),/你好/);assert.equal(definitions[0].name,'read');return [say('你好，有什么可以帮你？')];}}).run(state,'你好');
  assert.equal(result.status,'completed');assert.equal(count,1);assert.equal(state.taskStore,undefined);
  assert.equal(state.records.filter(r=>r.kind==='message'&&r.role==='assistant').length,1);
  assert.ok(state.records.some(r=>r.event==='model_request'&&r.input&&r.tools));
});

test('context loop: independent calls return paired results before dependent next call',async()=>{
  const state=createSession();let step=0;const executed=[];
  const brain={respond:async input=>{step++;if(step===1)return [say('先读两份原稿。'),call('a','read',{id:'a'}),call('b','read',{id:'b'})];if(step===2){assert.equal(input.filter(x=>x.type==='function_call_output').length,2);return [call('c','combine',{sources:['a','b']})];}return [say('已根据两份原稿完成。')];}};
  const result=await run(brain,{tools:{definitions:[],execute:async(name,args)=>{executed.push([name,args]);return {content:args};}}}).run(state,'读两份原稿后整合');
  assert.equal(result.status,'completed');assert.deepEqual(executed.map(x=>x[0]),['read','read','combine']);
});

test('context loop: malformed arguments and actionable tool errors return to same model',async()=>{
  let step=0,executions=0;const state=createSession();
  const result=await run({respond:async input=>{if(step++===0)return [{type:'function_call',call_id:'bad',name:'read',arguments:'{'}];assert.match(JSON.stringify(input),/invalid_arguments/);return [say('参数需要修正，未执行调用。')];}},{tools:{definitions:[],execute:async()=>{executions++;}}}).run(state,'读取');
  assert.equal(executions,0);assert.equal(result.status,'completed');
});

test('context loop: truncated message never becomes successful delivery',async()=>{
  for(const status of ['incomplete','failed','in_progress']){
    const state=createSession();const result=await run({respond:async()=>[{...say('部分正文'),status}]}).run(state,'写文案');
    assert.equal(result.status,'error');assert.equal(result.code,'model_incomplete');assert.equal(state.records.filter(r=>r.kind==='message'&&r.role==='assistant').length,0);
  }
});

test('context loop: total step and tool budgets cannot be bypassed by endless calls',async()=>{
  let count=0;const result=await run({respond:async()=>[call('c'+count++,'read',{})]},{maxSteps:2}).run(createSession(),'一直读');
  assert.equal(result.status,'budget_exceeded');assert.equal(count,2);
  let executions=0;const second=await run({respond:async()=>[call('1','read',{}),call('2','read',{})]},{maxToolCalls:1,tools:{definitions:[],execute:async()=>{executions++;}}}).run(createSession(),'读取');
  assert.equal(second.status,'budget_exceeded');assert.equal(executions,0);
});

test('context loop: cancellation closes tool protocol without starting further side effects',async()=>{
  const controller=new AbortController();let executed=0;const state=createSession();
  const result=await run({respond:async()=>[call('one','read',{}),call('two','read',{})]},{tools:{definitions:[],execute:async()=>{executed++;controller.abort();return {ok:true};}}}).run(state,'执行',()=>{},controller.signal);
  assert.equal(result.status,'cancelled');assert.equal(executed,1);assert.equal(state.records.filter(r=>r.kind==='tool_result').length,2);
  assert.equal(JSON.parse(state.records.filter(r=>r.kind==='tool_result').at(-1).output).submitted,false);
});

test('context loop: durable request replay after restart does not call model or tools again',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'context-loop-'));
  try{const store=new HistoryStore(directory),state=await store.create('alice');let called=0;
    const first=await run({respond:async()=>{called++;return [say('正文')];}},{save:s=>store.save(s,'alice')}).run(state,'写一句',()=>{},undefined,{requestId:'request-1'});
    const loaded=await store.load(state.id,'alice');const agent=run({respond:async()=>{throw new Error('must not run');}});
    assert.equal((await agent.run(loaded,'写一句',()=>{},undefined,{requestId:'request-1'})).replayed,true);assert.equal(called,1);assert.equal(first.status,'completed');
    await assert.rejects(agent.run(loaded,'改要求',()=>{},undefined,{requestId:'request-1'}),/不能更改/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('context loop: interrupted calls remain inspectable and are never automatically executed',async()=>{
  const state=createSession();appendRecord(state,{kind:'message',role:'user',content:'生成图',turnId:'old',groupId:'old'});appendRecord(state,{kind:'tool_call',name:'generate_image',callId:'paid',arguments:'{}',turnId:'old',groupId:'g'});
  let called=0;const result=await run({respond:async input=>{assert.match(JSON.stringify(input),/interrupted_call/);return [say('此前调用结果未知，需要查询。')];}},{tools:{definitions:[],execute:async()=>{called++;}}}).run(state,'上次结果如何');
  assert.equal(result.status,'completed');assert.equal(called,0);
});

test('context recovery: provider receipt survives crash between submission and tool-result recording',async()=>{
  const state=createSession();appendRecord(state,{kind:'tool_call',name:'generate_video',callId:'paid-video',arguments:'{}',turnId:'old',groupId:'g'});
  state.invocations['receipt-old']={kind:'media',callId:'paid-video',turnId:'old',receiptId:'receipt-old',providerReceiptId:'vendor-original',attempted:true,status:'inflight'};
  const result=await run({respond:async input=>{const feedback=input.find(x=>x.type==='function_call_output');assert.equal(JSON.parse(feedback.output).receiptId,'receipt-old');assert.equal(JSON.parse(feedback.output).submitted,'unknown');return [say('已有回执可供查询，不会重新生成。')];}}).run(state,'视频怎么样了');assert.equal(result.status,'completed');
});

test('context model budget: visual observation shares the same total model budget and exact trace',async()=>{
  const state=createSession();state.assets.img={id:'img',type:'image',url:'https://fixtures.example.test/img.png',version:1};let visionCalls=0,mainCalls=0;
  const observer=createImageObserver({respond:async()=>{visionCalls++;return [say('可见白色瓶身，容量无法确认。')];}});
  const agent=new ContextAgent({brain:{respond:async()=>{mainCalls++;return [call('observe','analyze_image',{imageIds:['img'],question:'可见什么？'})];}},tools:createTools({observeImages:observer}),maxModelCalls:2});
  const result=await agent.run(state,'看看这张图');assert.equal(result.status,'budget_exceeded');assert.equal(mainCalls,1);assert.equal(visionCalls,1);assert.equal(result.modelCalls,2);
  assert.ok(state.records.some(r=>r.event==='model_request'&&r.phase==='image_observation'&&r.input.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='input_image'))));
});

test('context loop: actual provider adapter wire preserves native call/result feedback (mock HTTP)',async()=>{
  const requests=[];const brain=new DeepSeek({key:'offline-test',baseUrl:'https://example.test',model:'offline-model'},async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);return new Response(JSON.stringify({id:'mock',status:'completed',output:requests.length===1?[call('wire-1','read',{})]:[say('依据真实工具回执回复。')]}),{status:200,headers:{'Content-Type':'application/json'}});
  });
  const result=await run(brain).run(createSession(),'读取资料');assert.equal(result.status,'completed');assert.equal(requests.length,2);
  assert.ok(requests[1].input.some(x=>x.type==='function_call'&&x.call_id==='wire-1'));assert.ok(requests[1].input.some(x=>x.type==='function_call_output'&&x.call_id==='wire-1'));
  assert.equal(requests[0].text,undefined);
});

test('context entry: separate HTTP serves UI and uses only context sessions; CSRF and model opt-in enforced',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'context-http-'));let modelCalls=0;
  const app=createContextServer({directory,brain:{respond:async()=>{modelCalls++;return [say('你好')];}},tools:createTools(),modelEnabled:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  try{
    assert.match(await(await fetch(base)).text(),/上下文 Agent/);
    const config=await(await fetch(base+'/api/config')).json();const headers={'Content-Type':'application/json','x-context-token':config.csrf};
    assert.equal((await fetch(base+'/api/session',{method:'POST',body:'{}'})).status,403);
    const session=await(await fetch(base+'/api/session',{method:'POST',headers,body:'{}'})).json();
    assert.equal(session.engine,'context-agent');
    assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({sessionId:session.id,message:'你好'})})).status,403);
    assert.equal(modelCalls,0);assert.equal((await(await fetch(base+'/api/session/'+session.id)).json()).engine,'context-agent');
  }finally{await new Promise(resolve=>app.server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('context entry: actual HTTP roundtrip streams model response into durable new history',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'context-http-live-'));const app=createContextServer({directory,brain:{respond:async()=>[say('离线注入模型的回复')]},tools:createTools(),modelEnabled:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  try{const config=await(await fetch(base+'/api/config')).json();const headers={'Content-Type':'application/json','x-context-token':config.csrf};const session=await(await fetch(base+'/api/session',{method:'POST',headers,body:'{}'})).json();const request={sessionId:session.id,message:'你好',requestId:'http1'};const send=body=>fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify(body)}).then(r=>r.text()).then(t=>t.split('\n').filter(Boolean).map(JSON.parse));const events=await send(request);assert.equal(events.at(-1).status,'completed');const state=await app.store.load(session.id,'local');assert.ok(state.records.some(r=>r.content==='离线注入模型的回复'));assert.equal(state.taskStore,undefined);
    const replay=await send(request);assert.equal(replay.at(-1).replayed,true);assert.equal(replay.at(-1).status,'completed');
    const malformed=await send({...request,requestId:'http2',inputs:[{type:'image',name:'invalid',url:'file:///private'}]});assert.equal(malformed.at(-1).status,'error');assert.match(malformed.at(-1).message,/HTTPS/);
  }finally{await new Promise(resolve=>app.server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('context HTTP approval: displayed group authorizes exactly two calls; replay cannot duplicate submissions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'context-approval-'));let step=0;
  const brain={respond:async input=>{
    if(step++===0)return [call('prepare-one','generate_image',{prompt:'第一张白瓶',size:'2K'}),call('prepare-two','generate_image',{prompt:'第二张白瓶',size:'2K'})];
    if(step===2)return [say('已准备两张独立图片的方案，请批准。')];
    if(step===3){const message=[...input].reverse().find(m=>m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('我批准'));const receipt=JSON.parse(message.content.split('\n').slice(1).join('\n'));return receipt.proposals.map((p,i)=>call('submit-'+i,p.name,{...p.args,proposalId:p.proposalId,approvalId:receipt.approvalId}));}
    return [say('两项模拟调用已返回；未实际生成图片。')];
  }};
  const app=createContextServer({directory,brain,tools:createTools(),modelEnabled:true,agentOptions:{maxMediaCalls:2}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  try{const config=await(await fetch(base+'/api/config')).json();const headers={'Content-Type':'application/json','x-context-token':config.csrf};const session=await(await fetch(base+'/api/session',{method:'POST',headers,body:'{}'})).json();const send=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify({sessionId:session.id,...body})}).then(r=>r.text()).then(t=>t.split('\n').filter(Boolean).map(JSON.parse));
    const prepared=await send('/api/chat',{message:'准备两张白瓶广告图，批准后生成',requestId:'prepare-http'});const proposals=prepared.filter(e=>e.type==='tool_result').map(e=>e.result.proposalId);assert.equal(proposals.length,2);
    assert.equal(Object.keys((await app.store.load(session.id,'local')).invocations).length,0);
    const approved=await send('/api/approve',{proposalIds:proposals,requestId:'approve-http'});assert.equal(approved.at(-1).status,'completed');const state=await app.store.load(session.id,'local');assert.equal(Object.values(state.invocations).filter(i=>i.kind==='media').length,2);assert.equal(Object.values(state.assets).filter(a=>a.simulated).length,2);
    const replay=await send('/api/approve',{proposalIds:proposals,requestId:'approve-http'});assert.equal(replay.at(-1).replayed,true);assert.equal(Object.values((await app.store.load(session.id,'local')).invocations).filter(i=>i.kind==='media').length,2);
  }finally{await new Promise(resolve=>app.server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('context architecture: new execution modules never import old business engine',async()=>{
  const directory=new URL('../server/context-agent/',import.meta.url);const forbidden=/from\s*['"][^'"]*(?:agent-loop|goal-compiler|execution-engine|compiled-runtime|intent|task-state|task-control|tools)\.mjs['"]/;
  for(const name of await readdir(directory)){if(!name.endsWith('.mjs'))continue;const source=await readFile(new URL(name,directory),'utf8');const imports=source.split('\n').filter(line=>/from ['"]\.\.\//.test(line));assert.equal(imports.some(line=>forbidden.test(line)),false,name);assert.doesNotMatch(source,/\b(?:understandGoal|createTask|compileGoal|runCompiled|reconcileTask)\s*\(/,name);}
});
