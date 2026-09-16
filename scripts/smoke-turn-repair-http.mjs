import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const root='http://127.0.0.1:3212',out='data/turn-semantics-repair-20260914',config=await fetch(root+'/api/config').then(r=>r.json()),sessionId=randomUUID(),requests=[];
async function send(message,requestId=randomUUID(),existing=true){const request={message,requestId,...(existing?{sessionId}:{})},response=await fetch(root+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','x-mvp-token':config.csrf},body:JSON.stringify(request)}),body=await response.text();assert.equal(response.status,200);const events=body.split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x)),final=events.findLast(e=>e.type==='final');requests.push({request,responseStatus:response.status,events});assert.equal(final.status,'completed');return {requestId,final};}
// No model transport is needed for these registry/message queries.
await send('你是什么模型',sessionId,false);
const second=await send('把我上一条消息原样复述一遍。');assert.match(second.final.text,/你是什么模型/);
const duplicate=await send('把我上一条消息原样复述一遍。',second.requestId);assert.equal(duplicate.final.text,second.final.text);
const stored=JSON.parse(fs.readFileSync('data/manual-fixed-server/'+sessionId+'.json'));assert.equal(stored.modelCalls?.length||0,0);assert.equal(Object.keys(stored.taskStore.executions).length,0);assert.equal(stored.turns.length,2);
const summary={sessionId,provider:config.provider,model:config.model,protocol:config.capabilities.protocol,httpRequests:requests.length,uniqueTurns:stored.turns.length,modelCalls:0,mediaSubmissions:0,exactHistory:true,idempotentReplay:true,allPassed:true};
fs.writeFileSync(out+'/http-smoke.json',JSON.stringify({summary,requests,state:stored},null,2));console.log(JSON.stringify(summary));
