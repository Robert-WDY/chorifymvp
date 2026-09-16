import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCorpus,pendingReport} from './context-agent-corpus.mjs';

const reportRoot=fileURLToPath(new URL('../evaluations/2026-09-16-context-agent/',import.meta.url));
const corpus=await loadCorpus(),args=process.argv.slice(2),real=args.includes('--real');
const report=pendingReport(corpus);
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
  const [{ContextAgent},{createSession},{createTools},{createBrain},{loadCatalog},{runCaseTurns}]=await Promise.all([
    import('../server/context-agent/loop.mjs'),import('../server/context-agent/history.mjs'),import('../server/context-agent/tools.mjs'),import('../server/adapters.mjs'),import('../server/catalog.mjs'),import('./context-agent-driver.mjs')]);
  const brain=createBrain(),catalog=await loadCatalog();
  if(!brain.config.key||!brain.config.model)throw new Error('Model configuration is incomplete');
  const expectedModel=process.env.CHORIFY_CONTEXT_EXPECTED_MODEL;
  if(!expectedModel||expectedModel!==brain.config.model)throw new Error('CHORIFY_CONTEXT_EXPECTED_MODEL must exactly match the configured model');
  const mapping=process.env.CHORIFY_CONTEXT_INPUT_URLS?JSON.parse(await readFile(process.env.CHORIFY_CONTEXT_INPUT_URLS,'utf8')):{};
  const runRoot=join(reportRoot,'runs',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(runRoot,{recursive:true});
  let modelCalls=0;
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
    const save=async()=>writeFile(join(caseRoot,'session.json'),JSON.stringify(state,null,2)+'\n');
    const tools=createTools({catalog,mode:'simulation'});
    const agent=new ContextAgent({brain:meteredBrain,tools,catalog,save,maxSteps:Math.min(16,budget),maxMediaCalls:8});
    const {rounds}=await runCaseTurns({caseData:c,agent,state,inputs,save,canCall:()=>modelCalls<budget});
    await save();await writeFile(join(caseRoot,'original-case.json'),JSON.stringify(c,null,2)+'\n');
    Object.assign(row,{realModel:'executed_requires_review',realMedia:'not_run',visualReview:'not_run',businessAcceptance:'unreviewed',reason:'Review actual trace against unchanged expected; media is simulation, observation service is not injected',inputUrlIdentity:'operator-declared hash only; remote bytes not independently checked',rounds,trace:`${c.id}/session.json`});
    await writeFile(join(runRoot,'report.json'),JSON.stringify({...report,model:{provider:brain.config.provider,name:brain.config.model},modelCalls,budget,mediaMode:'simulation'},null,2)+'\n');
  }
  await writeFile(join(runRoot,'report.json'),JSON.stringify({...report,model:{provider:brain.config.provider,name:brain.config.model},modelCalls,budget,mediaMode:'simulation'},null,2)+'\n');
  console.log(JSON.stringify({runRoot,modelCalls,budget,mediaMode:'simulation',acceptance:'manual review required; no automatic semantic pass'}));
}
