import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {createBrain} from '../server/adapters.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {redact} from '../server/trace-context.mjs';
const dir='data/general-context-repair-20260914',source=JSON.parse(await fs.readFile(dir+'/before/session.json','utf8')),catalog=await loadCatalog();
const files=(await fs.readdir('server')).filter(f=>f.endsWith('.mjs'));
const version=await Promise.all(files.map(async f=>({file:f,sha256:createHash('sha256').update(await fs.readFile('server/'+f)).digest('hex')})));
const prefix=n=>{
 const s=structuredClone(source),cut=s.messages.map((m,i)=>m.role==='user'?i:-1).filter(i=>i>=0)[n];
 s.id=randomUUID();s.messages=s.messages.slice(0,cut);s.turns=s.turns.slice(0,n);
 const runs=new Set(s.turns.map(t=>t.runId)),tasks=new Set(s.turns.map(t=>t.taskId).filter(Boolean));
 s.events=s.events.filter(e=>runs.has(e.runId));s.modelCalls=[];
 s.taskStore.tasks=Object.fromEntries(Object.entries(s.taskStore.tasks).filter(([id])=>tasks.has(id)));
 s.taskStore.artifacts=Object.fromEntries(Object.entries(s.taskStore.artifacts).filter(([,a])=>tasks.has(a.taskId)));
 for(const key of ['executions','toolCalls'])s.taskStore[key]=Object.fromEntries(Object.entries(s.taskStore[key]||{}).filter(([,e])=>!e.taskId||tasks.has(e.taskId)));
 s.taskStore.activeTaskId=s.turns.at(-1)?.taskId;s.lastTurn=s.turns.at(-1);s.status='completed';
 return s;
};
const cases=[
 {id:'history-original',n:1,query:'你上一轮的回答是什么',kind:'history'},
 {id:'history-unseen',n:1,query:'请把紧挨着我这条消息之前、由你发出的那段内容照抄给我。',kind:'history'},
 {id:'image-opinion',n:4,query:'你觉得这张图片怎么样',kind:'observe'},
 {id:'image-unseen',n:4,query:'刚才那幅作品在光线和构图上有何优缺点？只给点评。',kind:'observe'},
 {id:'image-analysis',n:4,query:'你分析这张图片',kind:'observe'},
 {id:'local-revise',n:9,query:'只把主标题改成“航空产品传播方案”，正文其他内容保持原样。',kind:'patch'},
 {id:'failed-followup',n:6,query:'图片',kind:'observe'},
 {id:'revise-original',n:9,query:'军用飞机，发布平台为抖音',kind:'revise'},
];
const selected=process.argv[2]?.split(','),batch=process.argv[3]||'live',rows=[];let requests=0;
for(const c of cases.filter(c=>!selected||selected.includes(c.id))){
 const state=prefix(c.n),start=state.turns.length,boundaries=[];
 const brain=createBrain(process.env,async(url,options)=>{if(++requests>60)throw Error('EVALUATION_REQUEST_BUDGET');return fetch(url,options);});
 const deny=name=>async args=>{boundaries.push({name,args});throw Error('EVALUATION_NO_MEDIA_SUBMISSION');};
 const runtime=new ToolRuntime({catalog,brain,media:{config:{imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL},image:deny('image'),video:deny('video'),getVideo:deny('video_poll')},extended:{capabilities:()=>({}),submit:deny('extended')}});
 const actual=runtime.execute.bind(runtime);runtime.execute=async(name,...args)=>{if(!['analyze_image','read_skill','use_skill','find_skill','search_skill_references'].includes(name))return deny(name)(args[0]);return actual(name,...args);};
 let final,error;const agent=new Agent({brain,runtime,catalog,verifier:new Verifier(brain),save:async()=>{}});
 try{await agent.run(state,c.query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(240000));}catch(e){error=e.message;}
 const turn=state.turns[start],task=state.taskStore.tasks[turn?.taskId],calls=state.modelCalls,toolCalls=Object.values(state.taskStore.toolCalls).filter(t=>t.runId===turn?.runId);
 const checks={normalFinal:final?.status==='completed',noMediaSubmission:boundaries.length===0,modelTransport:calls.every(c=>c.status==='returned')};
 if(c.kind==='history')checks.exactPriorReply=final?.text===source.messages.find(m=>m.role==='assistant').content[0].text;
 if(c.kind==='observe'){checks.correctOperation=task?.items.some(i=>i.requiredEvidence==='image'&&i.operation==='analyze_image');checks.realVision=toolCalls.some(t=>t.name==='analyze_image'&&t.result?.text);checks.observationPassedToWriter=calls.some(c=>{try{return JSON.parse(c.input.at(-1).content).observations?.some(o=>o.result?.text);}catch{return false;}});}
 if(c.kind==='patch'){checks.exactLocalEdit=Object.values(state.taskStore.artifacts).some(a=>a.taskId===task?.id&&a.publication==='current'&&a.content===Object.values(source.taskStore.artifacts).find(a=>a.id==='2be75826-b078-416d-aa35-a1baee01ed65').content.replace('# 飞机产品宣传文案方案','# 航空产品传播方案'));}
 if(c.kind==='revise'){checks.revision=task?.items.some(i=>i.changeContract?.source);checks.rewrite=calls.some(c=>c.output?.some(m=>{try{return JSON.parse(m.content?.[0]?.text).mode==='rewrite';}catch{return false;}}));checks.publishedVersion=Object.values(state.taskStore.artifacts).some(a=>a.taskId===task?.id&&a.version>1&&a.publication==='current');}
 const row={...c,passed:Object.values(checks).every(Boolean),checks,status:final?.status,calls:calls.length,reason:turn?.error||task?.reason||error,final:final?.text,version,boundaries};
 rows.push(row);await fs.writeFile(dir+'/'+batch+'-'+c.id+'.json',JSON.stringify(redact({row,state}),null,2));await fs.writeFile(dir+'/'+batch+'-results.json',JSON.stringify(redact({requests,rows}),null,2));console.log(JSON.stringify({id:c.id,passed:row.passed,status:row.status,calls:row.calls,checks,reason:row.reason}));
}
