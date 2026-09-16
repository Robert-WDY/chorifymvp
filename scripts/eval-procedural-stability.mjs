import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {createBrain} from '../server/adapters.mjs';
import {ArkMedia} from '../server/media.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {redact} from '../server/trace-context.mjs';
const dir=process.argv[2]||'data/procedural-stability-20260911';await mkdir(dir,{recursive:true});
const catalog=await loadCatalog(),original=JSON.parse(await readFile('data/manual-fixed-server/5d574506-77bc-4ae5-b29f-8bc66a60e9e0.json'));
const config={key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL||'https://ark.cn-beijing.volces.com',imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL};
// This transport cannot reach the video API, even if a future adapter calls request directly.
const ark=new ArkMedia(config,(url,options)=>{if(!new URL(url).pathname.endsWith('/images/generations'))throw new Error('EVAL_VIDEO_NETWORK_DENIED');return fetch(url,options);});
let imageSubmissions=0;const imageLimit=3,states=new Map(),results=[];
const groups=[
 [
  ['B01','你好，简单介绍一下你能帮我做什么。','text'],
  ['B02','现在有哪些图片和视频工具可以用？','text'],
  ['B03','给一家社区咖啡店写三条朋友圈文案。','text'],
  ['B04','把“每日现磨，香气满杯”改得更自然一点。','text'],
  ['B05','给波音747写一个宣传视频脚本。','text'],
  ['B06','只写一段图片提示词：雨后的街边咖啡店，电影感。','text'],
  ['B07','图片生成怎么收费？不知道实际价格就直接说不知道。','text'],
  ['B08','我想宣传一家咖啡店，你先给我一些思路。','text']
 ],
 [
  ['S01','用 creative-prompt-rewrite 优化这段提示词：一杯咖啡放在桌上，镜头靠近，蒸汽上升。只给文字。','text',{methods:['creative-prompt-rewrite']}],
  ['S02','用 marketing-brief-zh-v1 给一家社区咖啡店做营销Brief，目标是吸引附近上班族。','text',{methods:['marketing-brief-zh-v1']}],
  ['S03','用 video-script-zh-v1 写一份10秒咖啡宣传脚本，不要生成视频。','text',{methods:['video-script-zh-v1']}],
  ['S04','用 video-prompt-safety-zh-v1 检查这句广告：喝一杯就能治失眠。给修改建议。','text',{methods:['video-prompt-safety-zh-v1']}],
  ['S05','用 product-understanding-zh-v1 分析产品：便携保温杯，350毫升，不知道能保温多久。不要编功效。','text',{methods:['product-understanding-zh-v1']}],
  ['S06','先用 product-understanding-zh-v1 分析USB小风扇，再用 marketing-brief-zh-v1 整理营销Brief，最后用 video-script-zh-v1 写宣传脚本，合成一份文字文档，不要生成视频。','text',{methods:['product-understanding-zh-v1','marketing-brief-zh-v1','video-script-zh-v1']}],
  ['S07','帮我调用一个叫超级电影导演的技能，写一个咖啡广告脚本。','unsupported_or_text']
 ],
 [
  ['C01','做一份新开咖啡店的宣传方案：三个创意方向、推荐一个、展开成15秒脚本，再给三条封面标题。不要图片和视频文件。','text'],
  ['C02','产品是USB桌面风扇，价格未知。面向学生，先分析卖点，再给两个短视频方向，选第二个写10秒脚本。只交付一份文档。','text'],
  ['C03','先写一个咖啡店视频脚本，等我确认后再生成视频。','approval'],
  ['C04','改成竖屏，10秒，暂时别开始生成。','approval',{previous:'C03'}],
  ['C05','先不做咖啡店了，给一个书店写宣传文案。','text',{previous:'C03'}],
  ['C06','帮我把这张图片背景去掉，只留下商品。','missing'],
  ['C07','帮我把之前的视频加上中文字幕，不改原画面。','missing_or_unsupported'],
  ['C08','做一个5秒横屏视频：咖啡杯放在窗边，镜头缓缓推进。','video_boundary']
 ],
 [
  ['I01','生成一张白色陶瓷咖啡杯的产品图，浅灰背景，不要文字。','real_image',{realImage:true}],
  ['I02','把刚才那张杯子图片背景改成木质桌面，保留杯子。','real_edit',{previous:'I01',realImage:true}],
  ['I03','给刚才这款杯子写两句小红书标题，不要再生成图片。','text',{previous:'I02'}],
  ['I04','生成一张蓝色运动鞋的电商产品图，白背景，单只鞋，没有文字。','real_image',{realImage:true}],
  ['I05','根据这张精油图写一段图生视频提示词，镜头缓缓绕瓶子转动。只给提示词。','text',{source:true}],
  ['I06','把这张精油图背景换成大理石台面，瓶子不动。','image_boundary',{source:true}],
  ['I07','帮我看看这张精油图片里有什么。','observe',{source:true}],
  ['I08','生成两张咖啡海报，一张暖色一张冷色，别加文字。','image_boundary']
 ]
];
if(process.argv.includes('--repeat-only')){
 const selected=groups.flat().filter(c=>['B01','S03','C02','I06'].includes(c[0]));
 groups.splice(0,groups.length,...selected.map(c=>Array.from({length:3},(_,n)=>[c[0]+'-R'+(n+1),...c.slice(1)])));
}
const definitions=groups.flat().map(([id,query,expected,options={}])=>({id,query,expected,...options}));
await writeFile(dir+'/cases.json',JSON.stringify(definitions,null,2));
const pass=()=>({passed:true,uncertain:false,issues:[],evaluationPolicy:'procedure_only_not_quality'});
async function run(c){
 const state=c.previous?structuredClone(states.get(c.previous)):{id:randomUUID(),messages:[],events:[]};
 state.modelCalls=[];state.events=[];const start=Date.now(),tools=[],receipts=[],boundaries=[],checks=[];let final;
 if(c.source){const a=original.taskStore.artifacts['50ff2e7f-9945-46a9-afaa-b7b2df41fe76'];state.assets=[{assetId:a.id,kind:'image',url:a.url,source:'user'}];}
 const brain=createBrain();
 const block=kind=>async args=>{boundaries.push({kind,args});throw new Error('EVAL_BOUNDARY：未提交媒体生成');};
 let localSubmissions=0;
 const media={config,image:async(args,signal)=>{
  if(!c.realImage)return block('image')(args);
  if(localSubmissions>=1||imageSubmissions>=imageLimit)return block('image_budget')(args);
  localSubmissions++;imageSubmissions++;const entry={kind:'image',args,startedAt:new Date().toISOString()};receipts.push(entry);
  try{entry.result=await ark.image(args,signal);entry.status='returned';return entry.result;}catch(e){entry.status='error';entry.error=e.message;throw e;}
 },video:block('video'),getVideo:block('video_query')};
 const runtime=new ToolRuntime({catalog,brain,media,extended:{capabilities:()=>({}),submit:block('extended')}}),execute=runtime.execute.bind(runtime);
 runtime.execute=async(name,args,...rest)=>{const entry={name,args};tools.push(entry);try{entry.result=await execute(name,args,...rest);entry.status='returned';return entry.result;}catch(e){entry.error=e.message;entry.status='error';throw e;}};
 const verifier={verifyPlan:async()=>pass(),verifyText:async(item,text)=>text?.trim()?pass():{passed:false,uncertain:false,issues:['empty_text']},verifyArtifact:async(item,a)=>a.url?pass():{passed:false,uncertain:true,issues:['missing_media_url']}};
 const output={case:c,verificationPolicy:'仅检查正文非空、产物URL及运行时合同；跳过主观/内容质量验收，不代表生成效果或约束合格。生产验收代码未修改。',tools,receipts,boundaries,state};
 const agent=new Agent({catalog,brain,runtime,verifier,save:async()=>{}});
 try{await agent.run(state,c.query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(150000));}catch(e){output.error=e.message;}
 const turn=state.turns?.at(-1),task=state.taskStore?.tasks[turn?.taskId],items=task?.items||[],calls=state.modelCalls;
 const check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
 check('final_response',!!final,final?.status);check('model_transport',calls.every(c=>c.status==='returned'),calls.filter(c=>c.status!=='returned').map(c=>c.error));
 const normal=c.expected==='approval'?task?.status==='WAIT_CONFIRM':c.expected.startsWith('missing')?task?.status==='NEEDS_INPUT'||(c.expected.includes('unsupported')&&task?.recovery?.kind==='unsupported'):c.expected.endsWith('boundary')?boundaries.some(b=>b.kind===(c.expected.startsWith('video')?'video':'image')):c.expected==='unsupported_or_text'?['completed','needs_input'].includes(final?.status):final?.status==='completed';
 check('expected_workflow',normal,{status:final?.status,taskStatus:task?.status,reason:task?.reason,turnError:turn?.error});
 if(c.expected==='text')check('no_media_effects',!receipts.length&&!boundaries.length,{});
 if(c.methods)check('explicit_method_order',JSON.stringify(items.flatMap(i=>i.methods||[]).map(m=>m.skillId))===JSON.stringify(c.methods),{expected:c.methods,actual:items.flatMap(i=>i.methods||[]).map(m=>m.skillId)});
 if(c.id==='C02'||c.id.startsWith('C02-R'))check('selected_direction_binding',items.flatMap(i=>i.methods||[]).flatMap(m=>m.input?.sources||[]).some(s=>s.selectedDirection?.index===2),{expectedIndex:2,note:'选择第二个方向须有真实前序方向产物绑定，不能只检查最终有文字。'});
 if(c.realImage){check('image_receipt',receipts.length===1&&receipts[0].result?.images?.length>0,receipts.map(r=>({status:r.status,error:r.error})));if(c.expected==='real_edit')check('edit_reference',items.some(i=>i.operation==='edit_image')&&tools.some(t=>['edit_image','generate_image'].includes(t.name))&&!!receipts[0]?.args?.referenceImages?.length,{tools:tools.map(t=>t.name),referenceCount:receipts[0]?.args?.referenceImages?.length,note:'compiled-v1 的图片生成与编辑共用 generate_image 底层工具，通过 referenceImages 区分；不能仅凭工具名称判错。'});}
 if(c.expected==='observe')check('image_observation',calls.some(c=>c.input.flatMap(m=>Array.isArray(m.content)?m.content:[]).some(p=>p.type==='input_image')),{actualImageInputs:calls.flatMap(c=>c.input).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='input_image').length});
 output.final=final;output.checks=checks;output.summary={id:c.id,query:c.query,expected:c.expected,passed:checks.every(c=>c.ok),status:final?.status,reason:task?.reason||turn?.error||output.error,failedChecks:checks.filter(c=>!c.ok),calls:calls.length,retries:calls.flatMap(c=>(c.validations||[]).filter(v=>v.accepted===false)).length,methods:items.flatMap(i=>i.methods||[]).map(m=>m.skillId),operations:items.map(i=>i.operation),realImageSubmissions:receipts.length,realImageReceipts:receipts.filter(r=>r.result?.images?.length).length,boundaries:boundaries.map(b=>b.kind),durationMs:Date.now()-start};
 states.set(c.id,state);results.push(output.summary);await writeFile(dir+'/'+c.id+'.json',JSON.stringify(redact(output),null,2));console.log(JSON.stringify(output.summary));
}
// Two independent conversation workers; each multi-turn chain remains ordered.
let next=0;async function worker(){while(next<groups.length){const group=groups[next++];for(const [id,query,expected,options={}] of group)await run({id,query,expected,...options});}}
await Promise.all([worker(),worker()]);
await writeFile(dir+'/summary.json',JSON.stringify({createdAt:new Date().toISOString(),qualityGate:'bypassed_in_test_only',actualImageSubmissions:imageSubmissions,actualVideoSubmissions:0,results:results.sort((a,b)=>a.id.localeCompare(b.id))},null,2));
