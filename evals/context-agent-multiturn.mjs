// Real text-model evaluation only when explicitly invoked. Never registers live media.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createBrain,brainConfig} from '../server/adapters.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {HistoryStore} from '../server/context-agent/history.mjs';
import {assembleAgentTools,assembleMemoryOptions} from '../server/context-agent/runtime.mjs';
import {loadAgentCatalog} from '../server/context-agent/skills.mjs';
import {acceptanceCategories,selectAcceptanceCases,withAcceptanceFault,canContinueAcceptance} from './context-agent-acceptance-cases.mjs';
import {loadCorpus} from './context-agent-corpus.mjs';

const args=process.argv.slice(2),envPath=args.find(x=>x.startsWith('--env='))?.slice(6);
if(envPath)process.loadEnvFile(envPath);
const config=brainConfig(),budget=Number(args.find(x=>x.startsWith('--budget='))?.slice(9)||120);
if(!Number.isInteger(budget)||budget<1||budget>120)throw new Error('Budget must be 1..120');
const root=resolve(args.find(x=>x.startsWith('--out='))?.slice(6)||join('evaluation-runs','multiturn-'+new Date().toISOString().replace(/[:.]/g,'-')));
const t=(user,extra={})=>({user,...extra});
const cases=[
 {id:'CHAT_VERSION',expected:'One draft; shorten without tools; atomic original/revision; correct price only; preserve parents and translation source.',turns:[
 t('给青禾茶铺写一份朋友圈文案。桂花乌龙冷泡茶，无糖，每杯18元，每天11点营业，是否需要预约还没确定。正文80到120字，另给一个短标题。只要一版文字，不生成图片。'),
 t('太正式了，改得像店员说话。正文缩成40到60字，事实不变，先在聊天里给我。'),
 t('这版可以，保存成独立文稿，原来的长版也保留，两个版本要能追溯。'),
 t('价格说错了，是20元，不是18元。只改已保存的短版，其他不动，存为新版本。',{restart:true}),
 t('把最新这一版翻译成英文，另存一份，别覆盖中文，也别把预约说成不需要。') ]},
 {id:'DIRECTION_SKILL',expected:'Exactly one then three directions; consume second; 15 then 10 seconds; unknown properties stay unknown; actual requested Skill read.',turns:[
 t('用 direction-designer-zh-v1 的方法，帮霁白护手霜做一个广告方向。已知：白色软管、30元。容量、成分和功效都未提供。静物风格，只要一个，不要顺手给我三套。'),
 t('我现在想比较三个方向，总共三个就好，先不写脚本。已知信息不变。'),
 t('选第二个，展开成15秒文字脚本。不要重新设计方向，不生图也不生视频。'),
 t('继续刚才的脚本，压到10秒，主体和创意不变，保存一份完整文稿。',{restart:true}),
 t('最后给我一句可以直接放广告里的卖点。不能把未知容量说成小巧便携，也不能编成滋润功效。') ]},
 {id:'CONFIRM_LANGUAGE',expected:'Two frozen plans; negative/quoted/ambiguous text grants nothing; partial confirms second only; repeat reuses receipt; changed first requires new plan then confirmation.',turns:[
 t('准备两张独立的虚构香水广告图方案。第一张白瓶白背景，第二张红瓶灰背景，都是1:1，无字无人。不要拼图，先给方案，暂时别生成。'),
 t('第二个方向不错，先别生成。'),
 t('同事说“确认生成”，这是我转述他的意见，不是我批准。'),
 t('确认。'),
 t('我说清楚：只确认第二张红瓶灰背景，第一张先不要。'),
 t('还是刚才第二张的同一次确认，不是再来一张。把原回执给我。',{restart:true}),
 t('第一张也确认，但把背景改成蓝色。'),
 t('现在按刚展示的第一张白瓶蓝背景新方案执行，红瓶不要重做。') ]},
 {id:'SWITCH_FACTS',expected:'Product identities stay separate, return to tea; reservation and price correction persist; no promise from unknown.',turns:[
 t('先帮青禾茶铺想一个海报方案：桂花乌龙无糖，18元，预约要求待确认，竖版，无文字。先存方案不要生成。'),
 t('海报先放下。换另一个客户松岚，做香氛蜡烛，售价79元，燃烧时长未知。写一句安静的文案，不要把茶的资料混进来。'),
 t('回到青禾。更正价格20元，预约还不知道。只写一条朋友圈文案，别继续图片。'),
 t('刚才蜡烛那一句翻译成英文，保留未知项边界。不要翻译茶饮。',{restart:true}) ]},
 {id:'ISOLATION',expected:'New session has no prior second direction or tea facts; clarify absent object, no inherited records.',turns:[
 t('继续刚才第二个方向，按我们已经说好的价格写脚本。'),
 t('我在别的会话说过，你这里能直接读到吗？不能就说不能，不要替我编。') ]},
];
const original='青禾茶铺原稿：桂花落进午后的杯子，乌龙在冷泡里慢慢舒展。我们11点开门，无糖桂花乌龙每杯18元。预约规则仍待确认，暂不作到店直接参与的承诺。';
const notes=['前景杯沿保留细微反光，背景采用米白纸纹。不要出现文字、Logo、水印或人物。','构图只安排单杯，桌面留出呼吸感，浅金茶汤的色彩来自创意设定，不是成分证明。','客户暂不采用强冲突叙事，也不希望增加产品功效或促销机制。','这一条是版式讨论：左右留白均衡，杯子保持完整，不裁掉杯口，不为了填满画面增加第二杯。'];
cases.push({id:'LONG_MEMORY',expected:'Default pressure summary triggered; two products, corrections and negations retained; exact early draft retrievable after restart; summary is not original or authorization.',turns:[
 t('记录以下原稿，叫“青禾初稿”，先别改，也别保存成独立资产；后面我会让你逐字找回：'+original),
 ...Array.from({length:8},(_,i)=>t(`设计沟通第${i+1}轮。${i===2?'纠正青禾价格为20元，覆盖此前18元；预约仍未知。':i===4?'另一客户松岚蜡烛79元，燃烧时长未知，别与青禾混用。':i===6?'确定不要红背景，保留米白。之前若讨论过红背景，现在作废。':''}以下是本轮设计记录，只需用一句话确认已记下，不要整理成长稿，不用工具存文档：`+Array.from({length:12},(_,k)=>`细节${k+1}：${notes[(i+k)%notes.length]}`).join('\n'))),
 t('现在总结两家客户的最终价格、未确定项，以及青禾已确定的背景。别复活旧选择。',{restart:true}),
 t('把最早“青禾初稿”逐字找回来，只返回当时原文，哪怕旧价格已经改过，也不要替换原稿。'),
 t('以刚找回的初稿为父版本，只改价格为20元，其余逐字保持。一次保存原稿和修订。') ]});
