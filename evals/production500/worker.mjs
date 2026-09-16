import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Agent} from '../../server/agent.mjs';
import {createBrain} from '../../server/adapters.mjs';
import {ToolRuntime} from '../../server/tools.mjs';
import {ProviderError} from '../../server/media.mjs';
import {Verifier} from '../../server/verification.mjs';
import {loadCatalog} from '../../server/catalog.mjs';
import {SessionStore} from '../../server/session-store.mjs';
import {currentTask,taskArtifacts,storeOf,transition} from '../../server/task-state.mjs';
const [directory,phase='initial']=process.argv.slice(2),c=JSON.parse(await readFile(join(directory,'case.json'),'utf8'));
const persistence=new SessionStore(join(directory,'sessions')),journal=join(directory,'trace.json');
let trace=phase==='resume'?JSON.parse(await readFile(journal,'utf8')):{calls:[],submissions:[],snapshots:[],provider:{jobs:{},faults:[],polls:0},state:{id:randomUUID(),messages:[{role:'user',content:'业务上下文（任务资料；本轮明确Query优先，不代表已有素材或已执行的任务）：\n'+JSON.stringify(c.businessContext)}],events:[]}};
let state=phase==='resume'?await persistence.load(trace.state.id):trace.state;
trace.state=state;trace.processes??=[];trace.processes.push({pid:process.pid,phase,at:new Date().toISOString()});
await mkdir(directory,{recursive:true});
const flush=()=>writeFile(journal,JSON.stringify(trace,null,2));
const base=createBrain();
const brain={respond:async(input,tools,signal,options)=>{const started=Date.now(),call={input:structuredClone(input),tools:tools.map(t=>t.name),at:new Date().toISOString()};trace.calls.push(call);try{call.output=await base.respond(input,tools,signal,options);return call.output;}catch(e){call.error=e.message;throw e;}finally{call.durationMs=Date.now()-started;call.metrics=base.lastCall;await flush();}}};
async function submit(tool,args){
 const task=currentTask(state),node=task.executionPlan.nodes.find(n=>n.kind==='media'&&task.batches[n.batchId]?.items.some(i=>JSON.stringify(i)===JSON.stringify(args)));
 trace.submissions.push({tool,args:structuredClone(args),at:new Date().toISOString(),taskId:task.id,skillArtifactId:node?.skillArtifactId,completedItemIds:task.items.filter(i=>i.status==='COMPLETED').map(i=>i.id)});
 if(c.fault==='unknown'||c.fault==='known'&&trace.submissions.length===1){trace.provider.faults.push(c.fault);await flush();throw new ProviderError('Injected '+c.fault+' submission failure',c.fault==='unknown');}
 const id=c.id+'-'+trace.submissions.length;
 if(tool==='generate_image')return{status:'succeeded',images:[{url:'https://fixtures.invalid/'+id+'.png',size:args.size}],simulated:true};
 trace.provider.jobs[id]={status:'succeeded',taskId:id,videoUrl:'https://fixtures.invalid/'+id+'.mp4',simulated:true};await flush();return{status:'queued',taskId:id,simulated:true};
}
const media={config:{imageModel:'simulation',videoModel:'simulation'},image:args=>submit('generate_image',args),video:args=>submit('generate_video',args),getVideo:async id=>{trace.provider.polls++;if(c.fault==='poll'&&!trace.provider.faults.includes('poll')){trace.provider.faults.push('poll');await flush();throw new Error('Injected polling timeout');}if(!trace.provider.jobs[id])throw new Error('Unknown provider receipt');return trace.provider.jobs[id];}};
const catalog=await loadCatalog(),runtime=new ToolRuntime({catalog,brain,media});
let checkpointSent=false;
const agent=new Agent({brain,catalog,runtime,verifier:new Verifier(brain),simulation:true,save:async s=>{
 await persistence.save(s);
 if(c.restart&&phase==='initial'&&!checkpointSent){const execution=Object.values(storeOf(s).executions).find(e=>e.status==='submitted'&&e.providerTaskId);if(execution){checkpointSent=true;trace.restart={beforePid:process.pid,taskId:currentTask(s).id,providerTaskId:execution.providerTaskId};await flush();process.send?.({type:'checkpoint',...trace.restart});await new Promise(()=>{});}}
}});
const run=async(query,control={})=>{await agent.run(state,query,()=>{},AbortSignal.timeout(240000),control);await persistence.save(state);await flush();};
const drain=async()=>{for(let i=0;i<3&&state.status==='waiting';i++)await run('继续查询已提交的任务',{resumeTaskId:currentTask(state).id});};
try{
 if(phase==='resume'){trace.restart.afterPid=process.pid;trace.restart.killed=true;await run('从持久回执恢复',{resumeTaskId:currentTask(state).id});await drain();}
 else for(let i=0;i<c.queries.length;i++){
  await run(c.queries[i]);await drain();
  trace.snapshots.push({query:c.queries[i],task:structuredClone(currentTask(state)),submissionCount:trace.submissions.length,artifacts:structuredClone(taskArtifacts(state)),stateStatus:state.status});
  if(i===0&&c.fixture==='reject-draft'){
   const a=taskArtifacts(state).find(a=>a.type==='video'&&a.purpose==='deliverable');
   if(a){a.verification={technical:'passed',semantic:'failed',issues:['Fixture:草稿背景未符合白色棚拍要求']};const t=currentTask(state);t.items.find(i=>i.id===a.itemId).issues=a.verification.issues;transition(state,'PARTIAL','Fixture:渲染草稿验收失败');trace.fixtureMutation={artifactId:a.id,before:'simulated_passed',after:'failed',reason:'controlled content rejection',task:structuredClone(t)};await persistence.save(state);}
  }
  await flush();
 }
 if(c.resume&&currentTask(state)){await run('恢复原任务',{resumeTaskId:currentTask(state).id});await drain();}
}catch(e){trace.harnessError={message:e.message,stack:e.stack};process.exitCode=1;}
await flush();process.send?.({type:'done'});process.disconnect?.();
