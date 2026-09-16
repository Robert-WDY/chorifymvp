import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Doubao} from '../server/adapters.mjs';
import {Agent} from '../server/agent.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog,systemPrompt} from '../server/catalog.mjs';
import {ProviderError} from '../server/media.mjs';
import {intentPrompt,planningPrompt} from '../server/intent.mjs';
import {scoreCase,auditDataset,operationAliases} from './benchmark-v2-scoring.mjs';
const source=new URL('../../benchmark-agent-loop-v2-200/benchmark_v2.json',import.meta.url);
const sourceBytes=await readFile(source),cases=JSON.parse(sourceBytes);
if(cases.length!==200||new Set(cases.map(c=>c.id)).size!==200)throw new Error('Expected exactly 200 unique case IDs');
const root=new URL('../data/benchmark-v2-200/',import.meta.url);
await mkdir(root,{recursive:false});await mkdir(new URL('runs/',root));await copyFile(source,new URL('source.json',root));
const catalog=await loadCatalog(),hash=x=>createHash('sha256').update(x).digest('hex');
const frozenFiles=['server/agent.mjs','server/intent.mjs','server/catalog.mjs','server/adapters.mjs','server/tools.mjs','server/tool-schemas.mjs','server/media.mjs','server/extended-media.mjs','server/script-runner.mjs','evals/run-benchmark-v2.mjs','evals/benchmark-v2-scoring.mjs'];
const sourceHashes=Object.fromEntries(await Promise.all(frozenFiles.map(async p=>[p,hash(await readFile(new URL('../'+p,import.meta.url)))])));
const metadata={startedAt:new Date().toISOString(),model:process.env.DOUBAO_CHAT_MODEL,sourceHash:hash(sourceBytes),sourceHashes,concurrency:6,maxAgentSteps:16,caseDeadlineMs:360000,
 mode:'200-real-doubao-full-agent-loops-local-skills-simulated-media-original-inputs',historyAdaptation:'Each original history string becomes one assistant message; no invented assets, URLs, prior tasks or plans.',
 inputsExclude:['expected','category','scene','test_focus'],operationAliases,audit:auditDataset(cases),
 systemPrompt:systemPrompt(catalog),intentPrompt:intentPrompt(catalog),planningPrompt:planningPrompt(catalog)};
