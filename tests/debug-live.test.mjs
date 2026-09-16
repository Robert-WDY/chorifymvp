import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createDebugServer} from '../server/debug-server.mjs';
import {DebugTraceStore} from '../server/debug-trace.mjs';
import {DebugLiveBridge} from '../server/debug-live.mjs';
import {startFixture} from './fixtures/debug-live-backend.mjs';
async function setup(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'chorify-debug-live-')),backend=await startFixture(dir,options),store=new DebugTraceStore([dir]);
 const live=new DebugLiveBridge({backendUrl:backend.url,source:store.sources[0]}),server=createDebugServer(store,{live});server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{backend.finishAll();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>backend.server.close(r))]);await rm(dir,{force:true,recursive:true});});
 const config=await(await fetch(url+'/api/debug/live/config')).json();
 const post=(path,body,headers={})=>fetch(url+'/api/debug/live/'+path,{method:'POST',headers:{'Content-Type':'application/json','x-debug-token':config.csrf,...headers},body:JSON.stringify(body)});
 return {dir,url,backend,config,post};
}
test('live config exposes model/source and debug token, not backend token',async t=>{const {config}=await setup(t);assert.equal(config.available,true);assert.equal(config.model,'OFFLINE_TEST_DOUBLE');assert.equal(config.source,'source0');assert.ok(config.csrf);assert.ok(!JSON.stringify(config).includes('offline-backend-token'));});
test('streamed start and saved running model call visible before final completion',async t=>{
 const {url,post,backend}=await setup(t,{delayMs:60000}),id=randomUUID();const res=await post('chat',{requestId:id,message:'查看中间过程'});assert.equal(res.status,200);const reader=res.body.getReader(),first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/start/);assert.ok(!first.includes('fixture-secret'));
 const r=await(await fetch(url+'/api/debug/run/'+id+'?source=source0&sessionId='+id)).json();assert.equal(r.status,'running');assert.equal(r.contextSnapshots.length,1);assert.equal(r.contextSnapshots[0].output,null);
 backend.finishAll();let rest='';for(;;){const chunk=await reader.read();if(chunk.done)break;rest+=new TextDecoder().decode(chunk.value);}assert.match(rest,/final/);assert.equal(backend.calls.filter(c=>c.path==='/api/chat').length,1);
});
test('follow-up preserves session ID while assigning a distinct request/run ID',async t=>{
 const {url,post,backend}=await setup(t),sid=randomUUID(),second=randomUUID();await(await post('chat',{requestId:sid,message:'第一轮'})).text();await(await post('chat',{requestId:second,sessionId:sid,message:'第二轮'})).text();assert.equal(backend.states.get(sid).turns.length,2);
 const list=await(await fetch(url+'/api/debug/live/sessions')).json();assert.equal(list.sessions[0].id,sid);assert.equal(backend.calls[1].body.requestId,second);assert.equal(backend.calls[1].body.sessionId,sid);
});
test('cancel delegates to the existing backend and waits for final state',async t=>{
 const {post,backend}=await setup(t,{delayMs:60000}),id=randomUUID();const response=await post('chat',{requestId:id,message:'运行后停止'});assert.equal((await post('cancel',{sessionId:id})).status,200);const stream=await response.text();assert.match(stream,/cancelled/);assert.equal(backend.states.get(id).turns[0].status,'cancelled');
});
test('mismatched data directory blocks execution before any backend POST',async t=>{
 const {config,backend,url}=await setup(t,{identity:'wrong-directory'});assert.equal(config.available,false);const live=new DebugLiveBridge({backendUrl:backend.url,source:{id:'source0',directory:'some-other-dir'}});await assert.rejects(()=>live.config(),/目录不一致/);assert.equal(backend.calls.length,0);assert.equal((await fetch(url+'/api/debug/live/chat',{method:'POST'})).status,403);
});
test('CSRF and cross-site submissions are rejected',async t=>{
 const {post,backend}=await setup(t),data={requestId:randomUUID(),message:'should not execute'};
 assert.equal((await post('chat',data,{'x-debug-token':'invalid'})).status,403);assert.equal((await post('chat',data,{Origin:'https://evil.test'})).status,403);assert.equal((await post('chat',data,{'Sec-Fetch-Site':'cross-site'})).status,403);assert.equal(backend.calls.length,0);
});
test('bridge rejects arbitrary payload fields and invalid request IDs',async t=>{
 const {post,backend}=await setup(t);assert.equal((await post('chat',{requestId:'bad',message:'query'})).status,400);assert.equal((await post('chat',{requestId:randomUUID(),message:'query',source:'archive',model:'override'})).status,400);assert.equal((await post('cancel',{})).status,400);assert.equal(backend.calls.length,0);
});
test('only fixed localhost backend URLs are accepted',()=>{for(const backendUrl of ['https://example.com','http://example.com','http://127.0.0.1:3212/api/chat','http://user:pass@localhost:3212','http://localhost:3212/?x=1'])assert.throws(()=>new DebugLiveBridge({backendUrl,source:{id:'x',directory:'.'}}));});
test('concurrent session conflict is forwarded without automatic retry',async t=>{
 const {post,backend}=await setup(t,{delayMs:60000}),sid=randomUUID();const first=await post('chat',{requestId:sid,message:'one'});assert.equal((await post('chat',{requestId:randomUUID(),sessionId:sid,message:'two'})).status,409);backend.finishAll();await first.text();assert.equal(backend.calls.filter(c=>c.path==='/api/chat').length,2);assert.equal(backend.states.get(sid).turns.length,1);
});
