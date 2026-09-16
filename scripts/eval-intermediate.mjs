import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {createBrain,brainConfig,Doubao} from '../server/adapters.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {ArkMedia,ProviderError} from '../server/media.mjs';
import {ExtendedMedia,extendedMediaNames} from '../server/extended-media.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {createTask,addArtifact,storeOf,projectState,requireApproval} from '../server/task-state.mjs';
import {acceptRevision} from '../server/task-contract.mjs';
import {redact,tracedBrain,withTrace} from '../server/trace-context.mjs';
const root=path.resolve('data/intermediate-eval-20260914'),base=path.resolve('data/focused-eval-v2-text-20260914');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const write=async(p,v,raw=false)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(raw?v:redact(v),null,2));};
const suite=await read(base+'/suite/cases.json'),catalog=await loadCatalog(),profile=await read(base+'/suite/config/profiles.json');
const textCases=profile.text_plan_first.case_ids,imageCases=['E01','E02','E03','E04','E05','E07'];
const runId=randomUUID(),limits={imagePosts:20,moneyCapCNY:20,reservationCNYPerPost:1,modelRequests:800,turnMs:300000};
let imagePosts=0,modelRequests=0;const records=[],boundaries=[],receipts=[],fixtures=new Map(),sessions=[];
if(await fs.stat(root+'/version.json').catch(()=>null))throw Error('Refuse overwrite');
const version=await read(base+'/version.json');const changed=[];for(const x of version.hashes)if(hash(await fs.readFile(x.file,'utf8'))!==x.sha256)changed.push(x.file);
// Compare bytes again, including any non-text catalog resource.
changed.length=0;for(const x of version.hashes)if(createHash('sha256').update(await fs.readFile(x.file)).digest('hex')!==x.sha256)changed.push(x.file);
if(changed.length)throw Error('Source drift: '+changed.join(','));
await write(root+'/version.json',{runId,startedAt:new Date().toISOString(),entry:'Agent.run; constructed intermediate fixtures bypass upstream intake ONLY; no production edits',sourceVersion:version,selected:{textCases,imageCases},limits,moneyNote:'Reserve CNY1 per single-image request. Actual invoice is unavailable; reservation is not measured billing. Configured Seedream4 model fixed; no provider fallback or multi-output request.',setupIsNotAgentPass:true});
const cfg=brainConfig(),vcfg=brainConfig(process.env,'doubao');
const allow=new Set([cfg.baseUrl.replace(/\/+$/,'').replace(/\/responses$/,'')+'/responses',new URL('/api/v3/responses',vcfg.baseUrl).href]);
const deny=(boundary,name,context,args)=>{const r={at:new Date().toISOString(),boundary,name,context,args};boundaries.push(r);throw new ProviderError('EVAL_FORBIDDEN_MEDIA:'+name,false);};
function runtimeFor(context){
 const transport=async(url,opt)=>{if(!allow.has(String(url)))return deny('model_transport',String(url),context,{});if(++modelRequests>limits.modelRequests)throw Error('EVAL_MODEL_CAP');const r={context,at:new Date().toISOString(),url:String(url),request:JSON.parse(opt.body)};try{const response=await fetch(url,opt);r.status=response.status;r.response=await response.clone().json().catch(()=>({unparsed:true}));return response;}catch(e){r.error=e.message;throw e;}finally{await fs.appendFile(root+'/model-transport.jsonl',JSON.stringify(redact(r))+'\n');}};
 const brain=createBrain(process.env,transport),videoBrain=cfg.provider==='deepseek'?new Doubao(vcfg,transport):brain;
 const media=new ArkMedia({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL||'https://ark.cn-beijing.volces.com',imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL},async(url,opt)=>{
  if(new URL(url).pathname!=='/api/v3/images/generations'||opt.method!=='POST')return deny('media_transport','video',context,{url});
  const body=JSON.parse(opt.body);if(body.model!==process.env.DOUBAO_IMAGE_MODEL||body.sequential_image_generation!=='disabled')throw new ProviderError('EVAL_IMAGE_PROTOCOL_CAP',false);
  if(imagePosts>=limits.imagePosts||(imagePosts+1)*limits.reservationCNYPerPost>limits.moneyCapCNY)throw new ProviderError('EVAL_IMAGE_BUDGET_EXHAUSTED',false);
  const rec={id:randomUUID(),postIndex:++imagePosts,context,startedAt:new Date().toISOString(),request:body};receipts.push(rec);await write(root+'/media-receipts.json',receipts);
  try{const response=await fetch(url,opt);rec.httpStatus=response.status;rec.response=await response.clone().json();return response;}catch(e){rec.error=e.message;throw e;}finally{rec.finishedAt=new Date().toISOString();await write(root+'/media-receipts.json',receipts);await write(root+'/private/media-receipts.json',receipts,true);}
 });
 const request=media.request.bind(media);media.request=async(p,...args)=>p==='/api/v3/images/generations'?request(p,...args):deny('provider_request','video',context,{path:p});
 const extended=new ExtendedMedia(process.env,{fetchImpl:async()=>deny('extended_transport','media',context,{})});extended.request=async()=>deny('extended_provider','media',context,{});
 const runtime=new ToolRuntime({catalog,brain,media,extended,python:process.env.PYTHON_BIN}),execute=runtime.execute.bind(runtime);
 runtime.execute=async(n,a,s,signal)=>{if(['generate_video','get_video_task','wait_video_task','get_media_task','wait_media_task',...extendedMediaNames].includes(n))return deny('tool',n,context,a);return execute(n,a,s,signal);};
 return {brain,media,runtime,verifier:new Verifier(brain,{videoBrain})};
}
const fresh=()=>({id:randomUUID(),messages:[],events:[],actions:{}});
const fields=spec=>Object.fromEntries(Object.entries({ratio:spec?.ratio,durationSeconds:spec?.duration_seconds,shotCount:spec?.shot_count,secondsPerShot:spec?.seconds_per_shot,directionCount:spec?.direction_count}).filter(([,v])=>v!==undefined));
function fixtureTask(state,query,slots){
 const tasks=slots.map(s=>({operation:s.type==='plan'?'generate_video':s.type==='image'?'generate_image':'answer',output:s.type==='plan'?'video':s.type,count:1,artifactCount:1,contentCardinality:1,references:s.sourceIds||[],dependsOn:[],constraints:[],requiredMethods:[],requiredEvidence:'none',spec:fields(s.spec)}));
 const goal={summary:query,tasks,skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow'},semantic:{summary:query,deliverables:slots.map((s,i)=>({description:s.description||query,kind:tasks[i].output,action:'create',references:tasks[i].references,dependsOn:[],constraints:[],requiredMethods:[]})),facts:[],globalConstraints:[],approval:{required:slots.some(s=>s.type==='plan')},continuation:{mode:'new',taskId:''}}};
 const task=createTask(state,goal,query);task.fixtureSetup={runId,bypassed:'intake_and_upstream_skill_execution',status:'constructed_not_scored'};acceptRevision(task,'fixture_'+randomUUID());return task;
}
async function sourceImage(key,prompt){
 if(fixtures.has(key))return fixtures.get(key);
 const pending=(async()=>{const env=runtimeFor('fixture:'+key),start=receipts.length;const result=await env.media.image({prompt,size:'2048x2048'},AbortSignal.timeout(150000));const img=result.images[0];const file=root+'/private/images/'+key+'.png';await fs.mkdir(path.dirname(file),{recursive:true});const response=await fetch(img.url,{signal:AbortSignal.timeout(45000)});if(!response.ok)throw Error('Cannot retrieve real fixture bytes');const bytes=Buffer.from(await response.arrayBuffer());await fs.writeFile(file,bytes);const info={key,prompt,url:img.url,size:img.size,file,sha256:hash(bytes),receiptId:receipts[start]?.id,createdBy:'real_ArkMedia_image',quality:'PENDING_REVIEW'};await write(root+'/fixtures/'+key+'.json',info);return info;})();fixtures.set(key,pending);return pending;
}
const imageSeeds={
 E01:[['bottle-orange','一张写实产品摄影，浅灰纯色背景，只有一个橙色圆柱瓶，瓶身无标志，正中完整呈现，1:1，无人无字。']],
 E02:[['cup-blue','写实产品摄影，深蓝色纯色背景，一只白色陶瓷杯正中完整呈现，1:1，无人无字。'],['bottle-orange']],
 E03:[['panda','一只熊猫坐在竹林里，插画，熊猫全身与坐姿清晰，1:1，没有人和文字。']],
 E04:[['chair-yellow','一把黄色椅子在白色背景中的产品图，1:1，椅子全貌清楚，无人无字。']],
 E05:[['cup-blue'],['cup-beige','写实产品摄影，米白背景，一只与参考图同杯型的纯白陶瓷杯正中完整呈现，1:1，无人无字。']],
 E07:[['apple','一个红苹果放在一只白盘子上，浅灰背景，1:1，写实摄影，没有文字。']]
};
async function installImages(state,c,aliases){
 const first=c.turns[0],specs=imageSeeds[c.id],slots=first.expected.produce_bindings,task=fixtureTask(state,first.user_query,slots);
 for(let i=0;i<slots.length;i++){const [key,desc]=specs[i],img=await sourceImage(key,desc||imageSeeds.E02.find(x=>x[0]===key)?.[1]||imageSeeds.E01[0][1]);const a=addArtifact(state,{itemId:task.items[i].id,type:'image',url:img.url,metadata:{fixtureSetup:true,fixtureKey:key,receiptId:img.receiptId,provider:{size:img.size},qualityNotScored:true}});a.publication='candidate';a.metadata.fixtureSetup=true;
  // Imported reference images are inputs, not falsely accepted generated artifacts.
  delete state.taskStore.artifacts[a.id];task.items[i].artifactIds=[];const input={id:a.id,assetId:a.id,kind:'image',type:'image',url:img.url,version:1,purpose:'input',metadata:a.metadata,source:'evaluation_fixture',sessionId:state.id};state.taskStore.inputs[a.id]=input;aliases[slots[i].alias]={id:a.id,version:1,type:'image',url:img.url,fixture:true};
 }
 task.items=[];task.status='COMPLETED';task.fixtureSetup.note='Input installation only; no successful upstream Agent/Skill execution claimed';state.messages.push({role:'user',content:first.user_query,fixtureSetup:true},{role:'assistant',type:'message',content:[{type:'output_text',text:'测试中间态已提供以下真实图片：'+slots.map(s=>s.description).join('；')}],fixtureSetup:true});projectState(state);
 records.push({case_id:c.id,turn_id:first.id,mode:'fixture_setup',executed:false,status:'SETUP_NOT_SCORED',setupKeys:specs.map(s=>s[0])});
}
async function installText(state,sourceTurn,aliases,env,save){
 const slots=sourceTurn.expected.produce_bindings.filter(b=>!aliases[b.alias]);if(!slots.length)return;
 const prior=Object.entries(aliases).map(([alias,v])=>({alias,...v,...(state.taskStore?.artifacts[v.id]?{content:state.taskStore.artifacts[v.id].content,structure:state.taskStore.artifacts[v.id].metadata?.structure}:{})}));
 const fixtureState=fresh();fixtureState.currentRunId='fixture_'+sourceTurn.id;const fb=tracedBrain(env.brain);
 const input=[{role:'system',content:'你负责构建可复核的测试前置素材，不是被测Agent。只完成给出的历史请求，不预测下一轮。不要声称执行Skill、工具或验收。返回JSON {outputs:[{alias,content,structure?,parameters?}]}，每个slot对应一份真实完整文字。方向需要structure.directions数组每项含title/angle/reason/scenes/hook；分镜需要structure.shots数组每项content/durationSeconds及structure.durationSeconds。plan需要parameters:{prompt,duration,ratio,resolution}，只是待确认参数，绝不生成媒体。已有来源必须沿用，只做历史请求要求的变更。不要编造未给的产品事实。'}, {role:'user',content:JSON.stringify({historicalQuery:sourceTurn.user_query,existingSources:prior,slots:slots.map(({alias,type,description,spec})=>({alias,type,description,spec}))})}];
 const output=await withTrace(fixtureState,async s=>write(root+'/fixture-traces/'+sourceTurn.id+'.json',s),()=>fb.respond(input,[],AbortSignal.timeout(120000),{json:true}));const raw=output.flatMap(o=>o.content||[]).map(x=>x.text||'').join('');const response=JSON.parse(raw.replace(/^```json\s*|\s*```$/g,''));
 const task=fixtureTask(state,sourceTurn.user_query,slots.map(s=>({...s,sourceIds:s.source_aliases.map(a=>aliases[a]?.id).filter(Boolean)})));
 for(const [i,slot] of slots.entries()){
  const value=response.outputs?.find(o=>o.alias===slot.alias);if(!value?.content)throw Error('Fixture writer did not produce '+slot.alias);
  const source=slot.source_aliases.map(a=>aliases[a]?.id).find(id=>state.taskStore.artifacts[id]);
  const artifact=addArtifact(state,{itemId:task.items[i].id,type:slot.type==='plan'?'prompt':'text',content:value.content,purpose:slot.type==='plan'?'support':'deliverable',parentId:slot.relation==='revision_of'?source:null,metadata:{fixtureSetup:true,structure:value.structure,fixtureTrace:sourceTurn.id,author:'real_model_fixture_builder'}});
  // Fixture acceptance is explicit test input provenance, not a production verifier pass.
  delete artifact.verification;artifact.publication='current';task.items[i].status='COMPLETED';aliases[slot.alias]={id:artifact.id,version:artifact.version,type:slot.type,fixture:true};
  if(slot.type==='plan'){if(!value.parameters?.prompt)throw Error('Missing fixture plan parameters');const bid=randomUUID();task.batches??={};task.batches[bid]={id:bid,itemId:task.items[i].id,taskId:task.id,tool:'generate_video',items:[value.parameters],executionIds:[],status:'planned'};requireApproval(state,{batchId:bid,itemId:task.items[i].id,tool:'generate_video',items:[value.parameters]});task.items[i].status='PENDING';}
 }
 task.status=slots.some(s=>s.type==='plan')?'WAIT_CONFIRM':'COMPLETED';state.messages.push({role:'assistant',type:'message',content:[{type:'output_text',text:'[测试前置素材；由fixture builder构建，不代表此前失败流程通过]\n'+response.outputs.map(o=>o.content).join('\n\n')}],fixtureSetup:true});projectState(state);await save(state);await write(root+'/setup/'+sourceTurn.id+'.json',{sourceTurn:sourceTurn.id,slots:slots.map(s=>s.alias),taskId:task.id,source:'real_model_fixture_builder',upstreamPass:false});
}
async function runCase(c,images=false){
 const state=fresh(),aliases={},dir=root+'/cases/'+c.id;let saveQueue=Promise.resolve();const save=async s=>{const clean=JSON.stringify(redact(s)),raw=JSON.stringify(s);saveQueue=saveQueue.then(async()=>{await fs.mkdir(dir,{recursive:true});await fs.mkdir(root+'/private/sessions',{recursive:true});await fs.writeFile(dir+'/session.json',clean);await fs.writeFile(root+'/private/sessions/'+c.id+'.json',raw);});await saveQueue;};
 const env=runtimeFor(c.id),agent=new Agent({...env,catalog,save});await save(state);
 if(images){await installImages(state,c,aliases);await save(state);}
 for(const t of c.turns){if(images&&t===c.turns[0])continue;
  const row={case_id:c.id,turn_id:t.id,run_id:runId,mode:'intermediate_diagnostic',executed:false,query:t.user_query,fixtureSources:[],upstreamOriginalPass:false,procedure_status:'EVIDENCE_MISSING',content_status:'NEEDS_REVIEW',quality_status:images?'NEEDS_REVIEW':'NOT_APPLICABLE'};
  try{
   for(const missing of t.expected.required_source_aliases.filter(a=>!aliases[a])){const producer=c.turns.find(x=>x.expected.produce_bindings.some(b=>b.alias===missing));if(!producer||producer===t)throw Error('Cannot establish source '+missing);if(producer.expected.produce_bindings.some(b=>b.type==='image'))throw Error('IMAGE_SOURCE_MISSING:'+missing);await installText(state,producer,aliases,env,save);}
   row.fixtureSources=t.expected.required_source_aliases.map(a=>({alias:a,...aliases[a]}));await write(dir+'/'+t.id+'-before.json',state);
   const oldIds=new Set(Object.keys(state.taskStore?.artifacts||{})),start=Date.now(),count=imagePosts,guards=boundaries.length;let final;console.log(JSON.stringify({id:t.id,event:'start',imagePosts}));
   await agent.run(state,t.user_query,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(limits.turnMs));await saveQueue;
   const turn=state.turns.at(-1),task=state.taskStore.tasks[turn.taskId],produced=Object.values(state.taskStore.artifacts).filter(a=>!oldIds.has(a.id)&&a.purpose==='deliverable'&&!['audit','superseded'].includes(a.publication)&&a.verification?.semantic==='passed');
   let index=0;for(const slot of t.expected.produce_bindings){const a=produced.filter(a=>a.type===slot.type)[index++];if(a)aliases[slot.alias]={id:a.id,version:a.version,type:a.type,fixture:false,url:a.url};if(slot.type==='plan'&&task?.approval?.payload){aliases[slot.alias]={id:task.id,version:task.revision,type:'plan',fixture:false};}}
   Object.assign(row,{executed:true,status:final?.status,final:final?.text,taskId:task?.id,taskStatus:task?.status,agentRunId:turn.runId,error:turn.error||task?.reason,durationMs:Date.now()-start,imagePosts:imagePosts-count,guardAttempts:boundaries.slice(guards),trace:'cases/'+c.id+'/'+t.id+'-after.json',produced:produced.map(a=>({id:a.id,type:a.type,version:a.version,url:a.url})),procedure_status:['failed','blocked','needs_input','refused'].includes(final?.status)||boundaries.length>guards?'FAIL':'EVIDENCE_MISSING'});
   console.log(JSON.stringify({id:t.id,status:row.status,images:row.imagePosts,error:row.error}));await write(dir+'/'+t.id+'-after.json',state);
  }catch(error){row.error=error.message;row.status=error.message.includes('BUDGET')?'BUDGET_BLOCKED':'SETUP_OR_RUN_ERROR';row.procedure_status='HARNESS_OR_SETUP_REVIEW';console.log(JSON.stringify({id:t.id,error:row.error}));}
  records.push(row);await write(dir+'/'+t.id+'-result.json',row);await write(root+'/results.partial.json',records);
 }
 sessions.push({caseId:c.id,state});await write(dir+'/bindings.json',aliases);
}
let cursor=0;const jobs=suite.filter(c=>textCases.includes(c.id));await Promise.all(Array.from({length:3},async()=>{while(cursor<jobs.length){const c=jobs[cursor++];await runCase(c).catch(async e=>write(root+'/fatal-'+c.id+'.json',{error:e.message}));}}));
for(const id of imageCases)await runCase(suite.find(c=>c.id===id),true).catch(async e=>{records.push({case_id:id,status:'SETUP_ERROR',error:e.message});await write(root+'/fatal-'+id+'.json',{error:e.message});});
await write(root+'/results.json',records);await write(root+'/full-trace.json',{runId,records,sessions,boundaries,mediaReceipts:receipts,setupMeaning:'constructed intermediate states; never count upstream as Agent pass'});
await write(root+'/summary.raw.json',{runId,finishedAt:new Date().toISOString(),limits,imagePosts,modelRequests,reservedImageCostCNY:imagePosts*limits.reservationCNYPerPost,actualInvoiceCNY:null,records:records.length,executed:records.filter(r=>r.executed).length,boundaries,videoSubmissions:0,audioSubmissions:0,productionCodeModified:false});console.log(JSON.stringify({event:'finished',root,imagePosts,modelRequests}));
