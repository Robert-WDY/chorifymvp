import { writeFile,mkdir,rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Doubao } from '../server/adapters.mjs';
import { ArkMedia } from '../server/media.mjs';
import { loadCatalog } from '../server/catalog.mjs';
import { ToolRuntime } from '../server/tools.mjs';
import { Agent } from '../server/agent.mjs';
import { mediaTools } from '../server/tool-schemas.mjs';
const catalog=await loadCatalog();
const brain=new Doubao({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL,model:process.env.DOUBAO_CHAT_MODEL});
const mode=process.argv[2]||'text';
const prompts={
  text:'请先使用 creative-prompt-rewrite 技能，把“清晨打开咖啡，城市逐渐苏醒”改写为 5 秒视频提示词。只给提示词，不实际生成图片或视频。',
  script:'使用 actor-realism-v2 技能的 validate_prompt_preservation 脚本检查：originalText="镜头1 咖啡 16:9"，optimizedText="咖啡"，lockedLiterals=["镜头1"]。先获取准确脚本参数，再实际调用脚本，最后用中文说明检查结果。不要生成媒体。',
  image:'这是图片工具联调：直接调用 generate_image 生成且仅生成一张测试图，提示词为“一杯咖啡置于纯白背景，简洁产品摄影”，尺寸 1K。不要使用其他媒体工具，不重试生成，返回真实结果。',
  video:'这是视频工具联调：直接调用 generate_video 创建且仅创建一条 2 秒视频，提示词为“一杯咖啡置于桌面，固定机位，蒸汽缓慢升起”，720p，16:9。然后用 wait_video_task 查询到完成或明确交付当前状态。不要重新提交。',
};
if(!prompts[mode])throw new Error('mode must be text, script, image or video');
const runtime=new ToolRuntime({catalog,brain,media:new ArkMedia({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL,imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL}),python:process.env.PYTHON_BIN});
const execute=runtime.execute.bind(runtime);
let submissions=0;
runtime.execute=async(name,...args)=>{
  if(mediaTools.has(name)){
    if(!['image','video'].includes(mode)||submissions++>=1)throw new Error('验收仅允许一次指定媒体提交，不重试');
    if(name!==(mode==='image'?'generate_image':'generate_video'))throw new Error('不是本次验收指定的媒体工具');
  }
  return execute(name,...args);
};
await mkdir(new URL('../data/',import.meta.url),{recursive:true});
const save=async state=>{
  const path=new URL(`../data/${state.id}.json`,import.meta.url);
  const temp=new URL(`../data/${state.id}.tmp`,import.meta.url);
  await writeFile(temp,JSON.stringify(state));await rename(temp,path);
};
const agent=new Agent({brain,runtime,catalog,maxSteps:8,save});
const events=[],state={id:randomUUID()};
await agent.run(state,prompts[mode],event=>events.push(event),AbortSignal.timeout(240000));
const final=events.findLast(e=>e.type==='final');
const expected={text:['use_skill','read_skill'],script:['run_skill_script'],image:['generate_image'],video:['wait_video_task','get_video_task']}[mode];
const used=events.some(e=>e.type==='tool_result'&&expected.includes(e.name)&&!e.result.isError);
const report={time:new Date().toISOString(),sessionId:state.id,mode:'real-doubao-'+mode,passed:state.status==='completed'&&used,
  status:state.status,toolCalls:events.filter(e=>e.type==='tool_result').map(e=>({name:e.name,isError:!!e.result.isError})),
  media:events.filter(e=>e.type==='tool_result'&&e.media).map(e=>e.result),answer:final?.text||''};
await mkdir(new URL('../data/',import.meta.url),{recursive:true});
await writeFile(new URL(`../data/live-check-${mode}.json`,import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!report.passed)process.exitCode=1;