const corpus=await loadCorpus();
for(const id of ['IMG_MULTI_001','EDIT_001']){const c=corpus.cases.find(x=>x.id===id);cases.push({id:'ORIGINAL_'+id,expected:c.expected,originalCase:c,turns:c.conversation.map(turn=>t(turn.user,{action:turn.action,round:turn.round}))});}
if(args.includes('--diagnostic'))cases.splice(0,cases.length,
 {id:'DIAG_SAVED_CONFIRM',diagnostic:true,expected:'Saved proposals allow current-text partial confirmation, duplicate receipt reuse and changed-plan confirmation. This explicit tool cue is not a natural-query pass.',turns:[
 t('这是模拟媒体测试。请用当前可用的图片方案工具实际保存两份待批准方案，不要只写文字建议。虚构香水，第一张白瓶白背景，第二张红瓶灰背景，均1024x1024，无字无人，独立两张。只准备，先不提交。'),
 t('第二张不错，但先别生成。'),t('同事说“确认生成”，我只是转述，不是授权。'),
 t('只确认第二张红瓶灰背景，按已经保存的参数执行，第一张先不要。'),
 t('这是同一次确认，再给我第二张的原回执，不要再提交。',{restart:true}),
 t('第一张也确认，但背景改蓝色。请先实际保存并展示修改后的新方案，旧白背景方案作废。'),
 t('按刚保存的白瓶蓝背景新方案执行，红瓶不要重做。') ]},
 {id:'DIAG_BUTTON',diagnostic:true,expected:'Explicit saved plan; real button path with simulated media; repetition must reuse receipt.',turns:[
 t('使用当前图片方案工具保存1张虚构咖啡杯广告图的待批准方案：白色陶瓷杯、米白背景、1024x1024、无字无人。只准备，不提交。',{round:1}),
 t('确认生成。',{round:2,action:{type:'confirm_batch',from_round:1}}),
 t('我又点了一次确认，还是同一张，请返回原回执，不要重新提交。',{restart:true}) ]});
