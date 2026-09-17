import test from 'node:test';
import assert from 'node:assert/strict';
import {readResponseStream} from '../server/response-stream.mjs';
import {DeepSeek,Doubao} from '../server/adapters.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {createSession} from '../server/context-agent/history.mjs';
const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const frame=value=>'data: '+JSON.stringify(value)+'\r\n\r\n';
function response(events){const bytes=new TextEncoder().encode(events.map(frame).join(''));let offset=0;return new Response(new ReadableStream({pull(c){if(offset>=bytes.length){c.close();return;}c.enqueue(bytes.slice(offset,offset+=3));}}),{headers:{'content-type':'text/event-stream'}});}
test('SSE decoder survives byte fragmentation, exposes only public text and waits for full completed output',async()=>{
 const output=[{type:'function_call',name:'read_asset',call_id:'c',arguments:'{"id":"x"}'}],texts=[];
 const result=await readResponseStream(response([{type:'response.reasoning_text.delta',delta:'PRIVATE_REASONING'},{type:'response.function_call_arguments.delta',delta:'{"id":'},{type:'response.output_text.delta',delta:'读取资料。'},{type:'response.completed',response:{status:'completed',output}}]),{onTextDelta:t=>texts.push(t)});
 assert.deepEqual(texts,['读取资料。']);assert.deepEqual(result.output,output);
});
test('truncated argument stream cannot execute a tool; partial text is marked incomplete',async()=>{
 const brain=new DeepSeek({key:'offline',model:'offline',baseUrl:'https://fixture.test',supportsTextStreaming:true},async()=>response([{type:'response.output_text.delta',delta:'我会读取资料'},{type:'response.function_call_arguments.delta',delta:'{"id":'}]));
 const state=createSession(),events=[];let executed=0;const base=createTools(),tools={...base,execute:async(...a)=>{executed++;return base.execute(...a);}};
 const result=await new ContextAgent({brain,tools}).run(state,'读取资料',e=>events.push(e));assert.equal(result.status,'error');assert.equal(executed,0);assert.ok(events.some(e=>e.kind==='text_delta'));assert.ok(events.some(e=>e.kind==='text_incomplete'));assert.equal(state.records.filter(r=>r.kind==='tool_call').length,0);
});
test('both adapters require declared streaming capability and callback; JSON summaries remain nonstreaming',async()=>{
 for(const Adapter of [DeepSeek,Doubao])for(const supported of [false,true])for(const json of [false,true]){
  let wire;const config={key:'offline',model:'offline',baseUrl:'https://fixture.test',supportsTextStreaming:supported};
  const adapter=new Adapter(config,async(_url,options)=>{wire=JSON.parse(options.body);return wire.stream?response([{type:'response.output_text.delta',delta:'公开文本'},{type:'response.completed',response:{status:'completed',output:say('公开文本')}}]):new Response(JSON.stringify({output:say('公开文本')}));});
  const seen=[];const output=await adapter.respond([{role:'user',content:'回答'}],[],new AbortController().signal,{json,onTextDelta:t=>seen.push(t)});
  assert.equal(wire.stream,supported&&!json);assert.equal(output[0].content[0].text,'公开文本');assert.equal(seen.length,supported&&!json?1:0);
 }
});
test('failed/incomplete and wrong content-type streams fail closed',async()=>{
 for(const type of ['response.failed','response.incomplete','error'])await assert.rejects(readResponseStream(response([{type}])));
 await assert.rejects(readResponseStream(new Response('{}',{headers:{'content-type':'application/json'}})));
});
test('stream previews settle when completed response lacks text; invalid output is not a successful model activity',async()=>{
 for(const invalid of [false,true]){
  const state=createSession(),events=[];let requests=0,executed=0;
  const brain={async respond(_input,_tools,_signal,options){
   if(++requests>1)return say('结束');
   await options.onTextDelta('正在读取');
   return [{type:'function_call',name:'list_assets',call_id:'read',arguments:'{}',...(invalid?{status:'incomplete'}:{})}];
  }};
  const base=createTools(),tools={...base,async execute(...args){executed++;return base.execute(...args);}};
  const result=await new ContextAgent({brain,tools}).run(state,'读取素材',e=>events.push(e));
  assert.equal(result.status,invalid?'error':'completed');assert.equal(executed,invalid?0:1);
  assert.ok(events.some(e=>e.kind==='text_incomplete'));
  const firstActivity=events.find(e=>e.kind==='activity'&&e.category==='model');
  assert.equal(events.filter(e=>e.activityId===firstActivity.activityId).at(-1).status,invalid?'failed':'succeeded');
 }
});
