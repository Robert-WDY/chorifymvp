// Reproducible local diagnostics; no model or provider calls and no live data access.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {HistoryStore,createSession,appendRecord,baselineSnapshot} from '../server/context-agent/history.mjs';
import {buildContext} from '../server/context-agent/context.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {loadAgentCatalog} from '../server/context-agent/skills.mjs';
import {assembleMemoryOptions} from '../server/context-agent/runtime.mjs';
import {loadCorpus,pendingReport} from './context-agent-corpus.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const out=resolve(process.argv[2]||'evaluations/2026-09-17-unified-repair');
const baseline='a4220e12f89f0c4c060b5724aebfb5adef274160';
const hash=b=>createHash('sha256').update(b).digest('hex');
await mkdir(out,{recursive:true});
const write=(name,value)=>writeFile(join(out,name),JSON.stringify(value,null,2)+'\n');
const workspace=await mkdtemp(join(tmpdir(),'chorify-unified-audit-'));
const measure=async(fn)=>{const before=process.memoryUsage(),start=performance.now(),value=await fn();return {value,metrics:{elapsedMs:performance.now()-start,before,after:process.memoryUsage()}};};
try{
  const state=createSession({ownerId:'synthetic-offline'}),store=new HistoryStore(join(workspace,'performance'));
  for(let i=0;i<1000;i++)state.assets['asset_'+i]={id:'asset_'+i,type:'text',name:'合成资料'+i,version:1,content:'原文事实未知。'.repeat(600)};
  for(let i=0;i<200;i++)state.approvals['proposal_'+i]={kind:'proposal',proposalId:'proposal_'+i,ownerId:state.ownerId,sessionId:state.id,name:'generate_image',mode:'simulation',args:{prompt:'合成冻结参数。'.repeat(1000),size:'1024x1024'}};
  for(let i=0;i<1000;i++)appendRecord(state,{kind:'message',role:i%2?'assistant':'user',content:'合成历史 '+i+'，容量未知。'.repeat(120)});
  const first=await measure(()=>store.save(state,state.ownerId));
  const catalog=await loadAgentCatalog(),tools=createTools({catalog}),prompt=await readFile(join(root,'server/context-agent/prompt.md'),'utf8');
  const context=await measure(()=>buildContext(state,{systemPrompt:prompt,skillDirectory:catalog.skills,toolDefinitions:tools.definitions,tokenBudget:24000,reservedTokens:6500}));
  const record=appendRecord(state,{kind:'message',role:'user',content:'请回读最早原稿'});
  const incremental=await measure(()=>store.save(state,state.ownerId));
  const load=await measure(()=>new HistoryStore(join(workspace,'performance')).load(state.id,state.ownerId));
  assert.equal(load.value.records.at(-1).id,record.id);
  assert.ok(context.value.metrics.estimatedInputTokens+context.value.metrics.estimatedToolDefinitionTokens<=17500);
  await write('performance.json',{verification:'one local synthetic sample; not production capacity or constant cost',node:process.version,platform:process.platform,counts:{assets:1000,longProposals:200,messagesBeforeAppend:1000},initialSave:{...first.metrics,...first.value},context:{...context.metrics,...context.value.metrics},incrementalSave:{...incremental.metrics,...incremental.value},load:load.metrics,note:'payloadBytesWritten excludes SQLite indexes, journal/fsync and total physical disk writes; memory snapshots are not peak RSS. Summary model time/cost is unverified.'});

  const full=JSON.parse(await readFile(join(out,'traces/button-reply-failure.json'),'utf8')).state;
  const memory=JSON.parse(await readFile(join(out,'traces/summary-restart.json'),'utf8')).state;
  const oldSource=execFileSync('git',['show',baseline+':server/context-agent/history.mjs'],{cwd:root,encoding:'utf8'});
  const oldModule=join(workspace,'baseline-history.mjs');await writeFile(oldModule,oldSource);
  const {HistoryStore:OldStore}=await import(pathToFileURL(oldModule));
  const importInto=async(snapshot,Store,dir)=>{const owner=hash(snapshot.ownerId),directory=join(workspace,dir),folder=join(directory,owner);await mkdir(folder,{recursive:true});await writeFile(join(folder,snapshot.id+'.json'),JSON.stringify(snapshot));const s=new Store(directory);await s.load(snapshot.id,snapshot.ownerId);return s.exportSession(snapshot.id,snapshot.ownerId);};
  const checks=[];
  for(const [label,snapshot]of [['button-and-receipt',full],['summary-and-original',memory]]){
    const restored=await importInto(snapshot,HistoryStore,'current-'+label);assert.deepEqual(restored,snapshot);
    const compat=baselineSnapshot(snapshot),old=await importInto(compat,OldStore,'baseline-'+label);assert.deepEqual(old,compat);
    for(const key of ['assets','approvals','invocations'])assert.deepEqual(old[key],snapshot[key]);
    assert.equal(old.records.length,snapshot.records.length);
    checks.push({label,currentFullImport:'exact equality',baselineImport:'exact compatibility snapshot equality',originalMessagesAndAssetsApprovalsReceipts:'preserved',observations:snapshot.records.filter(r=>r.kind==='system_observation').length,summaries:Object.keys(snapshot.summaries||{}).length});
  }
  await write('rollback.json',{baseline,verification:'actual baseline module loaded in fresh temp directories; no live SQLite modified',checks,limits:'Compatibility copy turns observations into runtime evidence; old Agent does not consume the new observation/summary semantics. Keep full export and original SQLite to restore current code.'});

  const methods=[];
  for(const {slug}of catalog.skills){
    const currentPath=`server/context-agent/methods/v1/${slug}/method.md`,refPath=`server/context-agent/methods/v1/${slug}/references.json`;
    const old=await readFile(join(root,'skills',slug,'instructions.md'),'utf8'),current=await readFile(join(root,currentPath),'utf8');
    const prior=execFileSync('git',['show',baseline+':'+currentPath],{cwd:root,encoding:'utf8'});
    const headings=text=>text.split(/\r?\n/).flatMap((text,i)=>/^#+ /.test(text)?[{line:i+1,text}]:[]);
    const refs=JSON.parse(await readFile(join(root,refPath),'utf8'));
    const priorRefs=JSON.parse(execFileSync('git',['show',baseline+':'+refPath],{cwd:root,encoding:'utf8'}));
    methods.push({slug,legacy:{path:`skills/${slug}/instructions.md`,sha256:hash(old),headings:headings(old)},current:{path:currentPath,sha256:hash(current),headings:headings(current),changedSinceBaseline:current!==prior},references:refs.map(r=>{const p=priorRefs.find(p=>p.path===r.path),body=r.content??r.text??'';return {path:r.path,characters:body.length,sha256:hash(body),unchangedSinceBaseline:JSON.stringify(p)===JSON.stringify(r)};})});
  }
  await write('skill-audit.json',{verification:'structural inventory and reference hashes; use manual mapping for professional-content judgment; no real creative output tested',baseline,methods});
  await write('original-23-status.json',pendingReport(await loadCorpus()));
  const sourcePaths=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/))]
    .filter(p=>p.startsWith('server/context-agent/')||p==='server/adapters.mjs'||p.startsWith('evals/context-agent-')||p.startsWith('tests/context-agent-')).sort();
  const files=[];for(const path of sourcePaths)files.push({path,sha256:hash(await readFile(join(root,path)))});
  await write('manifest.json',{baseline,branch:execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim(),entrypoint:'server/context-agent/index.mjs',node:process.version,model:'scripted offline substitutes only',media:'mock providers only; zero paid submissions',summaryDefaults:assembleMemoryOptions({}),toolSchemaSha256:hash(JSON.stringify(tools.definitions)),toolNames:tools.definitions.map(t=>t.name),files});
  console.log(JSON.stringify({output:out,performance:'recorded',rollback:'passed both current and baseline loaders',methods:methods.length,references:methods.reduce((n,m)=>n+m.references.length,0)}));
}finally{
  if(!resolve(workspace).startsWith(resolve(tmpdir())+sep)||!workspace.includes('chorify-unified-audit-'))throw new Error('Unsafe temp cleanup target');
  await rm(workspace,{recursive:true,force:true});
}
