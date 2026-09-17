// HTTP checks are local. Only --live-text authorizes one smoke conversation.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {HistoryStore} from '../../server/context-agent/history.mjs';
const base='http://127.0.0.1:3217';
const file=name=>new URL(name,import.meta.url);
const save=(name,value)=>writeFile(file(name),JSON.stringify(value,null,2)+'\n');
const hash=body=>createHash('sha256').update(body).digest('hex');
const get=async route=>{const r=await fetch(base+route);assert.equal(r.status,200);return r.json();};
if(process.argv.includes('--recover')){
 const before=JSON.parse(await readFile(file('http-evidence.json'),'utf8'));
 const state=await get('/api/session/'+before.sessionId);
 assert.deepEqual(state.messages,before.messages);
 assert.equal(state.assets.length,0);
 await save('restart-evidence.json',{at:new Date().toISOString(),sessionId:state.id,messagesUnchanged:true,assetsUnchanged:true});
 console.log('Restart recovery: messages and assets unchanged');
}else{
 const config=await get('/api/config');
 assert.equal(config.engine,'context-agent');assert.equal(config.modelEnabled,true);
 const checks={};
 for(const [route,name]of [['/','index.html'],['/app.js','app.js'],['/style.css','style.css']]){
  const response=await fetch(base+route);assert.equal(response.status,200);
  const served=Buffer.from(await response.arrayBuffer()),local=await readFile(new URL('../../server/context-agent/web/'+name,import.meta.url));
  assert.equal(hash(served),hash(local));checks[name]={status:200,sha256:hash(served),matchesCheckout:true};
 }
 assert.equal((await fetch(base+'/api/sessions')).status,404);
 assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/config',{headers:{Origin:'http://127.0.0.1:3212'}})).status,403);
 const headers={'Content-Type':'application/json','x-context-token':config.csrf};
 const created=await fetch(base+'/api/session',{method:'POST',headers,body:'{}'});assert.equal(created.status,201);
 const {id}=await created.json();let state=await get('/api/session/'+id);
 assert.equal(state.messages.length,0);assert.equal(state.assets.length,0);
 if(process.argv.includes('--live-text')){
  const response=await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({sessionId:id,message:'只回复“本地独立实例正常”，不要调用工具。'}),signal:AbortSignal.timeout(60000)});
  assert.equal(response.status,200);
  const events=(await response.text()).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  await save('text-events.json',events);
  state=await get('/api/session/'+id);
  assert.equal(state.messages.at(-1)?.role,'assistant');
  assert.equal(state.messages.at(-1)?.content,'本地独立实例正常');
  const store=new HistoryStore(fileURLToPath(new URL('../../data/isolated-local/',import.meta.url)));
  const trace=await store.exportSession(id,'local');await save('text-trace.json',trace);
  const requests=trace.records.filter(r=>r.event==='model_request');
  assert.equal(requests.length,1);assert.equal(trace.records.filter(r=>r.kind==='tool_call').length,0);
  checks.liveText={actualModelCalls:requests.length,toolCalls:0,reply:state.messages.at(-1).content,usage:trace.records.filter(r=>r.event==='model_response').map(r=>r.usage)};
 }
 await save('http-evidence.json',{at:new Date().toISOString(),engine:config.engine,model:config.model,modelEnabled:config.modelEnabled,mediaMode:config.mediaMode,limits:config.limits,checks,foreignOriginStatus:403,missingTokenStatus:403,oldEndpointStatus:404,sessionInitiallyEmpty:true,sessionId:id,messages:state.messages});
 console.log(JSON.stringify({sessionId:id,checks,foreignOriginStatus:403,missingTokenStatus:403,oldEndpointStatus:404}));
}
