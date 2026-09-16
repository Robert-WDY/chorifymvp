import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeek,createBrain,brainConfig} from '../server/adapters.mjs';
import {Verifier} from '../server/verification.mjs';
const signal=()=>new AbortController().signal;
const output=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const config={key:'private-deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',reasoningEffort:'none'};

test('DeepSeek uses its Responses endpoint, explicit non-thinking JSON mode, and normalized history',async()=>{
  const brain=new DeepSeek(config,async(url,init)=>{
    assert.equal(url,'https://api.deepseek.com/responses');assert.equal(init.headers.Authorization,'Bearer private-deepseek');
    const body=JSON.parse(init.body);assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.reasoning,{effort:'none'});
    assert.deepEqual(body.text,{format:{type:'json_object'}});assert.equal(body.thinking,undefined);assert.equal(body.tools,undefined);
    assert.deepEqual(body.input[0],{role:'assistant',content:'previous'});
    return Response.json({id:'r1',model:'deepseek-flash',status:'completed',usage:{input_tokens:20,output_tokens:4},output:[{type:'reasoning',content:[]},output('{"ok":true}')]});
  });
  const result=await brain.respond([output('previous'),{role:'user',content:'Return JSON'}],[],signal(),{json:true});
  assert.equal(result.length,1);assert.equal(brain.lastCall.usage.input_tokens,20);assert.equal(brain.lastCall.requestId,'r1');
});

test('DeepSeek preserves both image inputs and refuses unsupported video before transport',async()=>{
  let calls=0;const parts=[{type:'input_text',text:'Compare images'},{type:'input_image',image_url:'https://test.invalid/a.png'},{type:'input_image',image_url:'https://test.invalid/b.png'}];
  const brain=new DeepSeek(config,async(url,init)=>{calls++;assert.deepEqual(JSON.parse(init.body).input[0].content,parts);return Response.json({output:[output('ok')]});});
  await brain.respond([{role:'user',content:parts}],[],signal());
  await assert.rejects(brain.respond([{role:'user',content:[{type:'input_video',video_url:'https://test.invalid/v.mp4'}]}],[],signal()),/不支持/);assert.equal(calls,1);
});

test('provider selection never falls back to the other provider key',()=>{
  const env={LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'deepseek-secret',DOUBAO_API_KEY:'ark-secret',DOUBAO_CHAT_MODEL:'ark-model'};
  assert.equal(createBrain(env).config.key,'deepseek-secret');assert.equal(brainConfig(env,'doubao').key,'ark-secret');
  assert.equal(brainConfig({...env,DEEPSEEK_API_KEY:undefined}).key,undefined);
  assert.equal(brainConfig(env).model,'deepseek-flash');assert.throws(()=>brainConfig(env,'unknown'),/LLM_PROVIDER/);
});

test('DeepSeek errors omit response payloads and incomplete output cannot pass',async()=>{
  const denied=new DeepSeek(config,async()=>Response.json({error:{message:'private-deepseek'}},{status:401}));
  await assert.rejects(denied.respond([],[],signal()),e=>e.message.includes('401')&&!e.message.includes('private-deepseek'));
  const truncated=new DeepSeek(config,async()=>Response.json({status:'incomplete',output:[output('{"passed":true}')]}));
  await assert.rejects(truncated.respond([],[],signal()),/未完整/);
});

test('video verification uses the configured video model; text and images remain on the primary model',async()=>{
  const primary=[],video=[];
  const respond=log=>async input=>{log.push(input);return[output(JSON.stringify({passed:true,uncertain:false,issues:[]}))];};
  const verifier=new Verifier({respond:respond(primary)},{videoBrain:{respond:respond(video)}});
  const item={operation:'generate_image',description:'coffee',constraints:[],spec:{}};
  await verifier.verifyPlan(item,'generate_image',[],{},signal());
  await verifier.verifyArtifact(item,{type:'image',url:'https://test.invalid/a.png',metadata:{}},{},signal());
  await verifier.verifyArtifact(item,{type:'video',url:'https://test.invalid/a.mp4',metadata:{}},{},signal());
  assert.equal(primary.length,2);assert.equal(video.length,1);assert.equal(video[0][1].content[1].type,'input_video');
});