await writeFile(new URL('metadata.json',root),JSON.stringify(metadata,null,2));
let cursor=0,finished=0;const results=[];
async function run(c){
 const started=Date.now(),modelCalls=[];let previousInput=[];
 const base=new Doubao({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL,model:process.env.DOUBAO_CHAT_MODEL});
 const brain={respond:async(input,tools,signal,options)=>{
  const snapshot=structuredClone(input);let prefix=0;while(prefix<previousInput.length&&prefix<snapshot.length&&JSON.stringify(previousInput[prefix])===JSON.stringify(snapshot[prefix]))prefix++;
  const record={index:modelCalls.length,startedAt:new Date().toISOString(),phase:input[0]?.content?.startsWith('你是创作助手的需求理解器')?'understand':input[0]?.content?.startsWith('你是能力选择器')?'select_capabilities':'execution',inputPrefixLength:prefix,inputSuffix:snapshot.slice(prefix),toolNames:tools.map(t=>t.name||t.type),options};
  previousInput=snapshot;modelCalls.push(record);const begin=Date.now();
  try{const output=await base.respond(input,tools,signal,options);record.output=structuredClone(output);return output;}catch(e){record.error=e.message;throw e;}finally{record.durationMs=Date.now()-begin;}
 }};
 const state={id:'bench-'+c.id,messages:c.history.map(content=>typeof content==='string'?{role:'assistant',type:'message',content:[{type:'output_text',text:content}]}:content),assets:[]};
 const known=new Set(),videoTasks=new Map();let serial=0;
 const requireKnown=urls=>{for(const url of urls||[])if(!known.has(url))throw new ProviderError('评测没有提供该素材：不可用虚构地址进行模拟处理',false);};
 const media={config:{imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL},
  image:async args=>{requireKnown(args.referenceImages);const url=`https://benchmark.invalid/${c.id}/image-${++serial}.png`;known.add(url);return{status:'succeeded',images:[{url}],simulated:true};},
  video:async args=>{if(args.firstFrameUrl)requireKnown([args.firstFrameUrl]);const taskId=`bench-${c.id}-video-${++serial}`;videoTasks.set(taskId,{taskId,status:'succeeded',videoUrl:`https://benchmark.invalid/${c.id}/${taskId}.mp4`,simulated:true});return{taskId,status:'queued',simulated:true};},
  getVideo:async taskId=>{const task=videoTasks.get(taskId);if(!task)throw new ProviderError('评测不存在该任务',false);known.add(task.videoUrl);return task;}};
 const serviceNames=['generate_voiceover','clone_voice','propose_lipsync','slice_video','propose_video_upscale','propose_video_replication','merge_videos','analyze_video'];
 const extended={capabilities:()=>Object.fromEntries(serviceNames.map(n=>[n,{configured:false,missing:['BENCHMARK_EXTERNAL_SERVICE']}])) ,submit:async()=>{throw new ProviderError('本次评测未配置该扩展服务',false);},query:async()=>{throw new ProviderError('本次评测没有该扩展任务',false);}};
 const runtime=new ToolRuntime({catalog,brain,media,extended,python:process.env.PYTHON_BIN});
 const execute=runtime.execute.bind(runtime);
 runtime.execute=async(name,args,...rest)=>{
  // No invented observations and no external searches in this media-isolated benchmark.
  if(['analyze_image','read_video','analyze_video'].includes(name))throw new ProviderError('评测源文件未附可读取的真实图片/视频，不能伪造视觉观察',false);
  if(name==='search_web')throw new ProviderError('本次隔离评测未启用联网搜索，不能冒充已检索',false);
  return execute(name,args,...rest);
 };
 let runnerError;
 try{await new Agent({brain,runtime,catalog,maxSteps:16}).run(state,c.query,()=>{},AbortSignal.timeout(metadata.caseDeadlineMs));}catch(e){runnerError=e.message;}
 const score=scoreCase(c,state),result={id:c.id,category:c.category,query:c.query,history:c.history,expected:c.expected,test_focus:c.test_focus,durationMs:Date.now()-started,modelCallCount:modelCalls.length,goal:state.goal,intakeError:state.events?.find(e=>e.type==='intent_error'),answer:state.events?.findLast(e=>e.type==='final')?.text,runnerError,...score};
 await writeFile(new URL('runs/'+c.id+'.json',root),JSON.stringify({result,state,modelCalls},null,2));
 results.push(result);finished++;
 console.log(JSON.stringify({id:c.id,finished,status:state.status,raw:result.rawPassed,compatible:result.compatiblePassed,tools:result.called.length,ms:result.durationMs}));
}
await Promise.all(Array.from({length:metadata.concurrency},async()=>{while(cursor<cases.length){const c=cases[cursor++];await run(c);}}));
results.sort((a,b)=>a.id.localeCompare(b.id));
const unchanged=Object.fromEntries(await Promise.all(frozenFiles.map(async p=>[p,sourceHashes[p]===hash(await readFile(new URL('../'+p,import.meta.url)))])));
await writeFile(new URL('results.json',root),JSON.stringify({metadata:{...metadata,finishedAt:new Date().toISOString(),unchanged},results},null,2));
console.log(JSON.stringify({finished,rawPassed:results.filter(r=>r.rawPassed).length,compatiblePassed:results.filter(r=>r.compatiblePassed).length,statuses:Object.fromEntries([...new Set(results.map(r=>r.status))].map(s=>[s,results.filter(r=>r.status===s).length]))}));
