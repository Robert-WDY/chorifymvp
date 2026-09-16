import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createBrain} from '../server/adapters.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {currentTask} from '../server/task-state.mjs';
const directory='data/architecture-smoke-'+(process.argv[2]||'01');await mkdir(directory,{recursive:true});
const catalog=await loadCatalog();
const cases=[
 {id:'facts',queries:['你现在有什么工具和 Skill？列出真实名字，以及生成图片和视频是否已实现。','把图片换白底用什么真实工具，参数 Schema 是什么，实际多少钱？只查询，不生成。']},
 {id:'stages',queries:['产品是桌面加湿器，已知事实：USB供电、白色、适合桌面；容量、噪音未知。只输出文字，不生成媒体，不反问。按顺序实际使用 product-understanding-zh-v1 做商品理解，marketing-brief-zh-v1 输出营销Brief，direction-designer-zh-v1 给3个创意方向，最后基于第2个方向用 storyboard-one-shot-zh-v2 写15秒脚本，5个镜头，每镜头3秒。']},
 {id:'new_after_blocked',queries:['把这段视频里的背景换成白色，其他不变：https://fixtures.invalid/source.mp4','产品是便携水杯，已知红色、容量500毫升，保温性能未知。实际使用 product-understanding-zh-v1 做商品理解，marketing-brief-zh-v1 输出Brief，direction-designer-zh-v1 给3个方向。只要文字。']},
 {id:'media_controls',queries:['生成一张熊猫图片，1:1。','把刚才熊猫图的背景改成室内，再给我一张，熊猫不变。']},
 {id:'two_images',queries:['生成两张独立图片：第一张白色杯子、红色背景，第二张绿色瓶子、米白色背景。都是1:1，不要人物和文字。']},
 {id:'quote_revision',queries:['我要一张白色杯子的广告图片，1:1。先给文字方案和实际报价，我确认后再生成。','取消方案、报价和确认环节，直接生成这张白色杯子图片，保持1:1。']},
];
cases.push({id:'stages_document',queries:[cases.find(c=>c.id==='stages').queries[0]+' 最终合并成一份完整文档，内部仍按上述顺序逐阶段执行，不要交付四个独立文件。']});
const selected=process.argv[3]?.split(',');
await Promise.all(cases.filter(c=>!selected||selected.includes(c.id)).map(async c=>{
 const state={id:randomUUID(),messages:[],events:[]},submissions=[],brain=createBrain();
 const media={config:{imageModel:'simulation',videoModel:'simulation'},image:async args=>{submissions.push(structuredClone(args));return {status:'succeeded',images:[{url:'https://fixtures.invalid/'+randomUUID()+'.png',size:args.size}],simulated:true};},video:async()=>{throw new Error('unexpected video submission');}};
 const runtime=new ToolRuntime({catalog,brain,media}),verifier={verifyPlan:async()=>({passed:true,issues:[],qualitySkipped:true}),verifyText:async()=>({passed:true,issues:[],qualitySkipped:true}),verifyArtifact:async()=>({passed:true,issues:[],qualitySkipped:true})};
 const agent=new Agent({brain,runtime,catalog,verifier,simulation:true,save:async()=>{}}),turns=[];
 for(const query of c.queries){await agent.run(state,query,()=>{},AbortSignal.timeout(240000));const t=currentTask(state);turns.push({query,status:state.lastTurn?.status,taskId:t?.id,reason:t?.reason,items:t?.items.map(i=>({operation:i.operation,count:i.count,spec:i.spec,status:i.status,methods:i.methods.map(m=>m.skillId)})),submissions:submissions.length});await writeFile(directory+'/'+c.id+'.json',JSON.stringify({turns,submissions,state},null,2));console.log(JSON.stringify({id:c.id,...turns.at(-1)}));}
}));
