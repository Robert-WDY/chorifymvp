import { writeFile,readFile } from 'node:fs/promises';
import { Doubao } from '../server/adapters.mjs';
import { ToolRuntime } from '../server/tools.mjs';
import { loadCatalog } from '../server/catalog.mjs';
import { Agent } from '../server/agent.mjs';
const catalog=await loadCatalog();
const brain=new Doubao({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL,model:process.env.DOUBAO_CHAT_MODEL});
const cases=[
  {name:'rewrite',query:'把“清晨打开咖啡，城市逐渐苏醒”改成一条有电影感的 5 秒视频提示词，只要文字。',required:['use_skill'],forbidden:['generate_image','generate_video']},
  {name:'image',query:'帮我做一张咖啡新品宣传图，白色背景，杯子上没有文字，方形。直接出图。',required:['generate_image']},
  {name:'video',query:'做一条2秒的视频，一杯咖啡在桌上冒热气，固定镜头，横屏。',required:['generate_video','wait_video_task']},
  {name:'slice',query:'请把 https://example.com/input.mp4 按场景变化拆成几个视频片段。',required:['slice_video','wait_media_task']},
  {name:'voice',query:'请把“美好的一天，从一杯咖啡开始”做成中文配音，使用默认音色。',required:['generate_voiceover']},
  {name:'missing',query:'帮我把人物视频对上配音口型。',required:[],expectedStatus:'needs_input',forbidden:['propose_lipsync']},
  {name:'edit-followup',query:'把刚才那张咖啡图片的背景改成浅蓝色，杯子保持不变。',required:['edit_image'],seed:true},
];
const readReport=async name=>JSON.parse(await readFile(new URL('../data/'+name,import.meta.url),'utf8').catch(()=>'{"media":[]}'));
const previous=await readReport('live-check-video.json');
const realVideo=process.env.EVAL_VIDEO_URL||previous.media.findLast(m=>m.videoUrl)?.videoUrl;
const previousImage=await readReport('live-check-image.json');
const realImage=process.env.EVAL_IMAGE_URL||previousImage.media.findLast(m=>m.images?.length)?.images[0].url;
const selected=process.argv.slice(2);
const reports=[];
for(const c of cases.filter(c=>!selected.length||selected.includes(c.name))) {
  if(c.name==='slice'&&realVideo)c.query=c.query.replace('https://example.com/input.mp4',realVideo);
  const media={config:{imageModel:'protocol-fixture',videoModel:'protocol-fixture'},image:async()=>({status:'succeeded',images:[{url:'https://example.com/result.png'}]}),video:async()=>({taskId:'eval-video',status:'queued'}),getVideo:async()=>({taskId:'eval-video',status:'succeeded',videoUrl:'https://example.com/result.mp4'})};
  const extended={capabilities:()=>Object.fromEntries(['slice_video','propose_lipsync','generate_voiceover'].map(k=>[k,{configured:true,missing:[]}])),submit:async(name)=>name==='generate_voiceover'?{status:'succeeded',audioUrl:'/media/11111111-1111-4111-8111-111111111111.mp3'}:{taskId:'eval-media',jobId:'eval',kind:name,status:'queued'},query:async(task)=>({...task,status:'succeeded',scenes:[{index:1,startSeconds:0,endSeconds:2,videoUrl:'https://example.com/scene.mp4'}]})};
  const runtime=new ToolRuntime({catalog,brain,media,extended,python:process.env.PYTHON_BIN});
  const state={id:'eval-'+c.name};
  if(c.seed){state.assets=[{assetId:'coffee',kind:'image',url:realImage||'https://example.com/coffee.png',source:'generate_image'}];state.messages=[{role:'user',content:'生成一张咖啡图片'},{type:'message',role:'assistant',content:[{type:'output_text',text:'已生成咖啡图片：'+(realImage||'https://example.com/coffee.png')}]}];}
  const events=[];await new Agent({brain,runtime,catalog,maxSteps:12}).run(state,c.query,e=>events.push(e),AbortSignal.timeout(180000));
  const calls=events.filter(e=>e.type==='tool_result'&&!e.result.isError).map(e=>e.name);
  const passed=c.required.every(n=>calls.includes(n))&&!(c.forbidden||[]).some(n=>calls.includes(n))&&state.status===(c.expectedStatus||'completed');
  reports.push({name:c.name,query:c.query,passed,status:state.status,goal:state.goal,calls,events,errors:events.filter(e=>e.result?.isError).map(e=>({name:e.name,error:e.result.text})),answer:events.at(-1)?.text});
  console.log(JSON.stringify({name:c.name,passed,status:state.status,calls}));
}
await writeFile(new URL(`../data/query-eval${process.env.EVAL_REPORT_TAG?'-'+process.env.EVAL_REPORT_TAG:selected.length?'-retry':''}.json`,import.meta.url),JSON.stringify({mode:'real-doubao-routing-with-simulated-media-no-real-generation',time:new Date().toISOString(),reports},null,2));
if(reports.some(r=>!r.passed))process.exitCode=1;
