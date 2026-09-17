import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
import {createContextServer} from '../server/context-agent/http.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {debugJourney} from '../server/context-agent/debug-journey.mjs';

const say=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const call=(id,args)=>({type:'function_call',call_id:id,name:'read_asset',arguments:JSON.stringify(args)});
test('HTTP journey demonstrates failed lookup, feedback delivery, new decision and later answer',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'debug-journey-'));let calls=0;
 const app=createContextServer({directory,tools:createTools(),modelEnabled:true,agentOptions:{memory:{enabled:false}},brain:{respond:async()=>{calls++;return calls===1?[call('bad',{id:'missing'})]:calls===2?[call('good',{id:'original'})]:[say('已根据原稿继续。')];}}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{
  const state=await app.store.create();state.assets.original={id:'original',type:'text',title:'产品原稿',version:1,content:'价格18元。',ownerId:'local'};await app.store.save(state);
  const config=await(await fetch(base+'/api/config')).json(),headers={'Content-Type':'application/json','x-context-token':config.csrf};
  await(await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({sessionId:state.id,message:'请先读产品原稿',requestId:'journey'})})).text();
  const saved=await app.store.load(state.id),before=JSON.stringify(saved),turn=saved.records.find(r=>r.event==='start').turnId;
  const response=await fetch(base+'/api/debug/'+state.id+'/turn/'+turn);assert.equal(response.status,200);const journey=await response.json();
  assert.equal(journey.decisions,3);const failure=journey.issues.find(i=>i.callId==='bad');assert.ok(failure);assert.equal(failure.feedbackDelivered,true);
  const next=journey.nodes.find(n=>n.id===failure.nextId);assert.equal(next.choices[0].arguments.id,'original');assert.ok(next.incomingProblems[0].delivered);
  assert.ok(journey.nodes.some(n=>n.module==='answer'&&n.text==='已根据原稿继续。'));assert.equal(journey.modules.find(m=>m.key==='execution').status,'succeeded');assert.equal(journey.modules.find(m=>m.key==='context').status,'ready');
  assert.ok(journey.nodes.some(n=>n.tool==='read_asset'&&n.status==='succeeded'));assert.equal(JSON.stringify(await app.store.load(state.id)),before);assert.equal(calls,3);
  assert.equal((await fetch(base+'/api/debug/'+state.id+'/turn/absent')).status,400);assert.equal((await fetch(base+'/api/debug/'+state.id+'/turn/'+turn,{headers:{Origin:'http://foreign.invalid'}})).status,403);
 }finally{await new Promise(r=>app.server.close(r));await rm(directory,{recursive:true,force:true});}
});

test('later request mentioning a call ID does not prove failed feedback was delivered',async()=>{
 const s=createSession();const add=r=>appendRecord(s,{turnId:'t',...r});
 add({kind:'tool_call',callId:'c',name:'read_asset',arguments:'{"id":"missing"}'});
 add({kind:'tool_result',callId:'c',output:'{"ok":false,"error":{"message":"missing"}}'});
 add({kind:'run_event',event:'model_request',traceId:'a',phase:'agent',input:[{role:'user',content:'c'}],tools:[]});
 const j=await debugJourney(s,'t',()=>{});const p=j.issues.find(i=>i.callId==='c');assert.equal(p.feedbackDelivered,false);assert.match(p.followUp,/未找到/);assert.ok(j.issues.some(i=>i.title==='模型请求没有返回记录'));
});

test('summary attempt displays actual coverage and persistence, never hash as the explanation',async()=>{
 const s=createSession();appendRecord(s,{kind:'message',role:'user',content:'原价18元',turnId:'old'});appendRecord(s,{kind:'message',role:'assistant',content:'已记录',turnId:'old'});
 const attempt=appendRecord(s,{kind:'run_event',event:'summary_attempt',turnId:'now',sourceHash:'0123456789abcdef0123456789abcdef',coveredFromSeq:0,coveredToSeq:1});
 let j=await debugJourney(s,'now',()=>{});assert.equal(j.nodes[0].status,'unanswered');assert.match(j.nodes[0].summary,/2 条记录/);assert.doesNotMatch(j.nodes[0].summary,/sourceHash|012345/);
 s.summaries={saved:{sourceHash:attempt.sourceHash,coveredToSeq:1,summaryText:'用户提供原价18元。'}};
 j=await debugJourney(s,'now',()=>{});assert.equal(j.nodes[0].status,'succeeded');assert.equal(j.nodes[0].savedSummary,'用户提供原价18元。');assert.match(j.nodes[0].coverage[0].label,/用户原话.*18元/);
});

