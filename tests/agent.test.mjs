import test from 'node:test';
import assert from 'node:assert/strict';
import {LegacyAgent as Agent} from './runtime-model-fixture.mjs';
import { loadCatalog, readSkill } from '../server/catalog.mjs';
import { ToolRuntime } from '../server/tools.mjs';
import { ArkMedia, ProviderError, publicMediaUrl } from '../server/media.mjs';
import { Doubao, fingerprint } from '../server/adapters.mjs';
import { runScript } from '../server/script-runner.mjs';
const catalog=await loadCatalog();
const signal=()=>new AbortController().signal;
const call=(name,args,id=Math.random().toString())=>({type:'function_call',name,arguments:JSON.stringify(args),call_id:id});
const plan=()=>call('update_plan',{summary:'完成需求',steps:[{title:'执行',status:'running'}]});
const answer=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
function fixture(outputs,options={}) {
 const mediaOutputs={generate_image:'image',edit_image:'image',generate_video:'video',generate_voiceover:'audio'};
 const requested=[...new Set(outputs.flat().filter(x=>x.type==='function_call'&&mediaOutputs[x.name]).map(x=>x.name))];
 const requests=[],events=[],calls=[];
 const brain={respond:async(input,tools,sig,required)=>{requests.push({input:structuredClone(input),tools,required});if(!outputs.length)throw new Error('unexpected model call');return outputs.shift();}};
 const media={config:{imageModel:'test',videoModel:'test'},image:async(args,sig)=>{calls.push(args);if(options.image)return options.image(args,sig);return {status:'succeeded',images:[{url:'https://example.com/image.png'}]};},video:async()=>({taskId:'v1',status:'queued'}),getVideo:async()=>({taskId:'v1',status:'succeeded',videoUrl:'https://example.com/video.mp4'})};
 const runtime=new ToolRuntime({catalog,brain,media,waitMs:10,pollMs:1});
 const state={id:'11111111-1111-4111-8111-111111111111'};
 // Fixtures now declare the actual requested deliverable, not impossible media operations with text output.
 const intake=async()=>({summary:'测试执行',mode:'create',tasks:(requested.length?requested:['answer']).map(operation=>({operation,output:mediaOutputs[operation]||'text',count:1,dependsOn:[],references:[],constraints:[]})),skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow',untrustedInstructions:false,reason:''}});
 const agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,maxSteps:options.maxSteps||16,intake});
 return {state,events,calls,requests,runtime,run:()=>agent.run(state,'执行创作',e=>events.push(e),options.signal||signal()),resume:()=>agent.run(state,'继续',e=>events.push(e),signal(),{resumeTaskId:state.taskStore.activeTaskId})};
}
test('all 15 skills can be loaded and used in the ReAct observation-answer loop',async t=>{
 assert.equal(catalog.skills.length,15);
 for(const skill of catalog.skills) await t.test(skill.slug,async()=>{
  const f=fixture([[plan()],[call('use_skill',{slug:skill.slug,task:'完成专业创作'})],[answer('专业创作正文')]]);
  await f.run();assert.equal(f.state.status,'completed');assert.equal(f.events.at(-1).text,'专业创作正文');
  assert.ok(f.requests[2].input.some(x=>x.type==='function_call_output'&&x.output.includes('content')));
  assert.ok(f.state.loadedSkills.includes(skill.slug));assert.ok(!f.requests[0].tools.some(t=>t.name==='generate_video'));
 });
});
test('skill references are readable and paths cannot escape the registered catalog',async()=>{
 const s=await readSkill(catalog,'creative-prompt-rewrite');assert.ok(s.references.length);
 assert.ok((await readSkill(catalog,s.slug,s.references[0])).content.length);
 await assert.rejects(()=>readSkill(catalog,'../../.env'));
 await assert.rejects(()=>readSkill(catalog,s.slug,'../../.env'));
});
test('discovery, reference tools, schema discovery, history and multimodal dispatch work independently',async()=>{
 const f=fixture([[answer('图片分析')],[answer('视频分析')]]);
 const execute=(name,args)=>f.runtime.execute(name,args,f.state,signal());
 assert.equal((await execute('list_capabilities',{})).tools.length,50);
 assert.equal((await execute('find_skill',{query:'提示词改写'})).skills.length,15);
 const s=await execute('read_skill',{slug:'creative-prompt-rewrite'});
 const ref=await execute('read_skill_reference',{slug:s.slug,reference:s.references[0]});assert.ok(ref.content.length);
 assert.ok((await execute('search_skill_reference',{slug:s.slug,query:'视频'})).matches.length);
 assert.ok((await execute('get_skill_script',{slug:'actor-realism-v2',name:'validate_prompt_preservation'})).inputSchema);
 f.state.messages=[{role:'user',content:'咖啡广告'}];assert.deepEqual((await execute('search_history',{query:'咖啡'})).matches,['咖啡广告']);
 assert.equal((await execute('analyze_image',{url:'https://example.com/image.png',question:'主体是什么'})).text,'图片分析');
 assert.equal(f.requests[0].input[1].content.find(p=>p.type==='input_image').image_url,'https://example.com/image.png');
 assert.equal((await execute('read_video',{url:'https://example.com/video.mp4',question:'分析镜头'})).text,'视频分析');
 assert.equal(f.requests[1].input[1].content.find(p=>p.type==='input_video').video_url,'https://example.com/video.mp4');
 await assert.rejects(()=>execute('get_video_task',{taskId:'not-owned'}),/本会话/);
});
function sample(schema,root=schema) {
 if(schema.$ref)return sample(schema.$ref.split('/').slice(1).reduce((p,k)=>p[k],root),root);
 if(schema.enum)return schema.enum[0];
 if(schema.default!==undefined)return schema.default;
 if(schema.type==='object')return Object.fromEntries((schema.required||[]).map(k=>[k,sample(schema.properties[k],root)]));
 if(schema.type==='array')return Array.from({length:schema.minItems||1},(_,i)=>{const v=sample(schema.items,root);return typeof v==='string'?v+i:v;});
 if(schema.type==='integer'||schema.type==='number')return schema.minimum??(schema.exclusiveMinimum!==undefined?schema.exclusiveMinimum+1:1);
 if(schema.type==='boolean')return false;
 return 'example';
}
test('all 12 installed scripts actually execute and validate output schemas',async t=>{
 let count=0;
 for(const skill of catalog.skills)for(const script of skill.scriptDefinitions){count++;await t.test(skill.slug+'/'+script.name,async()=>{
  const result=await runScript(catalog,skill.slug,script.name,sample(script.inputSchema),signal());assert.equal(typeof result.valid,'boolean');
 });}
 assert.equal(count,12);
});
test('script detects lost content and rejects malformed arguments / unregistered names',async()=>{
 const result=await runScript(catalog,'actor-realism-v2','validate_prompt_preservation',{originalText:'镜头1 5s --ar 16:9 咖啡',optimizedText:'咖啡',lockedLiterals:['镜头1']},signal());
 assert.equal(result.valid,false);assert.ok(result.missingLockedLiterals.includes('镜头1'));
 await assert.rejects(()=>runScript(catalog,'actor-realism-v2','validate_prompt_preservation',{},signal()),/参数错误/);
 await assert.rejects(()=>runScript(catalog,'actor-realism-v2','shell',{},signal()),/未登记/);
});
test('invalid tool and parameters feed errors back without executing side effects',async()=>{
 const f=fixture([[plan()],[call('generate_image',{prompt:42}),call('shell',{command:'bad'})],[answer('参数需要修正')]]);await f.run();assert.equal(f.calls.length,0);
 assert.equal(f.events.filter(x=>x.type==='tool_result'&&x.result.isError).length,2);
});
test('an explicitly new task can generate a new artifact even with identical parameters',async()=>{
 const f=fixture([[plan()],[call('generate_image',{prompt:'coffee'})],[answer('完成')],[plan()],[call('generate_image',{prompt:'coffee'})],[answer('复用')]]);
 await f.run();await f.run();assert.equal(f.calls.length,2);assert.equal(Object.keys(f.state.taskStore.tasks).length,2);
});
test('unknown submission blocks writes but does not block video status reads',async()=>{
 const f=fixture([[plan()],[call('generate_image',{prompt:'coffee'})],[call('generate_image',{prompt:'tea'}),call('get_video_task',{taskId:'v1'})],[answer('请查验')]],{image:()=>{throw new ProviderError('timeout',true);}});
 f.state.videoTasks={v1:{taskId:'v1',status:'running'}};await f.run();assert.equal(f.calls.length,1);assert.equal(f.state.status,'blocked');await f.runtime.execute('get_video_task',{taskId:'v1'},f.state,signal());assert.equal(f.state.videoTasks.v1.status,'succeeded');
});
test('known rejection does not permanently lock the session',async()=>{
 let attempt=0;
 const f=fixture([[plan()],[call('generate_image',{prompt:'coffee'})],[call('generate_image',{prompt:'tea'})],[answer('完成')]],{image:()=>{if(!attempt++)throw new ProviderError('invalid',false);return {status:'succeeded',images:[{url:'https://example.com/recovered.png'}]};}});
 await f.run();assert.equal(f.calls.length,2);assert.equal(f.state.status,'completed');
});
test('queued video cannot mark the run completed; status calls remain fresh',async()=>{
 const outputs=[[plan()],[call('generate_video',{prompt:'coffee'})]];const f=fixture(outputs);f.runtime.media.getVideo=async()=>({taskId:'v1',status:'running'});
 await f.run();assert.equal(f.state.status,'waiting');f.runtime.media.getVideo=async()=>({taskId:'v1',status:'succeeded',videoUrl:'https://example.com/video.mp4'});outputs.push([answer('已完成')]);await f.resume();assert.equal(f.state.status,'completed');
});
test('cancel closes all function calls and preserves uncertain media intent',async()=>{
 const c=new AbortController();const f=fixture([[plan()],[call('generate_image',{prompt:'coffee'}),call('generate_image',{prompt:'tea'})]],{signal:c.signal,image:()=>{c.abort();throw new ProviderError('aborted',true);}});
 await f.run();assert.equal(f.state.status,'cancelled');assert.equal(f.calls.length,1);
 const answered=new Set(f.state.messages.filter(x=>x.type==='function_call_output').map(x=>x.call_id));assert.ok(f.state.messages.filter(x=>x.type==='function_call').every(x=>answered.has(x.call_id)));
});
test('bounded loop returns limited, not success',async()=>{const f=fixture([[plan()],[plan()]],{maxSteps:2});await f.run();assert.equal(f.state.status,'limited');});
test('restart repairs unfinished function calls before model replay',async()=>{const f=fixture([[plan()],[answer('恢复')]]);f.state.messages=[call('read_skill',{slug:'creative-prompt-rewrite'},'old')];await f.run();assert.ok(f.requests[0].input.some(x=>x.call_id==='old'&&x.type==='function_call_output'));});
test('Ark image and video call official API paths, serialize references and query actual output',async()=>{
 const requests=[];const media=new ArkMedia({key:'private',baseUrl:'https://ark.cn-beijing.volces.com',imageModel:'image',videoModel:'video'},async(url,init)=>{
  requests.push({url,init,body:init.body?JSON.parse(init.body):null});
  if(url.endsWith('/images/generations'))return Response.json({data:[{url:'https://example.com/image.png'}]});
  if(init.method==='GET')return Response.json({status:'succeeded',content:{video_url:'https://example.com/video.mp4'}});
  return Response.json({id:'v1'});
 });
 assert.equal((await media.image({prompt:'coffee',referenceImages:['https://example.com/ref.png']},signal())).status,'succeeded');
 assert.equal((await media.video({prompt:'coffee',firstFrameUrl:'https://example.com/ref.png'},signal())).taskId,'v1');
 assert.equal((await media.getVideo('v1',signal())).videoUrl,'https://example.com/video.mp4');
 assert.ok(requests[0].url.endsWith('/api/v3/images/generations'));assert.deepEqual(requests[0].body.image,['https://example.com/ref.png']);
 assert.equal(requests[1].body.content[1].role,'first_frame');assert.equal(requests[2].init.method,'GET');
});
test('media error semantics distinguish rejected and ambiguous submissions',async()=>{
 const config={key:'x',baseUrl:'https://example.com',imageModel:'x'};
 await assert.rejects(()=>new ArkMedia(config,async()=>{throw new Error('network');}).image({prompt:'x'},signal()),e=>e.uncertain===true);
 await assert.rejects(()=>new ArkMedia(config,async()=>Response.json({error:{code:'AccountOverdueError'}},{status:403})).image({prompt:'x'},signal()),e=>e.uncertain===false);
 assert.throws(()=>publicMediaUrl('http://localhost/'));assert.throws(()=>publicMediaUrl('https://127.0.0.1/x'));
});
test('native function calling payload replays observations and never exposes reasoning',async()=>{
 let body;
 const brain=new Doubao({key:'private',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'test'},async(url,init)=>{body=JSON.parse(init.body);return Response.json({output:[{type:'reasoning',text:'private'},plan()]});});
 const result=await brain.respond([{type:'function_call_output',call_id:'a',output:'ok'}],[],signal());
 assert.equal(body.input[0].call_id,'a');assert.equal(result.length,1);
});
test('brain exposes all tools with automatic selection to avoid forced-tool empty responses',async()=>{
 let body;const brain=new Doubao({key:'private',baseUrl:'https://example.com',model:'test'},async(url,init)=>{body=JSON.parse(init.body);return Response.json({output:[plan()]});});
 await brain.respond([{role:'user',content:'生成视频'}],[{type:'function',name:'update_plan',parameters:{type:'object'}},{type:'function',name:'generate_video',parameters:{type:'object'}}],signal());
 assert.equal(body.tool_choice,'auto');assert.equal(body.tools.length,2);
});
test('ordinary answer is delivered even when no tools are needed',async()=>{
 const f=fixture([[answer('你好，我可以帮助你创作。')]]);await f.run();assert.equal(f.state.status,'completed');assert.ok(f.events.at(-1).text.includes('你好'));
});
test('goal recognition and clarification are allowed before paid-action planning',async()=>{
 const f=fixture([[call('read_task_state',{})],[call('request_skill_confirmation',{question:'请提供视频和音频 HTTPS 地址。'})],[answer('请提供视频和音频 HTTPS 地址。')]]);
 await f.run();assert.equal(f.state.status,'needs_input');assert.equal(f.events.filter(e=>e.result?.isError).length,0);assert.equal(f.calls.length,0);
});
test('assistant history is normalized to compatible input text for follow-up queries',async()=>{
 let payload;const brain=new Doubao({key:'test',baseUrl:'https://example.com',model:'test'},async(url,options)=>{payload=JSON.parse(options.body);return Response.json({output:[answer('夜晚咖啡')]});});
 await brain.respond([answer('清晨咖啡'),{role:'user',content:'改成夜晚'}],[],signal());
 assert.deepEqual(payload.input[0],{role:'assistant',content:'清晨咖啡'});
});
test('failed video task is not labeled completed',async()=>{
 const f=fixture([[plan()],[call('generate_video',{prompt:'coffee'})],[call('get_video_task',{taskId:'v1'})],[answer('视频处理失败')]]);
 f.runtime.media.getVideo=async()=>({taskId:'v1',status:'failed',isError:true});await f.run();assert.equal(f.state.status,'failed');
});
test('provider account error gives actionable feedback without raw payload',async()=>{
 const brain=new Doubao({key:'private',baseUrl:'https://example.com',model:'test'},async()=>Response.json({error:{code:'AccountOverdueError',message:'sensitive'}},{status:403}));
 await assert.rejects(()=>brain.respond([],[],signal()),/账户欠费/);
 assert.equal(fingerprint('x',{a:1,b:2}),fingerprint('x',{b:2,a:1}));
});
