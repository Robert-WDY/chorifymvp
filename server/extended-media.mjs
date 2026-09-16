import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { ProviderError, publicMediaUrl } from './media.mjs';

const requirements = {
  generate_voiceover: ['TTS_URL','TTS_APP_ID','TTS_ACCESS_KEY','TTS_RESOURCE_ID'],
  clone_voice: ['MEDIA_SERVICE_URL','MEDIA_SERVICE_KEY'],
  propose_lipsync: ['MEDIA_SERVICE_URL','MEDIA_SERVICE_KEY'],
  slice_video: ['MEDIA_SERVICE_URL','MEDIA_SERVICE_KEY'],
  propose_video_replication: ['REPLICATION_URL','REPLICATION_KEY'],
  propose_video_upscale: ['UPSCALE_URL','UPSCALE_KEY','UPSCALE_APP_ID','UPSCALE_VIDEO_NODE','UPSCALE_SIZE_NODE','UPSCALE_INSTANCE_TYPE'],
  merge_videos: ['TRANSCODE_URL','TRANSCODE_KEY'],
  analyze_video: ['VIDEO_ANALYSIS_URL','VIDEO_ANALYSIS_TOKEN','VIDEO_ANALYSIS_KEY'],
};
export const extendedMediaNames = Object.keys(requirements);
export class ExtendedMedia {
  constructor(env = process.env, { fetchImpl = fetch, outputDir = new URL('../data/media/',import.meta.url) } = {}) {
    Object.assign(this,{env,fetchImpl,outputDir});
  }
  capabilities() {
    return Object.fromEntries(Object.entries(requirements).map(([name,keys]) => [name,{
      configured:keys.every(k=>!!this.env[k]), missing:keys.filter(k=>!this.env[k])
    }]));
  }
  require(name) {
    const capability=this.capabilities()[name];
    if(!capability?.configured) throw new ProviderError(`服务未配置：${capability?.missing.join(', ') || name}`,false);
  }
  async request(base,path,key,body,signal,{headers={},binary=false,timeout=120000}={}) {
    let url;
    try { url=new URL(base.replace(/\/+$/,'')+path); if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw 0; }
    catch { throw new ProviderError('服务地址配置无效',false); }
    let response;
    try {
      response=await this.fetchImpl(url,{method:body===undefined?'GET':'POST',redirect:'error',
        headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`} : {}),...headers},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeout)])});
    } catch { throw new ProviderError('服务连接中断或超时；提交结果未知，请勿重复提交',body!==undefined); }
    if(!response.ok) throw new ProviderError(`服务返回 HTTP ${response.status}`,body!==undefined&&response.status>=500);
    try {
      const chunks=[];let size=0;
      for await (const chunk of response.body) { size+=chunk.length; if(size>32*1024*1024) throw 0; chunks.push(chunk); }
      const bytes=Buffer.concat(chunks);
      return binary?bytes:JSON.parse(bytes.toString('utf8'));
    } catch { throw new ProviderError('服务响应不完整或格式无效',body!==undefined); }
  }
  async storeAudio(bytes,ext) {
    if(!bytes.length) throw new ProviderError('服务没有返回音频',true);
    await mkdir(this.outputDir,{recursive:true});
    const filename=`${randomUUID()}.${ext}`;
    await writeFile(new URL(filename,this.outputDir),bytes,{mode:0o600});
    return {status:'succeeded',audioUrl:`/media/${filename}`,note:'本地音频可播放下载；继续用于远端口型服务需提供可公开读取的 HTTPS 音频地址。'};
  }
  async submit(name,args,signal) {
    this.require(name);
    // Validation is before submission so missing inputs never poison the durable action ledger.
    try { for(const key of ['videoUrl','audioUrl','referenceAudioUrl','productImageUrl']) if(args[key]) publicMediaUrl(args[key]);
      for(const url of args.urls||[]) publicMediaUrl(url);
    } catch { throw new ProviderError('素材必须是有效的公网 HTTPS URL',false); }
    const e=this.env,request=this.request.bind(this);let raw;
    if(name==='generate_voiceover') {
      const voice=args.voiceId||e.TTS_DEFAULT_VOICE;
      if(!voice) throw new ProviderError('请提供 voiceId 或配置 TTS_DEFAULT_VOICE',false);
      const bytes=await request(e.TTS_URL,'',null,{user:{uid:'creative-agent'},req_params:{text:args.text,speaker:voice,audio_params:{format:'mp3',sample_rate:24000,enable_timestamp:true}}},signal,
        {binary:true,headers:{'X-Api-App-Id':e.TTS_APP_ID,'X-Api-Access-Key':e.TTS_ACCESS_KEY,'X-Api-Resource-Id':e.TTS_RESOURCE_ID}});
      const chunks=[];
      try { for(const line of bytes.toString('utf8').split('\n').filter(s=>s.trim())) {
        const row=JSON.parse(line); if(row.code!=null&&![0,20000000].includes(row.code)) throw 0;
        if(row.data) { if(typeof row.data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(row.data)) throw 0; chunks.push(Buffer.from(row.data,'base64')); }
      }} catch { throw new ProviderError('配音服务返回错误或音频不完整',true); }
      const audio=Buffer.concat(chunks);
      if(audio.subarray(0,3).toString()!=='ID3'&&!(audio[0]===255&&(audio[1]&224)===224))throw new ProviderError('配音服务没有返回有效 MP3',true);
      return this.storeAudio(audio,'mp3');
    }
    if(name==='clone_voice') {
      const bytes=await request(e.MEDIA_SERVICE_URL,'/v2/tts/speech',e.MEDIA_SERVICE_KEY,
        {text:args.text,language:'auto',voice_profile_id:'default',reference_audio_url:args.referenceAudioUrl,prompt_text:''},signal,{binary:true});
      if(bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WAVE') throw new ProviderError('克隆服务没有返回有效 WAV',true);
      return this.storeAudio(bytes,'wav');
    }
    if(name==='merge_videos') {
      raw=await request(e.TRANSCODE_URL.replace(/\/api\/?$/,''),'/capabilities/v1/media/transcode',e.TRANSCODE_KEY,{source_uris:args.urls,filename:'merged.mp4'},signal,{timeout:300000});
      try {return {status:'succeeded',videoUrl:publicMediaUrl(raw.video_url)};}
      catch {throw new ProviderError('合并服务没有返回有效成品地址，不能安全重提',true);}
    }
    if(name==='analyze_video') {
      raw=await request(e.VIDEO_ANALYSIS_URL,'/tiktok-ad-assistant/api/doubao-analysis',e.VIDEO_ANALYSIS_TOKEN,{scope:'urls',videoUrls:[args.videoUrl],workers:2},signal,{timeout:600000,headers:{'x-api-key':e.VIDEO_ANALYSIS_KEY}});
      const result=raw.result||raw.results?.[0];const sections=result?.sections||raw.sections||result?.analysis;
      if(raw.ok!==true||!sections||!Object.keys(sections).length||!(result?.status==='completed'||raw.statuses?.some(x=>x.status==='completed'))) throw new ProviderError('视频分析没有返回已完成的内容',true);
      return {status:'succeeded',sections};
    }
    if(name==='propose_lipsync') raw=await request(e.MEDIA_SERVICE_URL,'/v1/lipsync/jobs',e.MEDIA_SERVICE_KEY,{audio_url:args.audioUrl,video_url:args.videoUrl,face_restore:args.faceRestore??false},signal);
    if(name==='slice_video') raw=await request(e.MEDIA_SERVICE_URL,'/v1/video-scenes/jobs',e.MEDIA_SERVICE_KEY,{external_ref:randomUUID(),filename:'video.mp4',metadata:{},source_uri:args.videoUrl,min_scene_len:args.minSceneLen??25,threshold:args.threshold??25},signal);
    if(name==='propose_video_replication') raw=await request(e.REPLICATION_URL,'/api/v1/adapt',null,{video_url:args.videoUrl,product_url:args.productImageUrl,product_name:args.productName,prompt:args.prompt,ratio:args.ratio||'9:16',recast_mode:1,resolution:'720p',ocr_mode:'relaxed',max_video_retries:3},signal,{headers:{'X-API-Key':e.REPLICATION_KEY}});
    if(name==='propose_video_upscale') raw=await request(e.UPSCALE_URL,`/openapi/v2/run/ai-app/${encodeURIComponent(e.UPSCALE_APP_ID)}`,e.UPSCALE_KEY,{nodeInfoList:[{nodeId:e.UPSCALE_VIDEO_NODE,fieldName:'video',fieldValue:args.videoUrl},{nodeId:e.UPSCALE_SIZE_NODE,fieldName:'value',fieldValue:String(args.shortSide||1088)}],instanceType:e.UPSCALE_INSTANCE_TYPE||'default',usePersonalQueue:e.UPSCALE_PERSONAL_QUEUE||'false'},signal);
    const jobId=raw?.job_id||raw?.taskId;
    if(typeof jobId!=='string'||!jobId) throw new ProviderError('提交结果没有可查询的任务编号',true);
    return {taskId:`${name}:${jobId}`,jobId,kind:name,status:'queued'};
  }
  async query(task,signal) {
    this.require(task.kind);const e=this.env;const id=encodeURIComponent(task.jobId);let raw,base;
    if(task.kind==='propose_video_replication') { base=e.REPLICATION_URL;raw=await this.request(base,`/api/v1/adapt/${id}`,null,undefined,signal,{headers:{'X-API-Key':e.REPLICATION_KEY}}); }
    else if(task.kind==='propose_video_upscale') {base=e.UPSCALE_URL;raw=await this.request(base,'/openapi/v2/query',e.UPSCALE_KEY,{taskId:task.jobId},signal);}
    else {base=e.MEDIA_SERVICE_URL;raw=await this.request(base,`/v1/${task.kind==='slice_video'?'video-scenes':'lipsync'}/jobs/${id}`,e.MEDIA_SERVICE_KEY,undefined,signal);}
    const status=String(raw.status||raw.state||'').toLowerCase();
    if(['failed','failure','cancelled','expired'].includes(status)) return {...task,status:'failed',isError:true,error:'媒体服务处理失败'};
    if(['queued','pending','accepted','running','processing'].includes(status)) return {...task,status:['queued','pending','accepted'].includes(status)?'queued':'running'};
    if(!['succeeded','success','completed'].includes(status)) throw new ProviderError('服务返回无法识别的任务状态',false);
    const url=value=>{if(typeof value!=='string'||!value.trim())throw new ProviderError('成品地址缺失',false);return publicMediaUrl(new URL(value,base+'/').href);};
    if(task.kind==='slice_video') {
      if(!Array.isArray(raw.scenes)||!raw.scenes.length) throw new ProviderError('切片已完成但没有返回片段',false);
      return {...task,status:'succeeded',scenes:raw.scenes.map(s=>({index:s.index,startSeconds:s.start_seconds,endSeconds:s.end_seconds,durationSeconds:s.duration_seconds,videoUrl:url(s.video_url)}))};
    }
    const candidate=raw.result_url||raw.results?.find?.(r=>r.url||r.fileUrl||r.videoUrl);
    const value=typeof candidate==='string'?candidate:candidate?.url||candidate?.fileUrl||candidate?.videoUrl;
    if(!value) throw new ProviderError('服务报告完成但未返回成片',false);
    return {...task,status:'succeeded',videoUrl:url(value)};
  }
}