test('omission and repeated calls are review signals, not automatic semantic failures',async()=>{
 const s=createSession();const add=r=>appendRecord(s,{turnId:'t',...r});
 add({kind:'run_event',event:'model_request',phase:'agent',traceId:'a',input:[],tools:[],metrics:{retainedRecords:3,omittedRecords:5}});
 for(const id of ['one','two']){add({kind:'tool_call',callId:id,name:'read_asset',arguments:'{"id":"a"}'});add({kind:'tool_result',callId:id,output:'{"ok":true}'});}
 const j=await debugJourney(s,'t',()=>{});const signals=j.issues.filter(i=>i.severity==='signal');assert.equal(signals.length,2);assert.ok(signals.every(p=>/核查|检查/.test(p.description)));assert.ok(!j.issues.some(p=>/已修复|理解正确/.test(p.description)));
});

test('redesigned page leads with problems and module transitions; IDs stay in collapsed evidence',async()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.classList={toggle(){}};this.value='all';}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}set innerHTML(v){throw Error('HTML not allowed');}}
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);};
 const uuid='fae68b6a-71d7-48ab-9215-5987b126801a';
 const data={title:'会话记忆整理',record:{id:uuid,event:'summary_attempt',sourceHash:'0123456789abcdef0123456789abcdef'},labels:{[uuid]:'较早会话的记忆整理'}};
 const sandbox=vm.createContext({document:{getElementById:get,createElement:t=>new Element(t)},location:{search:''},localStorage:{getItem:()=>null},URLSearchParams,history:{replaceState(){}},setInterval(){},fetch:async()=>({ok:true,json:async()=>data})});
 const source=await readFile(new URL('../server/context-agent/web/debug.js',import.meta.url),'utf8');vm.runInContext(source.slice(0,source.indexOf('await sessions().catch')),sandbox);
 sandbox.fixture={turnId:'t',query:'把原价改为20元',labels:data.labels,decisions:2,issues:[{nodeId:uuid,title:'摘要整理失败',description:'旧资料未能整理',severity:'error'}],modules:[{key:'context',title:'上下文与记忆',status:'failed',nodeId:uuid,summary:'摘要整理失败'}],nodes:[{id:uuid,module:'context',title:'会话记忆整理',status:'failed',summary:'整理较早的16条记录，失败后未推进覆盖。',coverage:[{label:'第1轮用户原话：价格18元'}]}]};
 vm.runInContext("session='s';turnId='t';snapshot={turns:[{id:'t',status:'completed',tools:[]}]};journey=fixture;currentLabels=fixture.labels;renderJourney();",sandbox);
 await vm.runInContext('detail(fixture.nodes[0].id)',sandbox);
 const text=n=>n.className==='evidence'?'':(n.textContent||'')+n.children.map(text).join(' ');
 const visible=['problems','modules','timeline','detail'].map(id=>text(get(id))).join('\n');assert.match(visible,/摘要整理失败/);assert.match(visible,/上下文与记忆/);assert.match(visible,/第1轮用户原话/);assert.doesNotMatch(visible,/fae68b6a|sourceHash|0123456789abcdef/);
 const raw=get('detail').children.find(n=>n.className==='evidence');assert.ok(raw);assert.notEqual(raw.open,true);
  data.blocks=[];data.tools=[];data.response={output:[{type:'message',content:'字符串格式的公开回复'}]};await vm.runInContext('detail(fixture.nodes[0].id)',sandbox);assert.match(text(get('detail')),/字符串格式的公开回复/);
});
