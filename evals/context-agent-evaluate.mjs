import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCorpus,pendingReport} from './context-agent-corpus.mjs';

const reportRoot=fileURLToPath(new URL('../evaluations/2026-09-16-context-agent/',import.meta.url));
const corpus=await loadCorpus(),args=process.argv.slice(2),real=args.includes('--real');
const report=pendingReport(corpus);
if(!real&&(args.includes('--vision')||args.includes('--media-live')))throw new Error('Vision/media evaluation also requires explicit --real authorization');
if(!real){
  await mkdir(reportRoot,{recursive:true});await writeFile(join(reportRoot,'semantic-status.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({mode:'offline_corpus_integrity',caseCount:23,filesVerified:corpus.manifest.files.length,realModelCalls:0,mediaCalls:0,semanticResults:'23 not_run',report:join(reportRoot,'semantic-status.json')}));
}else{
  if(process.env.CHORIFY_CONTEXT_REAL_MODEL_AUTHORIZED!=='1')throw new Error('Real model disabled: explicitly authorize CHORIFY_CONTEXT_REAL_MODEL_AUTHORIZED=1 after checking provider, model and budget');
  const budget=Number(process.env.CHORIFY_CONTEXT_MODEL_MAX_CALLS);
  if(!Number.isInteger(budget)||budget<1)throw new Error('Set an explicit positive CHORIFY_CONTEXT_MODEL_MAX_CALLS budget');
  const requested=args.find(x=>x.startsWith('--cases='))?.slice(8).split(',');
  if(!requested&&!args.includes('--all'))throw new Error('Choose explicit --cases=ID,ID or --all');
  if(requested?.some(id=>!corpus.manifest.caseIds.includes(id)))throw new Error('Unknown case ID');
  const [{ContextAgent},{createSession,HistoryStore},{assembleAgentTools},{createBrain},{loadAgentCatalog:loadCatalog},{runCaseTurns}]=await Promise.all([
    import('../server/context-agent/loop.mjs'),import('../server/context-agent/history.mjs'),import('../server/context-agent/runtime.mjs'),import('../server/adapters.mjs'),import('../server/context-agent/skills.mjs'),import('./context-agent-driver.mjs')]);
  const mediaEnabled=args.includes('--media-live'),mediaMode=mediaEnabled?'live':'simulation';
  const mediaBudget=Number(process.env.CHORIFY_CONTEXT_MEDIA_MAX_CALLS||0);
  if(mediaEnabled&&(process.env.CHORIFY_CONTEXT_REAL_MEDIA_AUTHORIZED!=='1'||!Number.isInteger(mediaBudget)||mediaBudget<1))throw new Error('Paid corpus submissions require CHORIFY_CONTEXT_REAL_MEDIA_AUTHORIZED=1 and a positive CHORIFY_CONTEXT_MEDIA_MAX_CALLS; explicit corpus approval actions are the approval boundary');
  const visionEnabled=args.includes('--vision');
  if(visionEnabled&&process.env.CHORIFY_CONTEXT_VISION_AUTHORIZED!=='1')throw new Error('Vision calls require explicit CHORIFY_CONTEXT_VISION_AUTHORIZED=1 and share the total model budget');
  const brain=createBrain(),catalog=await loadCatalog();
  if(!brain.config.key||!brain.config.model)throw new Error('Model configuration is incomplete');
  const expectedModel=process.env.CHORIFY_CONTEXT_EXPECTED_MODEL;
  if(!expectedModel||expectedModel!==brain.config.model)throw new Error('CHORIFY_CONTEXT_EXPECTED_MODEL must exactly match the configured model');
  const mapping=process.env.CHORIFY_CONTEXT_INPUT_URLS?JSON.parse(await readFile(process.env.CHORIFY_CONTEXT_INPUT_URLS,'utf8')):{};
  const runRoot=join(reportRoot,'runs',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(runRoot,{recursive:true});
  let modelCalls=0,mediaCalls=0;
  let media;
  if(mediaEnabled){
    const {createMediaProvider}=await import('../server/context-agent/providers.mjs');
    const provider=createMediaProvider({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL||'https://ark.cn-beijing.volces.com',imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL});
    if(!provider.image&&!provider.video)throw new Error('Paid media provider configuration is incomplete');
    media={...provider};for(const name of ['image','video'])if(provider[name])media[name]=async(...parameters)=>{if(mediaCalls>=mediaBudget)throw Object.assign(new Error('Evaluation media submission budget exhausted'),{submitted:false});mediaCalls++;return provider[name](...parameters);};
  }
  const meteredBrain={get lastCall(){return brain.lastCall;},async respond(...parameters){if(modelCalls>=budget)throw Object.assign(new Error('Evaluation total model call budget reached'),{code:'budget_exceeded'});modelCalls++;return brain.respond(...parameters);}};
  for(const c of corpus.cases){
    const row=report.results.find(r=>r.caseId===c.id);
    if(requested&&!requested.includes(c.id)){row.reason='Outside explicitly selected cases';continue;}
    if(modelCalls>=budget){row.reason='Global model-call budget exhausted before this case; not run';continue;}
    const paths=new Set(c.required_inputs||[]);
    for(const path of [...paths])if(path.endsWith('.json'))for(const asset of JSON.parse(await readFile(join(corpus.root,path),'utf8')).assets||[])paths.add(asset);
    const imagePaths=[...paths].filter(p=>/\.(png|jpg|jpeg|webp)$/i.test(p));
    const missing=imagePaths.filter(path=>!mapping[path]?.url);
    if(missing.length){row.reason=`Fixed image URL mapping required: ${missing.join(', ')}; no input substitution or fabricated observation`;continue;}
    const inputs=[];
    for(const path of paths){
      if(imagePaths.includes(path)){
        const expected=corpus.manifest.files.find(f=>f.path===path).sha256;
        if(mapping[path].sha256!==expected)throw new Error(`Input URL mapping must declare the frozen file hash: ${path}`);
        const url=new URL(mapping[path].url);if(url.protocol!=='https:')throw new Error('Fixed image mapping requires HTTPS');
        inputs.push({type:'image',name:path,url:url.href});
      }else inputs.push({type:'text',name:path,content:await readFile(join(corpus.root,path),'utf8')});
    }
    const state=createSession({ownerId:`evaluation:${c.id}`}),caseRoot=join(runRoot,c.id);await mkdir(caseRoot,{recursive:true});
    const store=new HistoryStore(join(caseRoot,'storage'));
    const save=async()=>store.save(state,state.ownerId);
    const tools=assembleAgentTools({catalog,mode:mediaMode,media,visionEnabled,visionBrain:meteredBrain});
    const agent=new ContextAgent({brain:meteredBrain,tools,catalog,save,maxSteps:Math.min(16,budget),maxMediaCalls:mediaEnabled?mediaBudget:8});
    const mediaBefore=mediaCalls;
    const {rounds}=await runCaseTurns({caseData:c,agent,state,inputs,save,canCall:()=>modelCalls<budget});
    await save();await writeFile(join(caseRoot,'session.json'),JSON.stringify(state,null,2)+'\n');await writeFile(join(caseRoot,'original-case.json'),JSON.stringify(c,null,2)+'\n');
    const observationCalls=state.records.filter(r=>r.event==='model_request'&&r.phase==='image_observation').length;
    Object.assign(row,{observationCalls,realObservation:observationCalls?'executed_requires_review':'not_run',realModel:'executed_requires_review',realMedia:mediaCalls>mediaBefore?'executed_requires_review':'not_run',visualReview:'not_run',businessAcceptance:'unreviewed',reason:`Review unchanged expected manually; media mode ${mediaMode}; vision ${visionEnabled?'enabled':'disabled'}, actual observation calls: ${observationCalls}`,inputUrlIdentity:'operator-declared hash only; remote bytes not independently checked',rounds,trace:`${c.id}/session.json`});
    await writeFile(join(runRoot,'report.json'),JSON.stringify({...report,model:{provider:brain.config.provider,name:brain.config.model},modelCalls,budget,mediaCalls,mediaBudget,mediaMode},null,2)+'\n');
  }
  await writeFile(join(runRoot,'report.json'),JSON.stringify({...report,model:{provider:brain.config.provider,name:brain.config.model},modelCalls,budget,mediaCalls,mediaBudget,mediaMode},null,2)+'\n');
  console.log(JSON.stringify({runRoot,modelCalls,budget,mediaCalls,mediaBudget,mediaMode,acceptance:'manual review required; no automatic semantic pass'}));
}
