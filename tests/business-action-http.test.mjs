// Real HTTP/session/adapter/executor path; every provider response is local.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {aggregateRun,redactDebug} from '../server/debug-trace.mjs';
test('native Action HTTP creation, revision, observation and Debug context preserve one execution per request',{timeout:20000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'business-action-http-')),submissions=[];let turns=0,observations=0;
 const gateway=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v3/images/generations'){submissions.push(body);return res.end(JSON.stringify({data:[{url:'https://example.com/local-'+submissions.length+'.png',size:'2048x2048'}]}));}
  assert.equal(req.url,'/responses');const messages=body.input,system=messages[0].content;let result;
  if(system.startsWith('你是创作助手的本轮需求理解器')){
   turns++;const p=JSON.parse(messages[1].content);assert.ok(p.relevantEvidence);assert.equal(p.taskSnapshot,undefined);
   const source=p.relevantEvidence.references.findLast(r=>r.type==='image'&&r.productionUsable),target=source?{type:'IMAGE',id:source.id,version:source.version}:undefined;
   const a={id:'main',actionType:turns===1?'CREATE_IMAGE':turns===2?'EDIT_IMAGE':'ANALYZE_IMAGE',intent:p.query,...(target?{target}:{}),...(turns===2?{modification:{change:['背景改红'],preserve:['主体']},parameters:{ratio:'1:1'}}:{})};
   result={summary:p.query,businessActions:[a],safety:{disposition:'allow',untrustedInstructions:false,reason:''}};
  }else if(system.startsWith('你负责为当前已接受媒体节点')){
   const p=JSON.parse(messages[1].content);result={concept:'产品图',preservedConstraints:[],safety:{passed:true,reason:'普通产品'},items:[{prompt:'product picture',size:'2048x2048',...(p.goal.references.length?{referenceImages:p.goal.references}:{})}]};
  }else if(system.startsWith('你是当前任务的视觉证据')){observations++;assert.equal(messages[1].content.filter(p=>p.type==='input_image').length,1);result='本地替身观察结果。';}
  else {assert.ok(system.startsWith('你是最终回答整理器'));result='本轮结果已记录。';}
  res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:typeof result==='string'?result:JSON.stringify(result)}]}]}));
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));}});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');const endpoint='http://127.0.0.1:'+gateway.address().port;
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,MVP_DATA_DIR:directory,PORT:String(port),BUSINESS_ACTION_MODE:'core',LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'local-only',DEEPSEEK_BASE_URL:endpoint,DEEPSEEK_MODEL:'fixture-model',DOUBAO_API_KEY:'local-only',DOUBAO_BASE_URL:endpoint,DOUBAO_IMAGE_MODEL:'fixture-image'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{const exit=once(child,'exit');child.kill();await exit;gateway.closeAllConnections();await new Promise(r=>gateway.close(r));if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw Error('unsafe temporary directory');await rm(directory,{recursive:true,force:true});});
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('backend exited');})]);
 const base='http://127.0.0.1:'+port,config=await(await fetch(base+'/api/config')).json();assert.equal(config.businessActionMode,'core');
 let sessionId;const post=async(message,requestId=randomUUID())=>{const r=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','x-mvp-token':config.csrf},body:JSON.stringify({sessionId,message,requestId})});assert.equal(r.status,200);const events=(await r.text()).trim().split('\n').map(JSON.parse);sessionId=events.find(e=>e.type==='start')?.sessionId||sessionId;if(events.at(-1).status==='needs_input'){
  const snapshot=await(await fetch(base+'/api/session/'+sessionId)).json(),task=snapshot.task;
  assert.equal(task.status,'WAIT_CONFIRM');assert.equal(task.effectPolicy,'explicit_approval');assert.equal(submissions.length,turns-1);
  const confirmed=await fetch(base+'/api/task/continue',{method:'POST',headers:{'Content-Type':'application/json','x-mvp-token':config.csrf},body:JSON.stringify({sessionId,taskId:task.id,planHash:task.approval.planHash,requestId:randomUUID()})});assert.equal(confirmed.status,200);
  const resumed=(await confirmed.text()).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(resumed.at(-1).status,'completed');events.push(...resumed);
 }else assert.equal(events.at(-1).status,'completed');return events;};
 await post('创建蓝色产品图');await post('把背景改成红色，主体不变');const requestId=randomUUID();await post('分析这张图片',requestId);
 const state=JSON.parse(await readFile(join(directory,sessionId+'.json'),'utf8')),images=Object.values(state.taskStore.artifacts).filter(a=>a.type==='image');
 assert.equal(submissions.length,2);assert.equal(observations,1);assert.equal(images.length,2);assert.equal(images[1].parentArtifact,images[0].id);assert.equal(images[1].version,2);
 assert.ok(state.turns.filter(t=>t.businessAction).every(t=>t.businessAction.mode==='action_compiled'));assert.equal(Object.keys(state.taskStore.tasks).length,2);
 const run=aggregateRun(state,requestId);assert.equal(run.intent.businessAction.actions[0].actionType,'ANALYZE_IMAGE');
 assert.ok(run.sessionView.assembly[0].conversation.recentMessages.length);assert.ok(run.contextSnapshots.some(c=>c.phase==='observe_image'&&c.actualRequest.input[1].content.some(p=>p.type==='input_image')));
 await post('分析这张图片',requestId);assert.equal(observations,1);assert.equal(turns,3);
 if(process.env.BUSINESS_ACTION_TRACE_DIR)await writeFile(join(process.env.BUSINESS_ACTION_TRACE_DIR,'http-trace.json'),JSON.stringify({evidenceType:'local_provider_fixture',paidCalls:0,state:redactDebug(state)},null,2));
});
