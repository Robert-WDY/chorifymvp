import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {createBrain,brainConfig,Doubao} from '../server/adapters.mjs';
import {ArkMedia} from '../server/media.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {SessionStore} from '../server/session-store.mjs';
import {redact} from '../server/trace-context.mjs';
import {tools} from '../server/tool-schemas.mjs';
import {mediaSkills} from '../server/media-skill-contracts.mjs';
import {capabilitySnapshot} from '../server/runtime-facts.mjs';
const out='data/complex-query-audit-20260915-'+new Date().toISOString().replace(/[:.]/g,'-');
fs.mkdirSync(out+'/sessions',{recursive:true});
let query=`请为虚构社区咖啡品牌「慢半拍」制作一套新品冷萃短视频创作包。已知事实只有：产品是无糖黑咖啡冷萃，透明无字杯、琥珀色咖啡、冰块；面向通勤上班族，在小红书发布；不提供价格、产地、咖啡因含量或功效信息，禁止编造减脂、提神效果和销量。
请在这一个请求中按依赖关系完成以下七项：
1. 产品理解文档：区分已知事实与创意假设。
2. 基于产品理解写营销 Brief，包括受众、场景、核心信息和表达禁区。
3. 基于 Brief 提出三个不同创意方向，每个给开头钩子；明确推荐第一个方向「出门前，慢半拍」。
4. 只用第一个方向写一份8秒竖屏9:16视频脚本，不再新增方向。
5. 把该脚本写成四镜文字分镜，每镜2秒，含景别、画面、动作、转场和时长，总长8秒；不生成宫格图。
6. 根据第一镜生成一张9:16参考首帧图片：清晨窗边桌面上的透明无字杯、琥珀色冷萃、冰块，自然光，无人物、无文字、无Logo。
7. 使用刚生成的首帧图和四镜分镜，实际生成一条8秒9:16视频，保持杯子与饮品一致，无画面文字；不得用视频提示词冒充成片。
前五项分别保存为五份独立文字成果。直接执行，不需要等我选方向；最后列出七项交付状态和实际成果。若某一步失败，保留已完成成果，明确指出依赖阻塞，不编造媒体地址。`;
if(process.argv.includes('--text-control'))query=query.slice(0,query.indexOf('\n6.')).replace('以下七项','以下五项')+'\n本轮只做以上五项，分别保存为五份独立文字成果，不生成图片或视频。直接完成全部五项，不需要等我确认方向；只使用第一个方向。最后列出五项成果。';
if(process.argv.includes('--independent-control'))query='为虚构咖啡品牌「慢半拍」完成三个独立文字子任务，每项单独交付一份文档：第一，给无糖冷萃咖啡写三条小红书宣传文案，每条含标题、正文和行动建议，面向通勤上班族，三个角度分别为晨间仪式、午间休息、窗边独处；第二，写一个8秒9:16广告文字脚本，共四个镜头，每镜2秒，画面是自然光下透明无字杯里的琥珀色咖啡和冰块，无人物，不生图不生成视频；第三，审核以下广告原文并给出风险清单和一版更稳妥的替代文案：“每天一杯，七天瘦五斤，提神一整天，全网销量第一。”没有证据支持这些广告承诺，不把它们作为事实。所有新创作只依据无糖冷萃、透明杯、琥珀色咖啡和冰块这些产品信息，不编造价格、产地、营养和销量。三个子任务均直接完成，不需要确认。';
const catalog=await loadCatalog(),brain=createBrain();
const videoBrain=brain.config.provider==='deepseek'?new Doubao(brainConfig(process.env,'doubao')):brain;
const media=new ArkMedia({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL||'https://ark.cn-beijing.volces.com',imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL});
const receipts=[];
for(const name of ['image','video','getVideo']){const original=media[name].bind(media);media[name]=async(...args)=>{const row={name,startedAt:new Date().toISOString(),args:args[0]};receipts.push(row);try{return row.result=await original(...args);}catch(e){row.error=e.message;throw e;}finally{row.finishedAt=new Date().toISOString();fs.writeFileSync(out+'/media-receipts.json',JSON.stringify(redact(receipts),null,2));}};}
const runtime=new ToolRuntime({catalog,brain,media,python:process.env.PYTHON_BIN});
const sessions=new SessionStore(out+'/sessions'),state={id:randomUUID(),messages:[],events:[]};
const files=fs.readdirSync('server').filter(f=>f.endsWith('.mjs')).map(f=>({path:'server/'+f,sha256:createHash('sha256').update(fs.readFileSync('server/'+f)).digest('hex')}));
fs.writeFileSync(out+'/query.txt',query);
fs.writeFileSync(out+'/manifest.json',JSON.stringify({startedAt:new Date().toISOString(),mode:'real Agent, real configured model, real Ark media, direct Agent entry; no HTTP/UI test',sessionId:state.id,provider:brain.config.provider,model:brain.config.model,files,tools:tools.map(t=>({name:t.name,description:t.description})),mediaSkills,registry:capabilitySnapshot(runtime,catalog)},null,2));
console.log(JSON.stringify({out,sessionId:state.id,provider:brain.config.provider,model:brain.config.model}));
let final,error;const started=Date.now();
const agent=new Agent({brain,runtime,catalog,verifier:new Verifier(brain,{videoBrain}),save:s=>sessions.save(s)});
try{await agent.run(state,query,e=>{if(e.type==='final')final=e;if(['status','plan_progress','final','execution_plan'].includes(e.type))console.log(JSON.stringify({type:e.type,status:e.status,node:e.node?.id,nodeStatus:e.node?.status,text:e.type==='final'?e.text:undefined}));},AbortSignal.timeout(1200000));}catch(e){error=e.message;}
await sessions.save(state);
const tasks=Object.values(state.taskStore?.tasks||{}),artifacts=Object.values(state.taskStore?.artifacts||{});
const summary={finishedAt:new Date().toISOString(),durationMs:Date.now()-started,sessionId:state.id,error,final,tasks:tasks.map(t=>({id:t.id,status:t.status,reason:t.reason,items:t.items,executionPlan:t.executionPlan})),modelCalls:state.modelCalls?.length,failedModelCalls:state.modelCalls?.filter(c=>c.status==='failed').map(c=>({error:c.error,model:c.model})),artifacts:artifacts.map(a=>({id:a.id,type:a.type,purpose:a.purpose,publication:a.publication,verification:a.verification,content:a.content,relationships:a.relationships,metadata:a.metadata})),mediaReceipts:receipts.length};
fs.writeFileSync(out+'/summary.json',JSON.stringify(redact(summary),null,2));
fs.writeFileSync(out+'/trace.redacted.json',JSON.stringify(redact(state),null,2));
let n=0;for(const a of artifacts.filter(a=>a.type==='text'&&a.purpose==='deliverable'))fs.writeFileSync(out+'/'+String(++n).padStart(2,'0')+'-'+a.id+'.md',a.content||'');
fs.writeFileSync(out+'/final-answer.md',final?.text||error||'No final answer');
console.log(JSON.stringify({done:true,out,status:tasks.map(t=>t.status),modelCalls:state.modelCalls?.length,artifacts:artifacts.length,error}));