const categoryFilter=args.find(x=>x.startsWith('--categories='))?.slice(13).split(',')||[];
if(categoryFilter.length&&!args.includes('--acceptance'))throw new Error('--categories requires --acceptance');
if(args.includes('--acceptance'))cases.splice(0,cases.length,...selectAcceptanceCases({categories:categoryFilter}));
const selected=args.find(x=>x.startsWith('--cases='))?.slice(8).split(',');
if(selected){if(selected.some(id=>!cases.some(c=>c.id===id)))throw new Error('Unknown evaluation case');cases.splice(0,cases.length,...cases.filter(c=>selected.includes(c.id)));}
if(!args.includes('--run')){console.log(JSON.stringify({provider:config.provider,model:config.model,keyConfigured:!!config.key,budget,cases:cases.map(c=>({id:c.id,turns:c.turns.length,theme:c.theme,category:c.category,categoryLabel:acceptanceCategories[c.category],skill:c.skill,missingInputs:c.missingInputs,blockedReason:c.blockedReason})),media:'simulation',vision:false,output:root},null,2));process.exit(0);}
if(config.model!=='deepseek-flash'||!config.key)throw new Error('Expected authorized configured deepseek-flash');
await mkdir(dirname(root),{recursive:true});await mkdir(root,{recursive:false});
const write=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
await write(join(root,'cases.json'),cases);
const catalog=await loadAgentCatalog();let calls=0,currentCase,currentRound,transport=[];
const wireFetch=async(url,options)=>{const entry={caseId:currentCase,round:currentRound,startedAt:new Date().toISOString(),request:JSON.parse(options.body)};transport.push(entry);try{const response=await fetch(url,options);entry.httpStatus=response.status;entry.response=await response.clone().json();return response;}catch(error){entry.error=error.message;throw error;}finally{entry.finishedAt=new Date().toISOString();await write(join(root,currentCase,'transport.json'),transport);}};
const brain=createBrain(process.env,wireFetch);
const metered={get lastCall(){return brain.lastCall;},respond:async(...parameters)=>{if(calls>=budget)throw Object.assign(new Error('Global evaluation budget exhausted'),{code:'budget_exceeded'});calls++;console.log(JSON.stringify({case:currentCase,round:currentRound,call:calls}));return brain.respond(...parameters);}};
const metadata={startedAt:new Date().toISOString(),codeSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),provider:config.provider,model:config.model,budget,media:'simulation',vision:false,contextTokenBudget:24000,summary:assembleMemoryOptions({}),casesSha256:createHash('sha256').update(JSON.stringify(cases)).digest('hex'),entry:'actual ContextAgent + shared assembleAgentTools; direct runner, not browser UI',authorization:'Explicit --run invocation required; real text model only, no live media'};
await write(join(root,'manifest.json'),metadata);const results=[];
for(const c of cases){
 if(calls>=budget){results.push({id:c.id,category:c.category,status:'not_run',reason:'Global model-call budget exhausted',acceptance:'not_run'});continue;}
 if(c.blockedReason){results.push({id:c.id,category:c.category,status:'not_run',reason:c.blockedReason,acceptance:'not_run'});continue;}
 currentCase=c.id;transport=[];await mkdir(join(root,c.id));
 let store=new HistoryStore(join(root,c.id,'storage'));let state=await store.create('evaluation:'+c.id);
 const startCalls=calls,rounds=[],byRound=new Map(),faultLog=[];
 for(const [i,turn]of c.turns.entries()){
  if(calls>=budget)break;currentRound=i+1;
  if(turn.restart){store=new HistoryStore(join(root,c.id,'storage'));state=await store.load(state.id,state.ownerId);}
  const tools=withAcceptanceFault(assembleAgentTools({catalog,mode:'simulation',visionEnabled:false}),c.fault,i+1,faultLog);
  const agent=new ContextAgent({brain:metered,tools,catalog,save:()=>store.save(state,state.ownerId),maxSteps:10,maxModelCalls:10,maxMediaCalls:8,memory:assembleMemoryOptions({})});
  let confirmation;
  if(turn.action){const previous=byRound.get(turn.action.from_round)||[];const ids=previous.filter(r=>r.kind==='tool_result').map(r=>{try{return JSON.parse(r.output);}catch{return {};}}).filter(r=>r.status==='approval_required').map(r=>r.proposalId);if(ids.length)confirmation={proposalIds:ids};else{rounds.push({round:i+1,user:turn.user,status:'not_run',reason:'Original button action has no displayed proposals'});break;}}
  const before=state.records.length,started=Date.now(),events=[];
  await write(join(root,c.id,`before-${i+1}.json`),state);
  const result=await agent.run(state,turn.user,event=>events.push(event),AbortSignal.timeout(300000),{requestId:c.id+':'+i,confirmation});
  const records=state.records.slice(before);byRound.set(turn.round||i+1,records);
  rounds.push({round:i+1,user:turn.user,restarted:!!turn.restart,result,elapsedMs:Date.now()-started,recordIds:records.map(r=>r.id),events});
  await write(join(root,c.id,`after-${i+1}.json`),state);
  await write(join(root,c.id,'faults.json'),faultLog);
  await write(join(root,c.id,'rounds.json'),rounds);
  await write(join(root,c.id,'session.json'),await store.exportSession(state.id,state.ownerId));
  console.log(JSON.stringify({case:c.id,round:i+1,status:result.status,modelCalls:result.modelCalls,text:result.text?.slice(0,100)}));
  if(args.includes('--acceptance')?!canContinueAcceptance(result):result.status!=='completed')break;
 }
 await write(join(root,c.id,'rounds.json'),rounds);
 results.push({id:c.id,category:c.category,sessionId:state.id,turns:rounds.length,planned:c.turns.length,calls:calls-startCalls,summaries:Object.keys(state.summaries).length,acceptance:'requires_full_trace_review',faultCoverage:c.fault?(faultLog.length?'injected':'not_exercised'):null});
 await write(join(root,c.id,'review.json'),{status:'pending',reviewer:null,evidenceRequirements:c.evidence||[],expected:c.expected,coverageChecks:c.requires||[],skillExpectation:c.skill||null,missingInputs:c.missingInputs||[],expectedBehavior:c.expectedBehavior||null,earliestFailureStage:null,evidencePointers:[],reason:null});
 await write(join(root,'run.json'),{...metadata,calls,results,realMediaCalls:0,finishedAt:new Date().toISOString()});
}
await write(join(root,'run.json'),{...metadata,calls,results,realMediaCalls:0,finishedAt:new Date().toISOString()});
console.log(JSON.stringify({root,calls,results,realMediaCalls:0}));
