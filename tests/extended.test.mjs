import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ExtendedMedia } from '../server/extended-media.mjs';
import { refreshTasks } from '../server/task-monitor.mjs';
import { rememberAssets,rememberUserAssets } from '../server/assets.mjs';
const signal=()=>new AbortController().signal;
const env={MEDIA_SERVICE_URL:'https://media.example.com',MEDIA_SERVICE_KEY:'secret',REPLICATION_URL:'https://replicate.example.com',REPLICATION_KEY:'replicate-secret',UPSCALE_URL:'https://upscale.example.com',UPSCALE_KEY:'upscale-secret',UPSCALE_APP_ID:'app1',UPSCALE_VIDEO_NODE:'11',UPSCALE_SIZE_NODE:'12',TRANSCODE_URL:'https://transcode.example.com/api',TRANSCODE_KEY:'transcode-secret',VIDEO_ANALYSIS_URL:'https://analyze.example.com',VIDEO_ANALYSIS_TOKEN:'token',VIDEO_ANALYSIS_KEY:'key',TTS_URL:'https://speech.example.com/tts',TTS_APP_ID:'app',TTS_ACCESS_KEY:'access',TTS_RESOURCE_ID:'resource',TTS_DEFAULT_VOICE:'test-voice'};
env.UPSCALE_INSTANCE_TYPE='default';
test('independent provider protocols submit, authenticate and query actual normalized results',async()=>{
 const requests=[];let reply={job_id:'job-1'};
 const provider=new ExtendedMedia(env,{fetchImpl:async(url,options)=>{requests.push({url:String(url),...options,body:options.body&&JSON.parse(options.body)});return Response.json(reply);}});
 const cases=[['propose_lipsync',{audioUrl:'https://example.com/a.mp3',videoUrl:'https://example.com/v.mp4'},'/v1/lipsync/jobs','audio_url'],['slice_video',{videoUrl:'https://example.com/v.mp4'},'/v1/video-scenes/jobs','source_uri'],['propose_video_replication',{videoUrl:'https://example.com/v.mp4',productImageUrl:'https://example.com/p.png',productName:'咖啡',prompt:'广告'},'/api/v1/adapt','product_url'],['propose_video_upscale',{videoUrl:'https://example.com/v.mp4'},'/openapi/v2/run/ai-app/app1','nodeInfoList']];
 for(const [name,args,path,field] of cases){
  reply=name==='propose_video_upscale'?{taskId:'up-1'}:{job_id:'job-1'};
  const task=await provider.submit(name,args,signal());assert.equal(task.status,'queued');assert.ok(requests.at(-1).url.endsWith(path));assert.ok(requests.at(-1).body[field]);
  if(name==='propose_video_replication')assert.equal(requests.at(-1).headers['X-API-Key'],'replicate-secret');
  reply=name==='slice_video'?{status:'succeeded',scenes:[{index:0,start_seconds:0,end_seconds:2,duration_seconds:2,video_url:'https://example.com/scene.mp4'}]}:name==='propose_video_upscale'?{status:'SUCCESS',results:[{url:'https://example.com/out.mp4'}]}:{state:'completed',result_url:'https://example.com/out.mp4'};
  const result=await provider.query(task,signal());assert.equal(result.status,'succeeded');assert.ok(result.videoUrl||result.scenes[0].videoUrl);
  reply={status:'completed'};await assert.rejects(()=>provider.query(task,signal()),/没有|未返回/);
  reply={status:'unexpected'};await assert.rejects(()=>provider.query(task,signal()),/无法识别/);
 }
 reply={video_url:'https://example.com/merged.mp4'};
 const merged=await provider.submit('merge_videos',{urls:['https://example.com/1.mp4','https://example.com/2.mp4']},signal());
 assert.equal(merged.status,'succeeded');assert.equal(requests.at(-1).url,'https://transcode.example.com/capabilities/v1/media/transcode');assert.deepEqual(requests.at(-1).body.source_uris,['https://example.com/1.mp4','https://example.com/2.mp4']);
 reply={ok:true,result:{status:'completed',sections:{first_three_seconds:{text:'开场'}}}};
 assert.equal((await provider.submit('analyze_video',{videoUrl:'https://example.com/video.mp4'},signal())).sections.first_three_seconds.text,'开场');
 assert.equal(requests.at(-1).headers['x-api-key'],'key');
});
test('audio streaming combines chunks, stores playable files, rejects partial failure and non-WAV clone',async()=>{
 const directory=await mkdtemp(tmpdir()+'/creative-audio-');const outputDir=pathToFileURL(directory+'/');let body='';const requests=[];
 const provider=new ExtendedMedia(env,{outputDir,fetchImpl:async(url,options)=>{requests.push(options);return new Response(body);}});
 try {
  body=JSON.stringify({code:0,data:Buffer.from('ID3test-audio').toString('base64')})+'\n'+JSON.stringify({code:20000000,message:'OK'});
  const audio=await provider.submit('generate_voiceover',{text:'你好'},signal());assert.equal(audio.status,'succeeded');assert.equal((await readFile(new URL(audio.audioUrl.split('/').at(-1),outputDir))).toString(),'ID3test-audio');
  assert.equal(requests.at(-1).headers['X-Api-Resource-Id'],'resource');
  body+='\n'+JSON.stringify({code:123,message:'failed'});await assert.rejects(()=>provider.submit('generate_voiceover',{text:'你好'},signal()),/不完整/);
  body='not a wav';await assert.rejects(()=>provider.submit('clone_voice',{text:'你好',referenceAudioUrl:'https://example.com/a.wav'},signal()),/WAV/);
  body=Buffer.from('RIFF1234WAVEaudio');assert.equal((await provider.submit('clone_voice',{text:'你好',referenceAudioUrl:'https://example.com/a.wav'},signal())).status,'succeeded');
 } finally {await rm(directory,{recursive:true,force:true});}
});
test('configuration failures are known non-submissions; ambiguous transport is not retried',async()=>{
 let requests=0;const provider=new ExtendedMedia({}, {fetchImpl:async()=>{requests++;throw Error('secret');}});
 await assert.rejects(()=>provider.submit('slice_video',{videoUrl:'https://example.com/v.mp4'},signal()),e=>e.uncertain===false&&e.message.includes('MEDIA_SERVICE_URL'));assert.equal(requests,0);
 provider.env=env;
 await assert.rejects(()=>provider.submit('slice_video',{videoUrl:'http://127.0.0.1/v.mp4'},signal()),e=>e.uncertain===false);assert.equal(requests,0);
 await assert.rejects(()=>provider.submit('slice_video',{videoUrl:'https://example.com/v.mp4'},signal()),e=>e.uncertain===true&&!e.message.includes('secret'));assert.equal(requests,1);
 assert.ok(!JSON.stringify(provider.capabilities()).includes('secret'));
});
test('background polling returns results and restores native tool history without new user messages or resubmission',async()=>{
 const state={status:'waiting',messages:[],events:[],videoTasks:{v1:{taskId:'v1',status:'queued'}}};let called=0;
 const runtime={execute:async(name,args,state)=>{called++;assert.equal(name,'get_video_task');const result={taskId:'v1',status:'succeeded',videoUrl:'https://example.com/done.mp4'};state.videoTasks.v1=result;return result;}};
 assert.equal(await refreshTasks(state,runtime,signal()),true);assert.equal(state.status,'completed');assert.equal(state.assets[0].kind,'video');assert.equal(state.messages.filter(x=>x.role==='user').length,0);
 assert.equal(state.messages[0].call_id,state.messages[1].call_id);await refreshTasks(state,runtime,signal());assert.equal(called,1);
});
test('follow-up asset references retain real URLs, distinguish types and deduplicate results',()=>{
 const state={};rememberUserAssets(state,'图 https://example.com/a.png 视频 https://example.com/v.mp4，音频 https://example.com/a.mp3');assert.deepEqual(state.assets.map(a=>a.kind),['image','video','audio']);
 rememberAssets(state,{images:[{url:'https://example.com/a.png'}]},'generate_image');assert.equal(state.assets.length,3);
});
