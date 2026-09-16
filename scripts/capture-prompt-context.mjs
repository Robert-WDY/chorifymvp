// Offline A/B/C request capture. No provider configuration, network or media submission.
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const [rootArg,snapshotFile,outputFile]=process.argv.slice(2);
if(!rootArg||!snapshotFile||!outputFile)throw Error('Usage: node scripts/capture-prompt-context.mjs <module-root> <frozen-snapshot.json> <output.json>');
globalThis.fetch=async()=>{throw Error('Network forbidden in offline capture');};
const root=resolve(rootArg),mod=relative=>import(pathToFileURL(resolve(root,'server',relative)));
const {loadCatalog}=await mod('catalog.mjs'),{createTask}=await mod('task-state.mjs'),{acceptRevision}=await mod('task-contract.mjs');
const {executeTextStage,renderStage}=await mod('text-stage.mjs'),{observeImages}=await mod('observation-contract.mjs');
const {compileGoal,prepareMediaPlan}=await mod('goal-compiler.mjs'),{TaskExecutor}=await mod('execution-engine.mjs'),{ToolRuntime}=await mod('tools.mjs');
const {understandGoal}=await mod('intent.mjs'),{composeFinalResponse}=await mod('final-response.mjs');
const catalog=await loadCatalog(),signal=()=>new AbortController().signal,hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safety={disposition:'allow',untrustedInstructions:false,reason:''},reply=v=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(v)}]}];
const image={id:'capture-image',assetId:'capture-image',type:'image',version:1,url:'https://test.invalid/product.png'};
const source={id:'capture-brief',assetId:'capture-brief',type:'text',version:1,content:'白色泵头瓶。容量和噪音未知，不声明精准控量。'};
const directions={id:'capture-directions',assetId:'capture-directions',type:'text',version:3,metadata:{structure:{directions:[{id:'direction-1',title:'一',content:'活力场景'},{id:'direction-2',title:'二',content:'安静桌面，白瓶静物；无字幕，无旁白'}],sections:[{content:'容量未知，不做效果承诺'}]}}};directions.content=renderStage(directions.metadata.structure);
const goal=item=>({summary:'固定离线比较',mode:'create',tasks:[{description:'当前节点',operation:'answer',output:'text',count:1,dependsOn:[],references:[],constraints:['不补性能'],requiredEvidence:'none',requiredMethods:[],spec:{},...item}],skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety,semantic:{deliverables:[{description:item.description||'当前节点'}],facts:['白色泵头瓶'],globalConstraints:['未知性能不承诺'],approval:{required:true,reason:'先方案'},continuation:{mode:'new'}}});
const stateFor=(item,query,inputs=[])=>{const state={id:'frozen-synthetic-session',messages:[],events:[]},task=createTask(state,goal(item),query);for(const a of inputs)state.taskStore.inputs[a.id]=structuredClone(a);acceptRevision(task,'frozen');return state;};
let frozen;
try{frozen=JSON.parse(await fs.readFile(snapshotFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;
 frozen={source:'synthetic fixed snapshots; never user/session data',
  product:stateFor({description:'理解产品，只整理事实与未知',references:[image.id],supportingSources:[source.id],requiredEvidence:'image',requiredMethods:['product-understanding-zh-v1']},'白色泵头瓶，容量未知。先理解产品。',[image,source]),
  selected:stateFor({description:'只用第二方向写安静脚本',references:[directions.id],spec:{selectedDirectionIndex:2},requiredMethods:['video-script-zh-v1']},'只根据已有第二方向写脚本，不重新设计方向。',[directions]),
  edit:stateFor({description:'只改背景为米白',operation:'edit_image',output:'image',references:[image.id],supportingSources:[source.id],spec:{ratio:'1:1'},changeContract:{change:['背景改为米白'],preserve:['瓶身颜色、形状、标签、机位不变']},requiredMethods:['image-prompt-gallery-director-v2']},'只改背景为米白，无字，先方案不生图。',[image,source]),
  rewrite:stateFor({description:'保持平静，只优化风格',operation:'rewrite',references:[source.id],requiredMethods:['creative-prompt-rewrite'],changeContract:{kind:'source_delta',request:'只优化风格，保持事实和未知项',preserveOutsideChanges:true}},'只优化平静风格，不增加冲突、功能或新人物。',[source])};
 await fs.writeFile(snapshotFile,JSON.stringify(frozen,null,2));
}
const cases=[],run=async(name,fn)=>{const entry={name,calls:[]};cases.push(entry);const brain={respond:async(input,tools,_signal,options)=>{if(tools.length)throw Error('Model tools forbidden');entry.calls.push({input:structuredClone(input),options:structuredClone(options),hash:hash(input),characters:JSON.stringify(input).length});return entry.response(input,options,entry.calls.length);}};await fn(entry,brain);entry.status='passed';};
const inertMedia={config:{imageModel:'offline-stub',videoModel:'offline-stub'},image:async()=>{throw Error('Media forbidden');},video:async()=>{throw Error('Media forbidden');}};
for(const name of ['product','selected','rewrite'])await run(name,async(entry,brain)=>{
 const state=structuredClone(frozen[name]),task=state.taskStore.tasks[state.taskStore.activeTaskId],item=task.items[0];
 entry.response=(input,options)=>options?.tracePhase==='observe_image'?reply('图片可见白色泵头瓶；资料说明容量未知。'):name==='product'?reply({content:'白色泵头瓶；容量未知。',structure:{facts:['资料：白色泵头瓶'],assumptions:['容量未知'],sellingPoints:[]}}):name==='selected'?reply({content:'安静桌面，白瓶静物；无字幕，无旁白。',structure:{hook:'安静桌面',body:'白瓶静物',cta:''}}):reply({content:'白色泵头瓶，安静背景，柔和侧光；不声明容量或性能。',structure:{prompt:'白色泵头瓶，安静背景，柔和侧光；不声明容量或性能。',preservedConstraints:['容量未知','不补性能']}});
 const executor=new TaskExecutor({state,catalog,brain,runtime:new ToolRuntime({catalog,brain,media:inertMedia})});
 await observeImages(executor,item,signal());await executeTextStage(executor,item,signal());
});
await run('edit_prepare_only',async(entry,brain)=>{
 const state=structuredClone(frozen.edit),task=state.taskStore.tasks[state.taskStore.activeTaskId];task.protocol='compiled-v1';state.assets=Object.values(state.taskStore.inputs).filter(a=>a.type==='image');task.executionPlan=compileGoal(task);
 entry.response=()=>reply({concept:'只改背景',preservedConstraints:['瓶身颜色、形状、标签、机位不变'],safety:{passed:true,reason:'离线构造'},items:[{prompt:'仅将背景改为米白，保留瓶身颜色、形状、标签、机位。不新增文字。',size:'2048x2048',referenceImages:[image.url]}]});
 const executor=new TaskExecutor({state,catalog,brain,runtime:new ToolRuntime({catalog,brain,media:inertMedia}),verifier:{verifyPlan:async()=>({passed:true,issues:[]})}});
 await prepareMediaPlan(executor,task.items[0],task.executionPlan.nodes[0],signal());
});
const valid={summary:'三个文字方向',turnOperation:{kind:'create'},deliverables:[{description:'白色泵头瓶三个文字方向',kind:'text',action:'create',count:3,artifactCount:1,form:'directions',requiredMethods:['direction-designer-zh-v1'],requestEvidence:'三个文字方向，不生图'}],facts:['白色泵头瓶'],gaps:[],assumptions:[],safety,approval:{required:false,reason:''}};
for(const name of ['intake','field_repair','schema_echo'])await run(name,async(entry,brain)=>{
 entry.response=(_input,_opts,n)=>{if(name==='field_repair'&&n===1){const bad=structuredClone(valid);delete bad.summary;return reply(bad);}if(name==='field_repair'&&n===2)return reply({summary:valid.summary});if(name==='schema_echo'&&n===1)return reply({oneOf:[{type:'object',properties:{summary:{type:'string'}}}]});return reply(valid);};
 await understandGoal(brain,catalog,{query:'白色泵头瓶，容量未知。三个文字方向，不生图',actionMode:'core',sessionId:'frozen-intake',runId:'frozen-run'},signal());
});
await run('reference_repair',async(entry,brain)=>{
 const candidate={summary:'改图',turnOperation:{kind:'modify'},deliverables:[{description:'只改背景',kind:'image',action:'modify',count:1,references:['unknown-image'],changeContract:{change:['背景米白'],preserve:['主体不变']},requestEvidence:'只改背景为米白'}],facts:[],gaps:[],assumptions:[],safety,approval:{required:true,reason:'先方案'}};
 entry.response=(input,_opts,n)=>n===1?reply(candidate):reply({'0':[JSON.parse(input[1].content).candidates.find(c=>c.id===image.id).handle]});
 await understandGoal(brain,catalog,{query:'只改背景为米白',assets:[image],actionMode:'core',sessionId:'frozen-ref',runId:'frozen-run'},signal());
});
await run('old_plan',async(entry,brain)=>{
 const state=structuredClone(frozen.edit),old=state.taskStore.tasks[state.taskStore.activeTaskId];old.approval={required:true,status:'pending',planHash:'frozen-old',payload:{items:[{prompt:'已保存的白瓶无字方案',ratio:'9:16',duration:5}]}};
 const newer={...structuredClone(old),id:'unrelated-task',query:'无关新任务',approval:{status:'pending',payload:{items:[{prompt:'不应进入旧方案回答'}]}}};state.taskStore.tasks[newer.id]=newer;state.taskStore.activeTaskId=newer.id;
 const turn={rawInput:'查看旧方案的具体参数',queryReceipt:{facts:{query:{type:'task_plan',taskIds:[old.id],answerContract:{scope:'task',questionDimensions:['方案内容']}},completion:[],tasks:[{id:old.id,revision:old.revision,status:'WAIT_CONFIRM',summary:'旧方案',approval:old.approval,batches:{saved:{items:old.approval.payload.items}}}]}}};
 entry.response=()=>[{type:'message',content:[{type:'output_text',text:'该方案已保存，仍待确认。'}]}];await composeFinalResponse(brain,state,turn,{status:'completed',artifacts:[],text:'旧方案'},signal());
});
await fs.writeFile(outputFile,JSON.stringify({source:'actual brain.respond inputs with deterministic offline responses',snapshotHash:hash(frozen),moduleRoot:root,providerCalls:0,mediaSubmissions:0,clearCalls:0,units:'UTF-16 characters, not tokens',cases},null,2));
console.log(JSON.stringify({cases:cases.length,calls:cases.reduce((n,c)=>n+c.calls.length,0),providerCalls:0,mediaSubmissions:0,outputFile}));
