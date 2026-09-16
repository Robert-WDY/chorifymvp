import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {createBrain,brainConfig} from '../server/adapters.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {storeOf,projectState} from '../server/task-state.mjs';
import {redact} from '../server/trace-context.mjs';
const root='data/intermediate-eval-20260914',dir=root+'/readonly-supplement';
await fs.mkdir(dir,{recursive:true});
if(await fs.stat(dir+'/results.json').catch(()=>null))throw Error('Refuse duplicate run');
const receipts=JSON.parse(await fs.readFile(root+'/private/media-receipts.json','utf8'));
const image=n=>receipts.find(r=>r.postIndex===n)?.response?.data?.[0]?.url;
const catalog=await loadCatalog(),config=brainConfig(),results=[];
let modelRequests=0;
const specs=[
 {id:'E05-T2-reuse',originalTurn:'E05-T2',posts:[5,8],description:'第一张蓝背景白杯，第二张米白背景白杯；两张均作为独立输入，不指定编辑目标。',queries:['把它改成红色。'],expected:'clarify_object_and_region_no_media'},
 {id:'D01-cup-observation',posts:[5,8],description:'第一张是修改前，第二张是修改后；现有真实图片作为测试输入。',queries:['请实际读取第一张图片，告诉我背景颜色、杯子颜色、杯子数量以及有没有把手。按画面回答，不要仅复述之前的生成要求，也不要改图。','实际对比这两张图，确认背景是否改了，杯子形状和位置是否明显变化。有偏差就直接说，不要为了检查再生成一遍。'],expected:'actual_image_observation_no_media',notOriginalE07:true}
];
for(const spec of specs){
 const state={id:randomUUID(),messages:[],events:[],actions:{}},denied=[];storeOf(state);
 for(const [i,n] of spec.posts.entries()){
  if(!image(n))throw Error('Missing real source '+n);
  const id=randomUUID();state.taskStore.inputs[id]={id,assetId:id,type:'image',kind:'image',url:image(n),version:1,purpose:'input',sessionId:state.id,source:'evaluation_fixture',metadata:{fixtureSetup:true,postIndex:n,visibleOrder:i+1}};
 }
 projectState(state);state.messages.push({role:'user',content:'[测试前置素材，不计为Agent成功生成] '+spec.description,fixtureSetup:true},{role:'assistant',type:'message',content:[{type:'output_text',text:spec.description}],fixtureSetup:true});
 const save=async s=>fs.writeFile(dir+'/'+spec.id+'-session.json',JSON.stringify(redact(s),null,2));
 const transport=async(url,opt)=>{
  if(!String(url).startsWith(config.baseUrl)||!String(url).endsWith('/responses'))throw Error('UNEXPECTED_MODEL_ENDPOINT');
  if(++modelRequests>80)throw Error('SUPPLEMENT_MODEL_CAP');
  const record={context:spec.id,at:new Date().toISOString(),url:String(url),request:JSON.parse(opt.body)};
  try{const response=await fetch(url,opt);record.status=response.status;record.response=await response.clone().json();return response;}catch(e){record.error=e.message;throw e;}finally{await fs.appendFile(dir+'/model-transport.jsonl',JSON.stringify(redact(record))+'\n');}
 };
 const brain=createBrain(process.env,transport),deny=async args=>{denied.push({at:new Date().toISOString(),args});throw Error('READONLY_SUPPLEMENT_NO_MEDIA');};
 const runtime=new ToolRuntime({brain,catalog,media:{config:{imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL},image:deny,video:deny,request:deny},extended:{capabilities:()=>({}),submit:deny,request:deny}});
 const execute=runtime.execute.bind(runtime);runtime.execute=(name,args,...rest)=>/^(generate_|edit_|.*video_task|.*media_task)/.test(name)?deny({name,args}):execute(name,args,...rest);
 const agent=new Agent({brain,runtime,catalog,verifier:new Verifier(brain),save});
 await save(state);
 for(const [i,query] of spec.queries.entries()){
  const id=spec.id+'-'+(i+1);await fs.writeFile(dir+'/'+id+'-before.json',JSON.stringify(redact(state),null,2));let final;
  await agent.run(state,query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(180000));
  const row={id,spec,query,final,turn:state.turns.at(-1),denied:[...denied],imagePosts:0};results.push(row);
  await fs.writeFile(dir+'/'+id+'-after.json',JSON.stringify(redact(state),null,2));await fs.writeFile(dir+'/results.partial.json',JSON.stringify(redact(results),null,2));
  console.log(JSON.stringify({id,status:final?.status,denied:denied.length}));
 }
}
await fs.writeFile(dir+'/results.json',JSON.stringify(redact({results,modelRequests,imagePosts:0,videoPosts:0,scope:'supplemental real-source read-only diagnostics; no original upstream passes'}),null,2));
