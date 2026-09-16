const str = { type: 'string', minLength: 1, maxLength: 30000 };
const slug = { type: 'string', pattern: '^[a-z0-9-]+$' };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, properties, required) => ({ type: 'function', name, description, parameters: obj(properties, required) });
const url = { type: 'string', pattern: '^https://', maxLength: 8000 };
const images = { type: 'array', items: url, maxItems: 4 };
const image = { prompt: str, size: { type: 'string', enum: ['1K','2K','4K','2048x2048','2560x1440','1440x2560','1728x2304','2304x1728'] }, referenceImages: images };
const batch = {items:{type:'array',minItems:1,maxItems:20,items:obj({prompt:str,duration:{type:'integer',minimum:2,maximum:12},ratio:{enum:['16:9','9:16','1:1','4:3','3:4','21:9']},resolution:{enum:['480p','720p','1080p']},size:image.size,referenceImages:images,firstFrameUrl:url},['prompt'])}};
export const tools = [
  tool('update_plan','记录用户可检查的行动计划，不输出内部推理。',{summary:str,steps:{type:'array',minItems:1,maxItems:8,items:obj({title:str,status:{type:'string',enum:['pending','running','done']}},['title','status'])}},['summary','steps']),
  tool('list_capabilities','列出当前真正可执行的工具、技能与配置状态。',{}),
  tool('find_skill','搜索本地技能；query 描述要完成的任务，无精确匹配时返回完整候选。',{query:str},['query']),
  tool('use_skill','激活技能并读取专业方法，主模型需运用返回内容完成 task 并交付答案。',{slug,task:str},['slug','task']),
  tool('run_skill','依据Skill输入/输出合同执行专业方法并返回经Schema校验的正文与结构；不直接生成媒体。',{slug,feedback:str},['slug']),
  tool('read_task_state','读取任务、交付物、执行记录、确认状态的唯一事实来源。',{}),
  tool('execute_batch','执行本任务已保存的批量方案，逐项持久化并恢复未提交项；不重复提交已有任务。',{batchId:str},['batchId']),
  tool('refresh_task_results','一次查询本任务所有已提交媒体，无需逐个调用；从实际结果更新Artifact与任务状态。',{}),
  tool('read_skill','分页读取技能正文或指定参考资料。',{slug,reference:str,offset:{type:'integer',minimum:0}},['slug']),
  tool('search_skill_reference','在指定技能参考资料中检索关键词片段。',{slug,query:str},['slug','query']),
  tool('read_skill_reference','读取技能清单中的参考文件，不接受任意路径。',{slug,reference:str,offset:{type:'integer',minimum:0}},['slug','reference']),
  tool('get_skill_script','获取脚本的准确 inputSchema，运行前先读。',{slug,name:str},['slug','name']),
  tool('run_skill_script','运行已登记、校验哈希的本地 Python 质检脚本。',{slug,name:str,input:{type:'object'}},['slug','name','input']),
  tool('generate_image','通过方舟直接生成一张图片，成功返回成品 URL，调用会产生模型费用。',image,['prompt']),
  tool('edit_image','通过方舟直接编辑参考图片，成功返回成品 URL。',{...image,referenceImages:{...images,minItems:1}},['prompt','referenceImages']),
  tool('generate_video','通过方舟直接创建一个视频任务，必须继续查询才知道是否完成。',{prompt:str,duration:{type:'integer',minimum:2,maximum:12},ratio:{type:'string',enum:['16:9','9:16','1:1','4:3','3:4','21:9']},resolution:{type:'string',enum:['480p','720p','1080p']},firstFrameUrl:url},['prompt']),
  tool('get_video_task','查询本会话真实提交的视频任务，不重复创建。',{taskId:str},['taskId']),
  tool('wait_video_task','最多等待 20 秒并查询视频任务，未完成时返回当前状态。',{taskId:str},['taskId']),
  tool('analyze_image','将有序真实图片一起传给当前视觉模型，回答单图问题或多图比较。',{url,urls:{type:'array',items:url,minItems:1,maxItems:20},question:str},['question']),
  tool('read_video','将真实视频传给豆包视觉模型并回答 question。',{url,question:str},['url','question']),
  tool('search_history','检索当前会话用户文字与助手已交付正文。',{query:str},['query']),
  tool('find_tool','按需求检索当前可调用工具和配置状态。',{query:str},['query']),
  tool('find_material','查找本会话用户提供的素材及已生成媒体，解决“刚才那张”等引用。',{query:str,kind:{enum:['image','video','audio','text']}},['query']),
  tool('read_asset','读取本会话素材的真实地址及来源。',{assetId:str},['assetId']),
  tool('read_current_deliverables','读取本会话已交付结果及正在执行的任务。',{}),
  tool('search_knowledge','搜索本地技能知识和参考资料，不是联网搜索。',{query:str},['query']),
  tool('read_knowledge','读取本地技能知识，doc 为技能 slug，section 为可选参考文件名。',{doc:slug,section:str,offset:{type:'integer',minimum:0}},['doc']),
  tool('recommend_image_prompts','读取本地图像提示词导演方法，基于方法为 query 推荐提示词。',{query:str},['query']),
  tool('review_video_prompt','加载视频提示词安全审查方法；根据返回方法交付审查及改写正文。',{prompt:str},['prompt']),
  tool('search_web','使用豆包内置联网搜索，必须返回实际引用来源。',{query:str},['query']),
  tool('generate_voiceover','把文字合成为配音音频，需要独立 TTS 配置。',{text:str,voiceId:str},['text']),
  tool('clone_voice','使用参考音频音色合成新文本，返回可播放音频。',{text:str,referenceAudioUrl:url},['text','referenceAudioUrl']),
  tool('propose_lipsync','实际提交口型同步任务，需要音频和视频两个公网地址，继续 wait_media_task。',{audioUrl:url,videoUrl:url,faceRestore:{type:'boolean'}},['audioUrl','videoUrl']),
  tool('slice_video','按场景变化实际提交视频切片任务，不是指定时间裁剪；继续 wait_media_task。',{videoUrl:url,minSceneLen:{type:'integer',minimum:1,maximum:1000},threshold:{type:'number',minimum:1,maximum:100}},['videoUrl']),
  tool('propose_video_upscale','实际提交视频超分任务，继续 wait_media_task。',{videoUrl:url,shortSide:{type:'integer',enum:[720,1088,1440,1920]}},['videoUrl']),
  tool('propose_video_replication','实际提交产品视频复刻，必须提供参考视频和产品图片，继续 wait_media_task。',{videoUrl:url,productImageUrl:url,productName:str,prompt:str,ratio:{enum:['9:16','16:9','1:1']}},['videoUrl','productImageUrl','productName','prompt']),
  tool('merge_videos','按给定顺序合并 2–12 条视频，实际调用独立转码服务。',{urls:{type:'array',items:url,minItems:2,maxItems:12}},['urls']),
  tool('analyze_video','调用独立专业视频分析服务，输出营销结构、分镜等详细分析；简单看内容用 read_video。',{videoUrl:url},['videoUrl']),
  tool('get_media_task','查询本会话已提交的切片、口型、超分、复刻任务。',{taskId:str},['taskId']),
  tool('wait_media_task','等待并查询本会话媒体处理任务，未完成将自动继续后台跟踪。',{taskId:str},['taskId']),
  tool('propose_image_batch','保存最多12项图片执行方案及参数；后续execute_batch执行。用户要求确认时展示具体方案并等待。',batch,['items']),
  tool('propose_video_batch','保存最多12项视频执行方案，每项包含prompt及实际duration/ratio；后续execute_batch负责提交和查询。',batch,['items']),
  tool('replace_image_batch','修改本会话已有图片方案，不修改已生成文件。',{batchId:str,...batch},['batchId','items']),
  tool('replace_video_batch','修改本会话已有视频方案，不修改已生成文件。',{batchId:str,...batch},['batchId','items']),
  tool('propose_video_plan','记录一条视频创意方案；仅规划，生成需 generate_video。',{prompt:str},['prompt']),
  tool('declare_goal','记录对用户意图的理解与交付目标；仅按用户要求选择类型，不扩大任务。',{intent:str,deliverables:{type:'array',items:{enum:['text','image','video','audio','analysis']},minItems:1,maxItems:5}},['intent','deliverables']),
  tool('commit_text_deliverable','保存已写好的完整正文作为用户交付物，不能只提交计划。',{content:str},['content']),
  tool('request_skill_confirmation','仅缺少必需输入时记录问题。用户要求确认媒体方案时，必须用propose_image_batch/propose_video_batch保存具体方案，不用本工具代替。',{question:str},['question']),
  tool('defer_current_stage','记录由于缺少输入或配置暂缓的原因，不能当作完成。',{reason:str},['reason']),
  tool('finalize_turn','核对当前真实交付和任务状态，之后给用户最终答复。',{}),
];
// A batch item has exactly the same contract as its executable tool.
// Sharing a union of image/video parameters makes valid plans impossible to submit.
for(const [names,target] of [[['propose_image_batch','replace_image_batch'],'generate_image'],[['propose_video_batch','replace_video_batch'],'generate_video']]){
 for(const name of names){const definition=tools.find(t=>t.name===name);definition.parameters=structuredClone(definition.parameters);definition.parameters.properties.items.items=structuredClone(tools.find(t=>t.name===target).parameters);}
}
export const mediaTools = new Set(['generate_image','edit_image','generate_video','generate_voiceover','clone_voice','propose_lipsync','slice_video','propose_video_upscale','propose_video_replication','merge_videos','analyze_video']);
tools.find(t=>t.name==='analyze_image').parameters.oneOf=[{required:['url'],not:{required:['urls']}},{required:['urls'],not:{required:['url']}}];
