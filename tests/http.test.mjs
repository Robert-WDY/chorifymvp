import {finalFixtureText} from './runtime-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rm, mkdtemp } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { once } from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SessionStore} from '../server/session-store.mjs';
import {createTask} from '../server/task-state.mjs';
import {compileGoal} from '../server/goal-compiler.mjs';
for(const provider of ['doubao','deepseek'])test(`${provider} compiled HTTP loop: contracted skills, image/video artifacts and request isolation`,{timeout:30000},async()=>{
 const testData=await mkdtemp(join(tmpdir(),'mvp-http-'));
 const endpoints=[];
 const gateway=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const data=raw?JSON.parse(raw):{};res.setHeader('Content-Type','application/json');
  const send=x=>res.end(JSON.stringify(x));endpoints.push(req.url);
  assert.equal(req.headers.authorization,req.url==='/responses'?'Bearer test-deepseek-private':'Bearer test-private');
  if(req.url==='/api/v3/images/generations')return send({data:[{url:'https://example.com/image.png'}]});
  if(req.url==='/api/v3/contents/generations/tasks')return send({id:'video-test-1'});
  if(req.url==='/api/v3/contents/generations/tasks/video-test-1')return send({status:'succeeded',content:{video_url:'https://example.com/video.mp4'}});
  if(!['/api/v3/responses','/responses'].includes(req.url)){res.statusCode=404;return send({error:'unexpected endpoint'});}
  if(data.input[0]?.content?.startsWith('你是最终回答整理器'))return send({output:[{type:'message',content:[{type:'output_text',text:finalFixtureText(JSON.parse(data.input[1].content))}]}]});
  if(data.input[0]?.content?.startsWith('你是任务交付验证器'))return send({output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({passed:true,issues:[],uncertain:false})}]}]});
  if(data.input[0]?.content?.startsWith('独立提取原始请求')){const q=JSON.parse(data.input[1].content).query;return send({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({media:{image:q.includes('图片')?1:0,video:q.includes('视频')?1:0,audio:0},requiredMethods:[],readOnly:false,evidence:q})}]}]});}
  if(data.input[0]?.content?.startsWith('你是创作助手的本轮需求理解器')||data.input[0]?.content?.startsWith('你是能力选择器')){
   const query=JSON.parse(data.input.at(-1).content).query;
   const payload=JSON.parse(data.input.at(-1).content);
   // The gateway fixture reads either supported context projection; assertions
   // below still exercise real HTTP execution, exact state and isolation.
   payload.taskSnapshot??=payload.activeTaskState;
   payload.referenceCatalog??={entries:payload.relevantEvidence?.references||[]};
   let operationCandidate;
   if(query==='读取已保存方案')operationCandidate={kind:'inspect',targetTaskId:payload.taskSnapshot.id,query:{kind:'plan'}};
   if(query==='确认同时改成9:16，仍不生成')operationCandidate={kind:'revise_plan',targetTaskId:payload.taskSnapshot.id};
   if(query==='显示刚才图片')operationCandidate={kind:'present',presentation:{targets:payload.referenceCatalog.entries.filter(e=>e.type==='image'&&e.productionUsable).map(e=>e.handle)}};
   if(operationCandidate||query==='准备视频方案，等我确认'){
    const value={summary:query,turnOperation:operationCandidate||{kind:'create'},deliverables:operationCandidate?.kind==='revise_plan'?[{kind:'video',action:'create',description:'改画幅',count:1,spec:{ratio:'9:16'}}]:operationCandidate?[]:[{kind:'video',action:'create',description:'5秒16:9咖啡',count:1,spec:{ratio:'16:9',durationSeconds:5}}],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:!operationCandidate||operationCandidate.kind==='revise_plan',reason:'等我确认'}};
    if(operationCandidate?.kind==='revise_plan'){
     const source=payload.taskSnapshot.revisionTarget;
     value.deliverables=[];value.revisionDelta={targetArtifactId:source.targetArtifactId,targetVersion:source.targetVersion,changes:[{field:'ratio',from:source.parameters[0].ratio,to:'9:16'}],preserve:['duration','source','facts']};
    }
    return send({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
   }
   const operation=query.includes('图片')?'generate_image':query.includes('视频')?'generate_video':'rewrite';
   // Deterministic fake gateway only. Production accepts one compact operation; subsequent work compiles it.
   const goal=data.input[0].content.startsWith('你是能力选择器')?{routes:[{deliverableIndex:0,operation,skills:[]}]}:{summary:query,turnOperation:{kind:'create'},deliverables:[{description:query,kind:operation==='generate_image'?'image':operation==='generate_video'?'video':'text',count:1,action:'create',dependsOn:[],references:[],constraints:[],requestEvidence:query}],facts:[],globalConstraints:[],gaps:[],assumptions:[],approval:{required:false,reason:''},safety:{disposition:'allow',untrustedInstructions:false,reason:''}};
   return send({output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(goal)}]}]});
  }
  assert.ok(!data.tools?.length);
  const skill=data.input[0].content.startsWith('你负责为当前已接受媒体节点');
  const taskInput=JSON.parse(data.input.findLast(m=>m.role==='user').content);
  const result=skill?{concept:'晨光咖啡',preservedConstraints:[],safety:{passed:true,reason:'普通创作'},items:[{prompt:'coffee',...(taskInput.goal.operation==='generate_video'?{duration:5,ratio:'16:9'}:{})}]}:{content:'晨光穿过咖啡杯，唤醒城市。'};
  send({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(result)}]}]});
 });
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');const gatewayUrl=`http://127.0.0.1:${gateway.address().port}`;
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,MVP_DATA_DIR:testData,LLM_PROVIDER:provider,DEEPSEEK_API_KEY:'test-deepseek-private',DEEPSEEK_BASE_URL:gatewayUrl,DEEPSEEK_MODEL:'deepseek-flash',DEEPSEEK_REASONING_EFFORT:'none',PORT:String(port),DOUBAO_API_KEY:'test-private',DOUBAO_BASE_URL:gatewayUrl,DOUBAO_CHAT_MODEL:'test',DOUBAO_IMAGE_MODEL:'test-image',DOUBAO_VIDEO_MODEL:'test-video'},stdio:['ignore','pipe','pipe']});
 const ids=[];
 try{
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('server exited');})]);
  const base=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(base)).status,200);
  const config=await(await fetch(base+'/api/config')).json();assert.equal(config.skills.length,15);assert.equal(config.capabilities.tools.length,3);assert.ok(!JSON.stringify(config).includes('test-private'));
  assert.equal(config.provider,provider);assert.ok(!JSON.stringify(config).includes('test-deepseek-private'));assert.equal(config.videoVerificationModel,'test');
  assert.equal((await fetch(base+'/api/chat',{method:'POST',body:JSON.stringify({message:'hello'})})).status,403);
  const headers={'Content-Type':'application/json','X-MVP-Token':config.csrf};
  const chat=async(message,sessionId)=>{
   const r=await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({message,sessionId})});assert.equal(r.status,200);
   const events=(await r.text()).split('\n').filter(Boolean).map(JSON.parse);ids.push(events[0].sessionId);return events;
  };
  const confirm=async events=>{
   const sessionId=events[0].sessionId,snapshot=await(await fetch(base+'/api/session/'+sessionId)).json(),task=snapshot.task;assert.equal(task.status,'WAIT_CONFIRM');
   const response=await fetch(base+'/api/task/continue',{method:'POST',headers,body:JSON.stringify({sessionId,taskId:task.id,planHash:task.approval.planHash})});assert.equal(response.status,200);events.push(...(await response.text()).split('\n').filter(Boolean).map(JSON.parse));return events;
  };
  const rewrite=await chat('改写提示词');assert.equal(rewrite.at(-1).status,'completed');assert.ok(rewrite.some(x=>x.name==='commit_text_deliverable'));
  const image=await confirm(await chat('生成图片'));assert.ok(image.some(x=>x.result?.images?.[0].url==='https://example.com/image.png'));
  assert.ok(image.some(x=>x.name==='run_skill'&&x.result?.contractValidated));
  const imageId=image[0].sessionId,readBefore=await new SessionStore(testData).load(imageId),beforeImagePosts=endpoints.filter(x=>x==='/api/v3/images/generations').length;
  const presented=await chat('显示刚才图片',imageId);assert.match(presented.at(-1).text,/!\[/);assert.equal(endpoints.filter(x=>x==='/api/v3/images/generations').length,beforeImagePosts);
  const readAfter=await new SessionStore(testData).load(imageId);assert.deepEqual(readAfter.taskStore,readBefore.taskStore);
  const pending=await chat('准备视频方案，等我确认'),pendingId=pending[0].sessionId;
  const getState=()=>new SessionStore(testData).load(pendingId),oldState=await getState(),oldTask=oldState.taskStore.tasks[oldState.taskStore.activeTaskId];assert.equal(oldTask.status,'WAIT_CONFIRM');
  const beforeVideoPosts=endpoints.filter(x=>x==='/api/v3/contents/generations/tasks').length;
  const readPlan=await chat('读取已保存方案',pendingId);assert.match(readPlan.at(-1).text,/16:9/);assert.deepEqual((await getState()).taskStore,oldState.taskStore);
  const revision=await chat('确认同时改成9:16，仍不生成',pendingId);assert.equal(revision.at(-1).status,'needs_input');
  const revisedState=await getState(),newTask=revisedState.taskStore.tasks[revisedState.taskStore.activeTaskId];assert.equal(newTask.status,'WAIT_CONFIRM');assert.equal(newTask.approval.payload.items[0].ratio,'9:16');assert.equal(newTask.approval.payload.items[0].duration,5);assert.notEqual(newTask.approval.planHash,oldTask.approval.planHash);
  const stale=await fetch(base+'/api/task/continue',{method:'POST',headers,body:JSON.stringify({sessionId:pendingId,taskId:oldTask.id,planHash:oldTask.approval.planHash})});const staleBody=await stale.text();assert.ok(stale.status!==200||staleBody.includes('failed')||staleBody.includes('被修订'));
  assert.equal(endpoints.filter(x=>x==='/api/v3/contents/generations/tasks').length,beforeVideoPosts);
  const persisted=await getState();assert.equal(persisted.taskStore.tasks[newTask.id].approval.status,'pending');
  const video=await confirm(await chat('生成视频'));assert.equal(video.at(-1).status,'completed');assert.ok(video.some(x=>x.result?.videoUrl==='https://example.com/video.mp4'));
  const id=video[0].sessionId;const session=await(await fetch(base+'/api/session/'+id)).json();assert.equal(session.status,'completed');
  assert.equal(session.messages[0].role,'user');assert.equal(session.messages[0].content,'生成视频');
  const history=await(await fetch(base+'/api/sessions?q='+encodeURIComponent('生成视频'))).json();
  assert.ok(history.sessions.some(s=>s.id===id&&s.title==='生成视频'&&s.turnCount===1));
  assert.ok(history.sessions.every(s=>!('messages' in s)&&!('events' in s)&&!('modelCalls' in s)));
  for(const query of ['offset=-1','limit=201','offset=no','limit=1.5','q='+('a'.repeat(201))])assert.equal((await fetch(base+'/api/sessions?'+query)).status,400);
  const concurrent=await Promise.all([1,2].map(()=>fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({message:'继续改写',sessionId:id})})));
  assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);await Promise.all(concurrent.map(x=>x.text()));
  assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({message:'x',sessionId:'../../.env'})})).status,400);
  const interrupted={id:randomUUID(),messages:[],events:[]};ids.push(interrupted.id);
  const task=createTask(interrupted,{summary:'恢复文字交付',tasks:[{operation:'rewrite',output:'text',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none'}],skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow'},semantic:{approval:{required:false}}},'恢复文字交付');
  task.protocol='compiled-v1';task.executionPlan=compileGoal(task);
  await new SessionStore(testData).save(interrupted);
  const restored=await(await fetch(base+'/api/session/'+interrupted.id)).json();
  assert.equal(restored.status,'interrupted');assert.equal(restored.task.actions.canResume,true);
  const continued=await fetch(base+'/api/task/continue',{method:'POST',headers,body:JSON.stringify({sessionId:interrupted.id,taskId:task.id})});
  assert.equal(continued.status,200);const resumedEvents=(await continued.text()).split('\n').filter(Boolean).map(JSON.parse);assert.equal(resumedEvents.at(-1).status,'completed');assert.equal(resumedEvents.at(-1).taskId,task.id);
  assert.ok(endpoints.every(x=>x.startsWith('/api/v3/')||provider==='deepseek'&&x==='/responses'));
 }finally{
  child.kill();await once(child,'exit');await new Promise(resolve=>gateway.close(resolve));
  for(const id of new Set(ids))if(/^[a-f0-9-]{36}$/.test(id))await rm(join(testData,id+'.json'),{force:true});
 }
});
