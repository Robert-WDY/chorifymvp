import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {createSession,HistoryStore} from '../server/context-agent/history.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {interactions} from '../server/context-agent/interactions.mjs';
import {publicEvents,resultSummary} from '../server/context-agent/public-events.mjs';
import {createContextServer} from '../server/context-agent/http.mjs';
const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(name,args,id)=>[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}];
const question={message:'需要两个必要配置',questions:[{key:'place',label:'使用位置',allowFreeText:true,options:[{id:'social',label:'社交信息流'}]},{key:'language',label:'文案语言',allowFreeText:false,options:[{id:'zh',label:'中文'},{id:'en',label:'英文'}]}]};

test('public activity preserves pending, unknown and actual batch submission semantics',()=>{
 assert.equal(resultSummary({ok:true,status:'queued',submitted:true}).status,'pending');
 const unknown=resultSummary({ok:false,status:'unknown',submitted:'unknown'});assert.equal(unknown.status,'unknown');assert.equal(unknown.submitted,'unknown');
 const batch=resultSummary({ok:true,outcome:'succeeded',submission:'submitted',items:[{receiptId:'r',proposalId:'p',outcome:'succeeded',submission:'submitted',resultRefs:[{id:'image',type:'image',version:1}]}]});assert.equal(batch.submitted,true);assert.equal(batch.receipts[0].receiptId,'r');assert.equal(batch.resultRefs[0].id,'image');
});

