// Explicit offline test double. Never imports a model/provider or media adapter.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {directoryIdentity,DebugLiveBridge} from '../../server/debug-live.mjs';
import {DebugTraceStore} from '../../server/debug-trace.mjs';
import {createDebugServer} from '../../server/debug-server.mjs';
export async function startFixture(directory,{delayMs=50,port=0,identity=directoryIdentity(directory)}={}){
 await mkdir(directory,{recursive:true});const calls=[],states=new Map(),active=new Map();
 const server=createServer(async(req,res)=>{
  const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  if(req.url==='/api/config')return json(200,{csrf:'offline-backend-token',dataDirectoryId:identity,brainReady:true,model:'OFFLINE_TEST_DOUBLE',provider:'test'});
  if(req.url.startsWith('/api/sessions'))return json(200,{sessions:[...states.values()].map(s=>({id:s.id,title:s.turns[0].rawInput,status:s.turns.at(-1).status})),total:states.size});
  if(req.method!=='POST')return json(404,{});
  if(req.headers['x-mvp-token']!=='offline-backend-token')return json(403,{});
  let input='';for await(const c of req)input+=c;const body=JSON.parse(input);
  calls.push({path:req.url,body,token:req.headers['x-mvp-token']});
  if(req.url==='/api/cancel'){active.get(body.sessionId)?.();return json(200,{ok:true});}
  const sid=body.sessionId||body.requestId;
  if(active.has(sid))return json(409,{error:'session running'});
  let s=states.get(sid);if(!s){if(body.sessionId)return json(404,{error:'session missing'});s={id:sid,turns:[],events:[],modelCalls:[],taskStore:{tasks:{},toolCalls:{},executions:{},artifacts:{}},messages:[]};states.set(sid,s);}
  if(s.turns.some(t=>t.runId===body.requestId))return json(409,{error:'already submitted'});
  const turn={runId:body.requestId,requestId:body.requestId,rawInput:body.message,status:'running',createdAt:new Date().toISOString()};s.turns.push(turn);
  const call={id:randomUUID(),runId:turn.runId,model:'OFFLINE_TEST_DOUBLE',input:[{role:'user',content:body.message}],normalizedRequest:{model:'OFFLINE_TEST_DOUBLE',input:[{role:'user',content:body.message}]},status:'running',startedAt:new Date().toISOString()};s.modelCalls.push(call);
  const event={eventId:randomUUID(),runId:turn.runId,sessionId:sid,type:'start',occurredAt:new Date().toISOString()};s.events.push(event);
  let cancelled=false,release;const wait=new Promise(r=>release=r);const timer=setTimeout(release,delayMs);active.set(sid,()=>{cancelled=true;release();});
  await writeFile(join(directory,sid+'.json'),JSON.stringify(s));
  res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.write(JSON.stringify({...event,headers:{Authorization:'Bearer fixture-secret'}})+'\n');
  await wait;clearTimeout(timer);
  turn.status=cancelled?'cancelled':'completed';turn.finishedAt=new Date().toISOString();call.status='returned';call.finishedAt=turn.finishedAt;call.output=[{content:[{text:'离线测试返回，仅验证界面与传输。'}]}];
  const final={eventId:randomUUID(),runId:turn.runId,type:'final',status:turn.status,text:'离线测试返回，第 '+s.turns.length+' 轮。',occurredAt:turn.finishedAt};s.events.push(final);
  await writeFile(join(directory,sid+'.json'),JSON.stringify(s));active.delete(sid);res.end(JSON.stringify(final)+'\n');
 });
 server.listen(port,'127.0.0.1');await once(server,'listening');
 return {server,url:'http://127.0.0.1:'+server.address().port,calls,states,finishAll:()=>{for(const end of active.values())end();},read:id=>readFile(join(directory,id+'.json'),'utf8')};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const directory=resolve(process.argv[2]);const fixture=await startFixture(directory,{delayMs:15000,port:3226});const store=new DebugTraceStore([directory]);
 const debug=createDebugServer(store,{live:new DebugLiveBridge({backendUrl:fixture.url,source:store.sources[0]})});debug.listen(3227,'127.0.0.1',()=>console.log('OFFLINE UI TEST ONLY http://127.0.0.1:3227'));
}
