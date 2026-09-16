// Real local HTTP/persistence/adapters; provider responses are test doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {redactDebug} from '../server/debug-trace.mjs';
test('HTTP text inputs bind by candidate, persist revision lineage, and duplicate requests do not execute again',{timeout:20000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'request-input-http-'));let calls=0;
 const gateway=createServer(async(req,res)=>{try{
  assert.equal(req.url,'/responses');calls++;let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),system=body.input[0].content,p=JSON.parse(body.input[1].content);let value;
  if(system.startsWith('你是创作助手的本轮需求理解器')){
   const source=p.relevantEvidence.references.find(r=>r.filename==='prompt1.txt');assert.ok(source);assert.equal(source.type,'text');
   value={summary:'优化已有提示词',turnOperation:{kind:'modify'},deliverables:[{description:'优化已有提示词',kind:'text',action:'modify',form:'prompt',references:[source.handle],requiredMethods:['creative-prompt-rewrite']}],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''}};
  }else if(system.startsWith('完成当前item或stage')){
   assert.equal((p.sources[0].contentRef?p.changeContract.original:p.sources[0].content),'白色咖啡杯，产品摄影');assert.equal(p.sources[0].version,1);
   value={content:'白色咖啡杯置于简洁背景，柔和侧光，突出杯身轮廓，适用于电商展示。',structure:{prompt:'白色咖啡杯置于简洁背景，柔和侧光，突出杯身轮廓，适用于电商展示。',preservedConstraints:[]}};
  }else{assert.ok(system.startsWith('你是最终回答整理器'));value={artifactIds:p.artifacts.filter(a=>a.delivered).map(a=>a.id)};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}));
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));}});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');const endpoint='http://127.0.0.1:'+gateway.address().port;
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:new URL('../',import.meta.url),windowsHide:true,env:{...process.env,MVP_DATA_DIR:directory,PORT:String(port),BUSINESS_ACTION_MODE:'core',LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'local-only',DEEPSEEK_BASE_URL:endpoint,DEEPSEEK_MODEL:'fixture',DOUBAO_API_KEY:'',DOUBAO_IMAGE_MODEL:''},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{const ended=once(child,'exit');child.kill();await ended;gateway.closeAllConnections();await new Promise(r=>gateway.close(r));if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw Error('unsafe temp path');await rm(directory,{recursive:true,force:true});});
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('backend exited');})]);
 const base='http://127.0.0.1:'+port,config=await(await fetch(base+'/api/config')).json(),requestId=randomUUID();
 const payload={requestId,message:'优化这个图片提示词，让它更适合电商广告。',inputs:[{filename:'prompt1.txt',content:'白色咖啡杯，产品摄影',mimeType:'text/plain'},{filename:'facts.json',content:'{"product":"咖啡杯"}',mimeType:'application/json'}]};
 const post=async data=>fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','x-mvp-token':config.csrf},body:JSON.stringify(data)});
 const response=await post(payload);assert.equal(response.status,200);const events=(await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(events.at(-1).status,'completed',JSON.stringify(events.at(-1)));
 const state=JSON.parse(await readFile(join(directory,requestId+'.json'),'utf8')),input=Object.values(state.taskStore.inputs).find(i=>i.filename==='prompt1.txt'),artifact=Object.values(state.taskStore.artifacts).find(a=>a.purpose==='deliverable');
 assert.equal(Object.keys(state.taskStore.inputs).length,2);assert.equal(artifact.parentId,input.id);assert.equal(artifact.version,2);assert.equal(state.turns[0].responseReceipt.status,'composed');assert.ok(events.at(-1).text.includes(artifact.content));
 const previousCalls=calls;await(await post(payload)).text();assert.equal(calls,previousCalls);
 const invalid=await post({...payload,requestId:randomUUID(),inputs:[{filename:'bad.txt',content:7}]});assert.equal(invalid.status,400);assert.equal(calls,previousCalls);
 if(process.env.FOUNDATIONS_TRACE_DIR)await writeFile(join(process.env.FOUNDATIONS_TRACE_DIR,'input-http.trace.json'),JSON.stringify({evidenceType:'local_provider_fixture',paidCalls:0,state:redactDebug(state)},null,2));
});