test('question pauses with one paired result; partial answer persists across restart with zero model calls; complete answer resumes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'interaction-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new HistoryStore(dir),state=await store.create('owner');
 let calls=0;const brain={respond:async input=>{calls++;if(calls===1)return call('request_user_input',question,'question');assert.match(JSON.stringify(input),/social/);assert.match(input.flatMap(x=>typeof x.content==='string'?[x.content]:(x.content||[]).map(p=>p.text||'')).join('\n'),/"en"/);return say('使用社交信息流与英文。');}};
 const agent=new ContextAgent({tools:createTools(),brain,save:s=>store.save(s,'owner')});
 const result=await agent.run(state,'需要配置再继续');assert.equal(result.status,'waiting_user');assert.equal(calls,1);assert.equal(state.records.filter(r=>r.kind==='tool_result').length,1);
 const id=interactions(state)[0].interactionId;
 let restored=await store.load(state.id,'owner');
 const partial=await agent.run(restored,'回答位置',()=>{},undefined,{interactionResponse:{interactionId:id,action:'submit',answers:{place:{optionId:'social'}}}});
 assert.equal(partial.status,'waiting_user');assert.equal(partial.modelCalls,0);assert.equal(calls,1);
 restored=await store.load(state.id,'owner');assert.equal(interactions(restored)[0].answers.place.optionId,'social');
 const complete=await agent.run(restored,'回答语言',()=>{},undefined,{interactionResponse:{interactionId:id,action:'submit',answers:{language:{optionId:'en'}}}});
 assert.equal(complete.status,'completed');assert.equal(calls,2);assert.equal(interactions(restored)[0].status,'answered');assert.equal(Object.keys(restored.approvals).length,0);
 await assert.rejects(agent.run(restored,'重复提交',()=>{},undefined,{interactionResponse:{interactionId:id,action:'submit',answers:{language:{optionId:'en'}}}}),{code:'interaction_closed'});
});
test('invalid answers, foreign interactions, sensitive forms and forged selections do not call models or media',async()=>{
 const state=createSession();let calls=0;const tools=createTools(),agent=new ContextAgent({tools,brain:{respond:async()=>{calls++;return call('request_user_input',question,'q');}}});
 await assert.rejects(agent.run(state,'改这个',()=>{},undefined,{selectedAssetIds:['missing']}),{code:'asset_not_found'});assert.equal(calls,0);
 await agent.run(state,'提问');const id=interactions(state)[0].interactionId;
 await assert.rejects(agent.run(state,'伪造',()=>{},undefined,{interactionResponse:{interactionId:id,action:'submit',answers:{place:{optionId:'invented'}}}}),{code:'invalid_answer'});assert.equal(calls,1);
 const result=await tools.execute('request_user_input',{message:'配置',questions:[{key:'password',label:'输入密码',allowFreeText:true}]},{state,ownerId:state.ownerId});assert.equal(result.error.code,'sensitive_input');
 const cancel=await agent.run(state,'取消问题',()=>{},undefined,{interactionResponse:{interactionId:id,action:'cancel'}});assert.equal(cancel.status,'cancelled');assert.equal(calls,1);
});
test('free text answer is a new original user message, not a second tool result or media approval',async()=>{
 const state=createSession();let n=0;
 const agent=new ContextAgent({tools:createTools(),brain:{respond:async()=>n++?say('收到回答'):call('request_user_input',question,'q')}});
 await agent.run(state,'提问');const id=interactions(state)[0].interactionId;
 await agent.run(state,'用于社交信息流，中文');const user=state.records.filter(r=>r.kind==='message'&&r.role==='user').at(-1);
 assert.equal(user.interactionResponse.interactionId,id);assert.equal(user.interactionResponse.action,'text');assert.equal(state.records.filter(r=>r.kind==='tool_result').length,1);assert.equal(Object.keys(state.approvals).length,0);
});
test('even a model misrouting a form answer into confirm_media cannot approve generation',async()=>{
 const state=createSession(),tools=createTools();let n=0,proposalId;
 const agent=new ContextAgent({tools,maxMediaCalls:2,brain:{respond:async()=>{
  if(n++===0)return call('generate_image',{prompt:'白瓶',size:'1024x1024'},'p');
  if(n===2){proposalId=Object.values(state.approvals)[0].proposalId;return call('request_user_input',{message:'选择用途',questions:[{key:'place',label:'用途',allowFreeText:false,options:[{id:'social',label:'社交'}]}]},'q');}
  if(n===3)return call('confirm_media',{proposalIds:[proposalId]},'wrong-confirm');return say('选择用途不批准生成。');
 }}});
 await agent.run(state,'准备方案并确认用途');const id=interactions(state)[0].interactionId;
 await agent.run(state,'选择社交',()=>{},undefined,{interactionResponse:{interactionId:id,action:'submit',answers:{place:{optionId:'social'}}}});
 const feedback=JSON.parse(state.records.filter(r=>r.kind==='tool_result').at(-1).output);assert.equal(feedback.error.code,'confirmation_source_required');assert.equal(Object.keys(state.invocations).length,0);assert.ok(!Object.values(state.approvals).some(p=>p.kind==='approval'));
});
test('workspace consumes server validated selection and registered mode; cannot fabricate provider health',async()=>{
 const state=createSession();state.assets.photo={id:'photo',type:'image',version:3,ownerId:state.ownerId};let n=0;
 const agent=new ContextAgent({tools:createTools({mode:'live'}),brain:{respond:async input=>{if(!n++)return call('inspect_workspace',{},'inspect');const text=JSON.stringify(input);assert.match(text,/providerBalance/);assert.match(text,/unknown/);return say('实际媒体未注册，不能推断余额。');}}});
 await agent.run(state,'把选中图背景改蓝',()=>{},undefined,{selectedAssetIds:['photo']});
 const result=JSON.parse(state.records.find(r=>r.kind==='tool_result').output);assert.equal(result.selectedAssets[0].id,'photo');assert.equal(result.selectedAssets[0].version,3);assert.ok(!result.registeredTools.includes('generate_image'));assert.equal(result.mediaMode,'live');
});
test('real public start precedes slow tool completion and paged replay contains no model payload',async()=>{
 const state=createSession();let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);let n=0;const events=[];
 const tools={definitions:[{type:'function',name:'slow',parameters:{type:'object',properties:{}}}],execute:async()=>{started();await gate;return {ok:false,error:{code:'provider_unknown',message:'失败 Bearer very-secret-token-value'}};}};
 const agent=new ContextAgent({tools,brain:{respond:async()=>n++?say('失败已说明'):call('slow',{},'slow-id')}});
 const running=agent.run(state,'开始',e=>events.push(e));await ready;
 assert.ok(events.some(e=>e.kind==='activity'&&e.activityId==='slow-id'&&e.status==='running'));assert.ok(!events.some(e=>e.activityId==='slow-id'&&e.status==='failed'));release();await running;
 const completed=events.find(e=>e.activityId==='slow-id'&&e.status==='failed');assert.ok(completed.durationMs>=0);assert.ok(!completed.error.includes('very-secret'));
 const replay=[];let cursor=-1,page;do{page=publicEvents(state,cursor,2);replay.push(...page.events);cursor=page.cursor;}while(page.hasMore);
 assert.deepEqual(replay.map(e=>e.eventId),events.filter(e=>e.type==='public_event').map(e=>e.eventId));assert.ok(!JSON.stringify(replay).includes('model_request'));assert.ok(!JSON.stringify(replay).includes('parameters'));
});
test('HTTP recovery errors keep proper status; public events and client rendering ack do not create approval',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'public-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));let n=0;
 const app=createContextServer({directory:dir,modelEnabled:true,tools:createTools(),brain:{respond:async()=>n++?say('待批准'):call('generate_image',{prompt:'白瓶',size:'1024x1024'},'p')}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 const config=await(await fetch(base+'/api/config')).json();const post=(path,data)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-context-token':config.csrf},body:JSON.stringify(data)});
 assert.equal((await fetch(base+'/api/session/missing')).status,404);
 const session=await(await post('/api/session',{})).json();await(await post('/api/chat',{sessionId:session.id,message:'生图'})).text();
 let snapshot=await(await fetch(base+'/api/session/'+session.id)).json();const proposal=Object.values(snapshot.proposals).find(p=>p.kind==='proposal');assert.equal(proposal.published,true);assert.equal(proposal.clientRendered,false);assert.equal(snapshot.summaries,undefined);assert.equal(snapshot.invocations,undefined);
 await post('/api/proposals/rendered',{sessionId:session.id,proposalIds:[proposal.proposalId]});snapshot=await(await fetch(base+'/api/session/'+session.id)).json();assert.equal(snapshot.proposals[proposal.proposalId].clientRendered,true);assert.ok(!Object.values(snapshot.proposals).some(p=>p.kind==='approval'));
 const state=await app.store.load(session.id);assert.ok(!state.records.some(r=>r.event==='proposal_displayed'));assert.ok(state.records.some(r=>r.event==='proposal_published'));
});
