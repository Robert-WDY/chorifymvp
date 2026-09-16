import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {createBrain} from '../server/adapters.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {redact,tracedBrain} from '../server/trace-context.mjs';
const directory='data/real-media-query-audit-20260911';await mkdir(directory,{recursive:true});
const original=JSON.parse(await readFile('data/manual-fixed-server/5d574506-77bc-4ae5-b29f-8bc66a60e9e0.json'));
const catalog=await loadCatalog(),brain=createBrain();
const cases=[
 {id:'01-747-fresh',query:'根据波音747生成宣传的视频脚本',expected:'text'},
 {id:'02-747-image',query:'根据波音747生成宣传的视频脚本',source:'plane',expected:'text'},
 {id:'03-coffee-script',query:'给我的社区咖啡店写一条15秒的小红书宣传视频脚本，主打上班路上顺手买杯咖啡，不要生成视频。',expected:'text'},
 {id:'04-copy-revision',query:'把刚才的脚本改得更口语一点，缩短到10秒，店名叫慢半拍，其他不变。',previous:'03-coffee-script',expected:'text'},
 {id:'05-cover-ideas',query:'给这个精油产品想三个小红书封面方向，先只给我文字创意和标题。',source:'product',expected:'text'},
 {id:'06-i2v-prompt',query:'帮我写一段图生视频提示词，让这架飞机缓慢滑行，镜头跟拍，只要提示词。',source:'plane',expected:'text'},
 {id:'07-image-review',query:'看看这张飞机图适不适合做航空公司宣传海报，画面里有哪些问题？',source:'plane',expected:'observe'},
 {id:'08-image-create',query:'生成一张新中式茶饮海报，桂花乌龙，米白背景，没有文字，竖版。',expected:'image_boundary'},
 {id:'09-image-edit',query:'把这张精油图片的背景换成浴室台面，瓶子不要变。',source:'product',expected:'image_boundary'},
 {id:'10-video-create',query:'做一段5秒的咖啡杯视频，镜头慢慢推近，杯口有蒸汽，横屏。',expected:'video_boundary'},
 {id:'11-confirm-plan',query:'先给我写一个咖啡店宣传短视频脚本，等我确认后再生成视频。',expected:'approval'},
 {id:'12-revise-plan',query:'方案改成竖屏，10秒，先别开始生成。',previous:'11-confirm-plan',expected:'approval'},
 {id:'13-missing-image',query:'帮我把这张图片背景变透明，只保留中间的商品。',expected:'missing'},
 {id:'14-video-edit',query:'给我之前的视频加上中文字幕，保持原来的画面和配音。',expected:'missing_or_unsupported'}
];
const states=new Map(),results=[];
function seed(c){
 if(c.previous)return structuredClone(states.get(c.previous));
 const s={id:randomUUID(),messages:[],events:[]};
 if(c.source){const id=c.source==='plane'?'ed904779-9c40-44c0-80e9-336847b07919':'50ff2e7f-9945-46a9-afaa-b7b2df41fe76',a=structuredClone(original.taskStore.artifacts[id]);
  s.assets=[{assetId:a.id,url:a.url,kind:'image',source:'user'}];
  s.messages=[{role:'user',content:c.source==='plane'?'这里有一张飞机图片。':'这是我的精油产品图片。'}];
 }
 return s;
}
async function run(c){
 const state=seed(c);state.id=randomUUID();state.modelCalls=[];state.events=[];const boundary=[],tools=[],start=Date.now();let final;
 const block=kind=>async args=>{boundary.push({kind,args});throw new Error('EVAL_SUBMISSION_BOUNDARY：测试已在媒体提交前停止，未调用生成服务');};
 const media={config:{imageModel:'configured-for-planning',videoModel:'configured-for-planning'},image:block('image'),video:block('video'),getVideo:block('video_query')};
 const extended={capabilities:()=>({}),submit:block('extended_media')};
 const runtime=new ToolRuntime({catalog,brain,media,extended});const execute=runtime.execute.bind(runtime);
 runtime.execute=async(name,args,...rest)=>{const call={name,args,startedAt:new Date().toISOString()};tools.push(call);try{call.result=await execute(name,args,...rest);call.status='returned';return call.result;}catch(e){call.status='threw';call.error=e.message;throw e;}};
 const output={id:c.id,query:c.query,expected:c.expected,seed:c.source||c.previous||'empty',actualMediaSubmissions:0,boundary,tools,state};
 const save=async()=>{await writeFile(directory+'/'+c.id+'.tmp',JSON.stringify(redact(output),null,2));};
 const agent=new Agent({brain,runtime,catalog,verifier:new Verifier(tracedBrain(brain)),save});
 try{await agent.run(state,c.query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(150000));}catch(error){output.error=error.message;}
 const task=state.taskStore?.tasks[state.lastTurn?.taskId||state.taskStore.activeTaskId];
 output.summary={status:final?.status||state.lastTurn?.status,reason:task?.reason,error:output.error,finalReturned:!!final,modelCalls:state.modelCalls.length,failedCalls:state.modelCalls.filter(c=>c.status!=='returned').length,operations:task?.items?.map(i=>i.operation)||[],methods:task?.items?.flatMap(i=>i.requiredMethods)||[],references:task?.items?.map(i=>i.references)||[],boundary:boundary.map(b=>b.kind),toolNames:tools.map(t=>t.name),validationErrors:state.modelCalls.flatMap(c=>(c.validations||[]).filter(v=>v.accepted===false).map(v=>({phase:v.phase,error:v.error}))),durationMs:Date.now()-start};
 output.summary.imageInputs=state.modelCalls.reduce((n,c)=>n+c.input.flatMap(i=>Array.isArray(i.content)?i.content:[]).filter(p=>p.type==='input_image').length,0);
 output.final=final;await writeFile(directory+'/'+c.id+'.json',JSON.stringify(redact(output),null,2));states.set(c.id,state);results.push({id:c.id,query:c.query,expected:c.expected,...output.summary});
 console.log(JSON.stringify({id:c.id,...output.summary}));await writeFile(directory+'/summary.json',JSON.stringify({createdAt:new Date().toISOString(),provider:brain.config.provider,model:brain.config.model,actualMediaSubmissions:0,note:'模型/文字流程为真实调用；所有图片视频及扩展媒体提交均被测试适配器拦截，未伪造成品。boundary 是测试主动停止，不是线上失败。',results},null,2));
}
// Keep dependent turns ordered, and run at most two independent conversations.
const groups=[[cases[0],cases[2],cases[3],cases[4],cases[6],cases[8],cases[12]],[cases[1],cases[5],cases[7],cases[9],cases[10],cases[11],cases[13]]];
await Promise.all(groups.map(async group=>{for(const c of group)await run(c);}));
