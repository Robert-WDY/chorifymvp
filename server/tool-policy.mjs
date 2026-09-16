import {currentTask,storeOf,executionsFor,itemEvidence} from './task-state.mjs';
import {tools,mediaTools} from './tool-schemas.mjs';
export const operationTools={generate_image:['generate_image','propose_image_batch','replace_image_batch','execute_batch'],edit_image:['edit_image','propose_image_batch','replace_image_batch','execute_batch'],generate_video:['generate_video','propose_video_batch','replace_video_batch','propose_video_plan','execute_batch'],edit_video:[],analyze_image:['analyze_image'],read_video:['read_video'],analyze_video:['analyze_video','read_video'],voiceover:['generate_voiceover'],clone_voice:['clone_voice'],lipsync:['propose_lipsync'],slice_video:['slice_video'],upscale_video:['propose_video_upscale'],replicate_video:['propose_video_replication'],merge_videos:['merge_videos'],search_web:['search_web'],query_task:['get_video_task','wait_video_task','get_media_task','wait_media_task','refresh_task_results']};
const base=['update_plan','read_task_state','list_capabilities','find_skill','use_skill','read_skill','search_skill_reference','read_skill_reference','get_skill_script','run_skill_script','run_skill','search_history','find_material','read_asset','read_current_deliverables','request_skill_confirmation','defer_current_stage','finalize_turn','refresh_task_results'];
const evidence={image:['analyze_image'],video:['read_video','analyze_video'],web:['search_web'],task:['get_video_task','wait_video_task','get_media_task','wait_media_task','refresh_task_results']};
export const contracts=Object.fromEntries([...mediaTools].map(name=>[name,{requires:['task_scope','ready_dependencies','persisted_plan','safe_goal','known_references','quota','no_unknown_submission','service_configuration'],creates:name==='analyze_video'?['observation']:['execution','artifact'],confirmation:'host_policy_and_user_request'}]));
export function allowedTools(state,item){
 const names=new Set([...base,...(operationTools[item?.operation]||[]),...(evidence[item?.requiredEvidence]||[])]);
 if(currentTask(state)?.protocol==='compiled-v1'&&item?.operation==='edit_image')names.add('generate_image');
 if(item?.output==='text')names.add('commit_text_deliverable');
 if(item?.operation==='review_content')names.add('review_video_prompt');
 if(item?.output==='image')names.add('recommend_image_prompts');
 if(item)for(const name of ['search_knowledge','read_knowledge'])names.add(name);
 if(Object.values(storeOf(state).executions).some(e=>e.providerTaskId))for(const n of ['get_video_task','wait_video_task','get_media_task','wait_media_task'])names.add(n);
 return tools.filter(t=>names.has(t.name));
}
export function remainingSlots(state,item){
 const store=storeOf(state),successful=new Set(item.artifactIds.map(id=>store.artifacts[id]).filter(a=>a?.type===item.output&&a.verification.semantic!=='failed').map(a=>a.sourceExecutionId||a.id));
 const reserved=executionsFor(state,item.id).filter(e=>['pending','submitted','unknown'].includes(e.status)).length;
 return Math.max(0,item.count-successful.size-reserved);
}
export function checkPreconditions(state,item,name,args,{configuration,skipQuota=false}={}){
 if(item.activation?.timing==='after_user_input')throw new Error('当前阶段尚未满足输入或授权条件，禁止执行');
 const task=currentTask(state);
 if(!task||!item)throw new Error('没有可执行的任务项');
 if(!allowedTools(state,item).some(t=>t.name===name))throw new Error('本阶段未开放该工具，请遵守用户交付范围');
 if(!item.dependsOn.every(n=>task.items[n]?.status==='COMPLETED'))throw new Error('前序交付尚未完成');
 if(name==='commit_text_deliverable'&&!itemEvidence(state,item))throw new Error('缺少实际工具观察，不能提交未经观察的结论');
 if(!mediaTools.has(name))return;
 if(['REFUSED','NEEDS_INPUT','WAIT_CONFIRM','CANCELLED'].includes(task.status))throw new Error('当前任务状态不允许提交媒体');
 if(task.goal.safety.disposition==='refuse')throw new Error('安全审核未通过');
 if(!task.plan)throw new Error('执行媒体前请先用 update_plan 记录行动计划');
 if(Object.values(storeOf(state).executions).some(e=>['pending','unknown'].includes(e.status)&&(task.protocol!=='compiled-v1'||e.taskId===task.id)))throw new Error('有提交结果未知的动作，先查验已有任务，禁止重复提交');
 if(name!=='analyze_video'&&!skipQuota&&remainingSlots(state,item)<1)throw new Error('该任务所需数量已经提交或交付，不得额外生成');
 const urls=[...(args.referenceImages||[]),args.firstFrameUrl,args.referenceAudioUrl,args.videoUrl,args.audioUrl,args.productImageUrl,...(args.urls||[])].filter(Boolean);
 const known=new Set([...(state.assets||[]).map(a=>a.url),...Object.values(storeOf(state).artifacts).map(a=>a.url)].filter(Boolean));
 for(const url of urls)if(!known.has(url))throw new Error('引用素材不在用户输入或真实Artifact中，不能编造地址');
 const required=item.references.map(ref=>Object.values(storeOf(state).artifacts).find(a=>a.id===ref)?.url||state.assets?.find(a=>a.assetId===ref)?.url||ref).filter(ref=>ref.startsWith('https://'));
 if(['edit_image','generate_video','propose_lipsync','slice_video','propose_video_upscale','propose_video_replication','merge_videos','clone_voice'].includes(name))for(const ref of required)if(!urls.includes(ref))throw new Error('工具参数未使用目标指定的原始素材，不能替换为其他已知素材');
 if(name==='edit_image'&&!args.referenceImages?.length)throw new Error('图片编辑必须使用原始图片');
 if(task.protocol==='compiled-v1'&&name==='generate_image'){
  for(const ref of required)if(!(args.referenceImages||[]).includes(ref))throw new Error('图片参数必须使用目标指定的真实素材');
  if(item.operation==='edit_image'&&!args.referenceImages?.length)throw new Error('图片编辑必须使用原始图片');
 }
 if(configuration?.services?.[name]?.configured===false)throw new Error('服务未配置：'+configuration.services[name].missing.join(', '));
 if(name==='generate_video'&&configuration?.videoConfigured===false)throw new Error('视频服务未配置');
 if(['generate_image','edit_image'].includes(name)&&configuration?.imageConfigured===false)throw new Error('图片服务未配置');
 if(name==='generate_video'&&item.spec.durationSeconds&&args.duration!==item.spec.durationSeconds)throw new Error('生成时长必须与目标一致；当前单次能力不足时应明确阻塞，不能擅自缩短');
 if(name==='generate_video'&&item.spec.ratio&&args.ratio!==item.spec.ratio)throw new Error('生成画幅与目标不一致');
 if(['generate_image','edit_image'].includes(name)&&item.spec.ratio){
  const ratio=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(item.spec.ratio),size=/^(\d+)x(\d+)$/.exec(args.size||'');
  if(!ratio||!size||+ratio[2]<=0||+size[2]<=0||Math.abs((+size[1]/+size[2])/(+ratio[1]/+ratio[2])-1)>0.01)throw new Error('图片尺寸与目标比例冲突，禁止提交');
 }
}
