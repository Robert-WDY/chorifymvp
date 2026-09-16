import {imageObservation,videoObservation} from './prompt-text.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readSkill, searchReferences } from './catalog.mjs';
import { scriptDefinition, runScript } from './script-runner.mjs';
import { publicMediaUrl } from './media.mjs';
import {assertSubmissionPermit} from './submission-permit.mjs';
import { tools, mediaTools } from './tool-schemas.mjs';
import {contracts} from './tool-policy.mjs';
import { ExtendedMedia, extendedMediaNames } from './extended-media.mjs';
import { randomUUID } from 'node:crypto';
export class ToolRuntime {
  constructor({catalog,brain,media,python,requireExecutionPermit=false,pollMs=3000,waitMs=20000,extended=new ExtendedMedia()}) { Object.assign(this,{catalog,brain,media,python,requireExecutionPermit,pollMs,waitMs,extended}); }
  capabilities() { return { tools:tools.map(t=>({name:t.name,description:t.description,contract:contracts[t.name]})),
    skills:this.catalog.skills.map(({slug,name,description})=>({slug,name,description})),
    imageConfigured:!!this.media.config.imageModel,videoConfigured:!!this.media.config.videoModel,services:this.extended.capabilities() }; }
  async execute(name,args,state,signal) {
    if(this.requireExecutionPermit&&mediaTools.has(name)&&name!=='analyze_video')assertSubmissionPermit(state,name,args);
    if(extendedMediaNames.includes(name)) {
      const result=await this.extended.submit(name,args,signal);
      if(result.taskId) {state.mediaTasks??={};state.mediaTasks[result.taskId]=result;}
      return result;
    }
    switch(name) {
      case 'declare_goal': if(state.goal?.tasks)return {goal:state.goal,note:'本轮目标已由入口识别，不再覆盖。'};state.goal=args;return args;
      case 'commit_text_deliverable': {state.deliverables??=[];const item={id:randomUUID(),runId:state.currentRunId,kind:'text',content:args.content};state.deliverables.push(item);return item;}
      case 'request_skill_confirmation': state.question=args.question;return {requiresAnswer:true,question:args.question};
      case 'defer_current_stage': state.deferred=args.reason;return {status:'blocked',reason:args.reason};
      case 'finalize_turn': return {goal:state.goal,deliverables:(state.deliverables||[]).filter(d=>!state.currentRunId||d.runId===state.currentRunId),assets:state.assets||[],tasks:[...Object.values(state.videoTasks||{}),...Object.values(state.mediaTasks||{})],question:state.question,deferred:state.deferred,note:'这是基础交付检查所需事实，不代表创意质量或事实真实性已验收。'};
      case 'propose_image_batch': case 'propose_video_batch': case 'propose_video_plan': case 'replace_image_batch': case 'replace_video_batch': {
        state.batches??={};const kind=name.includes('image')?'image':'video';
        if(name.startsWith('replace_')&&state.batches[args.batchId]?.kind!==kind)throw new Error('没有匹配的本会话方案');
        const batchId=args.batchId||randomUUID();state.batches[batchId]={batchId,kind,items:args.items||[{prompt:args.prompt}],status:'planned'};
        return {...state.batches[batchId],note:'这是方案，不是生成结果。仅当用户要求实际生成时逐项调用生成工具；不得把计划称为成品。'};
      }
      case 'find_tool': return {tools:tools.filter(t=>(t.name+t.description).includes(args.query)||args.query.split(/\s+/).some(w=>(t.name+t.description).includes(w))).map(t=>({...t,...this.extended.capabilities()[t.name]})),services:this.extended.capabilities()};
      case 'find_material': return {assets:(state.assets||[]).filter(a=>!args.kind||a.kind===args.kind).slice(-30),note:'按时间从旧到新排列；多个候选不明确时请向用户澄清。'};
      case 'read_asset': {const asset=state.assets?.find(a=>a.assetId===args.assetId);if(!asset)throw new Error('本会话没有该素材');return asset;}
      case 'read_current_deliverables': return {assets:state.assets||[],videoTasks:state.videoTasks||{},mediaTasks:state.mediaTasks||{},batches:state.batches||{},deliverables:state.deliverables||[],text:(state.messages||[]).filter(m=>m.type==='message').slice(-5)};
      case 'search_knowledge': return {matches:(await Promise.all(this.catalog.skills.map(async s=>({slug:s.slug,matches:await searchReferences(this.catalog,s.slug,args.query)})))).filter(s=>s.matches.length)};
      case 'read_knowledge': return readSkill(this.catalog,args.doc,args.section,args.offset);
      case 'recommend_image_prompts': return this.execute('use_skill',{slug:'image-prompt-gallery-director-v2',task:args.query},state,signal);
      case 'review_video_prompt': return this.execute('use_skill',{slug:'video-prompt-safety-zh-v1',task:args.prompt},state,signal);
      case 'search_web': {
        const output=await this.brain.respond([{role:'system',content:`请实际联网搜索，按来源回答。今天是 ${new Date().toISOString().slice(0,10)}。`},{role:'user',content:args.query}],[{type:'web_search'}],signal);
        const parts=output.filter(x=>x.type==='message').flatMap(x=>x.content||[]);
        const sources=parts.flatMap(x=>x.annotations||[]).filter(a=>a.type==='url_citation'&&a.url).map(a=>({title:a.title||a.url,url:a.url}));
        if(!sources.length) throw new Error('联网搜索没有返回可验证来源，不能用模型记忆冒充搜索');
        return {text:parts.map(x=>x.text||'').join('\n'),sources};
      }
      case 'get_media_task': case 'wait_media_task': {
        let task=state.mediaTasks?.[args.taskId];if(!task)throw new Error('只能查询本会话真实提交的媒体任务');
        const deadline=Date.now()+(name==='wait_media_task'?this.waitMs:0);
        do {task=await this.extended.query(task,signal);state.mediaTasks[args.taskId]=task;
          if(!['queued','running'].includes(task.status)||Date.now()>=deadline)break;
          await delay(Math.min(this.pollMs,deadline-Date.now()),null,{signal});
        } while(Date.now()<=deadline);
        return task;
      }
      case 'list_capabilities': return this.capabilities();
      case 'find_skill': {
        const words=args.query.toLowerCase().split(/\s+/);
        return {skills:this.capabilities().skills.map(s=>({...s,score:words.filter(w=>(s.name+s.description+s.slug).toLowerCase().includes(w)).length})).sort((a,b)=>b.score-a.score)};
      }
      case 'use_skill': case 'read_skill': case 'read_skill_reference': {
        const result=await readSkill(this.catalog,args.slug,args.reference,args.offset);
        state.loadedSkills=[...new Set([...(state.loadedSkills||[]),args.slug])];
        return {...result,...(args.task?{task:args.task}:{})};
      }
      case 'search_skill_reference': return {matches:await searchReferences(this.catalog,args.slug,args.query)};
      case 'get_skill_script': return scriptDefinition(this.catalog,args.slug,args.name);
      case 'run_skill_script': return runScript(this.catalog,args.slug,args.name,args.input,signal,this.python || undefined);
      case 'generate_image': case 'edit_image': return this.media.image(args,signal);
      case 'generate_video': {
        const result=await this.media.video(args,signal);
        state.videoTasks ??= {}; state.videoTasks[result.taskId]=result; return result;
      }
      case 'get_video_task': case 'wait_video_task': {
        if(!state.videoTasks?.[args.taskId]) throw new Error('只能查询本会话已经提交的真实视频任务');
        const deadline=Date.now()+(name==='wait_video_task'?this.waitMs:0);
        let result;
        do {
          result=await this.media.getVideo(args.taskId,signal);
          state.videoTasks[args.taskId]=result;
          if(!['queued','running'].includes(result.status)||Date.now()>=deadline) break;
          await delay(Math.min(this.pollMs,deadline-Date.now()),null,{signal});
        } while(Date.now()<=deadline);
        return result;
      }
      case 'analyze_image': case 'read_video': {
        if(name==='analyze_image'&&!!args.url===!!args.urls)throw new Error('图片观察必须提供url或urls之一');
        const urls=(name==='analyze_image'&&args.urls?args.urls:[args.url]).map(publicMediaUrl);
        if(!urls.length)throw new Error('图片观察缺少真实来源');
        const media=urls.flatMap((url,i)=>[{type:'input_text',text:(name==='analyze_image'?'实际输入图片 ':'实际输入视频 ')+(i+1)},name==='analyze_image'?{type:'input_image',image_url:url}:{type:'input_video',video_url:url,fps:1}]);
        const output=await this.brain.respond([{role:'system',content:name==='analyze_image'?imageObservation:videoObservation},{role:'user',content:[{type:'input_text',text:args.question},...media]}],[],signal,{tracePhase:name==='analyze_image'?'observe_image':'observe_video'});
        const text=output.filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n');
        if(!text) throw new Error('视觉模型没有返回分析正文');
        return {text};
      }
      case 'search_history': {
        const snippets=state.messages.flatMap(x=>x.role==='user'?[x.content]:x.type==='message'?(x.content||[]).filter(p=>p.type==='output_text').map(p=>p.text):[]);
        return {matches:snippets.filter(x=>typeof x==='string'&&x.includes(args.query)).slice(-5).map(x=>x.slice(0,4000))};
      }
      default: throw new Error('没有该工具的执行器');
    }
  }
}
