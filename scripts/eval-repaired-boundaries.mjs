import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {createBrain} from '../server/adapters.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {redact} from '../server/trace-context.mjs';
const dir=process.argv[2]||'data/boundary-repair-live-20260914';await mkdir(dir,{recursive:true});
const catalog=await loadCatalog(),all=[
 {id:'greeting',query:'你好，简单介绍一下你能帮我做什么。',expected:'completed'},
 {id:'titles',query:'给一款白色陶瓷咖啡杯写两句小红书标题，只要标题，不要视频脚本，也不要生成图片。',expected:'completed'},
 {id:'747',query:'根据波音747生成宣传的视频脚本。',expected:'completed'},
 {id:'directions',query:'产品是USB桌面风扇，价格未知。面向学生，先分析卖点，再给两个短视频方向，选第二个写10秒脚本。只交付一份文档。',expected:'completed'},
 {id:'ideas',query:'我想宣传一家咖啡店，你先给我一些思路。',expected:'completed'},
 {id:'missing',query:'帮我把这张图片背景去掉，只留下商品。',expected:'needs_input'},
 {id:'unknown',query:'用一个叫super-director的Skill写两句咖啡广告文案。',expected:'blocked'},
 {id:'approval',query:'先写一个咖啡店视频脚本，等我确认后再生成视频。',expected:'needs_input'},
 {id:'revision',previous:'approval',query:'改成竖屏，10秒，暂时别开始生成。',expected:'needs_input'},
];
const selected=process.argv[3]?.split(','),cases=selected?all.filter(c=>selected.includes(c.id)):all,states=new Map(),results=[];
for(const c of cases){
 const state=c.previous&&states.has(c.previous)?structuredClone(states.get(c.previous)):{id:randomUUID(),messages:[],events:[]};state.modelCalls=[];state.events=[];
 const brain=createBrain(),tools=[],boundaries=[];let final;
 const deny=kind=>async args=>{boundaries.push({kind,args});throw Object.assign(new Error('TEST_BOUNDARY_NO_MEDIA_SUBMISSION'),{uncertain:false});};
 const runtime=new ToolRuntime({catalog,brain,media:{config:{imageModel:'boundary-only',videoModel:'boundary-only'},image:deny('image'),video:deny('video'),getVideo:deny('video_query')},extended:{capabilities:()=>({}),submit:deny('extended')}});
 const execute=runtime.execute.bind(runtime);runtime.execute=async(name,args,...rest)=>{const t={name,args};tools.push(t);try{t.result=await execute(name,args,...rest);t.status='returned';return t.result;}catch(e){t.status='error';t.error=e.message;throw e;}};
 const agent=new Agent({catalog,brain,runtime,verifier:new Verifier(brain),save:async()=>{}});
 let error;try{await agent.run(state,c.query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(210000));}catch(e){error=e.message;}
 states.set(c.id,state);const turn=state.turns?.at(-1),task=state.taskStore?.tasks[turn?.taskId],artifacts=Object.values(state.taskStore?.artifacts||{}).filter(a=>a.taskId===task?.id&&a.purpose==='deliverable');
 const checks={final:!!final,transport:state.modelCalls.every(c=>c.status==='returned'),expectedStatus:final?.status===c.expected,noMediaSubmission:boundaries.length===0};
 if(c.id==='titles')checks.noExtraScriptMethod=!task?.items.some(i=>i.requiredMethods?.includes('video-script-zh-v1'));
 if(c.id==='directions')checks.selectedSource=task?.items.some(i=>i.methods.some(m=>m.input?.sources?.some(s=>s.selectedDirection?.index===2)))||false;
 if(c.id==='revision'){checks.futureVideo=task?.items.some(i=>i.output==='video');checks.approval=task?.approval?.required;}
 const summary={id:c.id,status:final?.status,taskStatus:task?.status,passed:Object.values(checks).every(Boolean),calls:state.modelCalls.length,reason:task?.reason||turn?.error||error,methods:task?.items.flatMap(i=>i.requiredMethods||[]),checks};
 await writeFile(dir+'/'+c.id+'.json',JSON.stringify(redact({case:c,policy:'real_text_verifier_no_media_submission',state,tools,boundaries,artifacts,final,error,summary}),null,2));results.push(summary);console.log(JSON.stringify(summary));
 await writeFile(dir+'/summary.json',JSON.stringify({createdAt:new Date().toISOString(),actualMediaSubmissions:0,qualityVerifier:'real',results},null,2));
}
