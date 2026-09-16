import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createBrain} from '../server/adapters.mjs';
import {understandGoal,intentPrompt,planningPrompt,capabilities} from '../server/intent.mjs';
import {loadCatalog} from '../server/catalog.mjs';
const catalog=await loadCatalog();
const brain=createBrain();
const selection=process.argv[2]||'all',tag=process.argv[3]||selection;
const all=JSON.parse(await readFile(new URL(process.argv[4]||'./intent-cases.json',import.meta.url),'utf8'));
const cases=all.filter(c=>selection==='all'||c.split===selection||selection.split(',').includes(c.id));
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={provider:brain.config.provider,model:brain.config.model,startedAt:new Date().toISOString(),promptHash:hash(intentPrompt(catalog)),planningPromptHash:hash(planningPrompt(catalog)),runtimeHash:hash(await readFile(new URL('../server/intent.mjs',import.meta.url))),datasetHash:hash(JSON.stringify(all)),mode:'real-model-two-stage-intent-only-no-tools-no-media',results:[]};
const out=new URL(`../data/intent-eval-${tag}.json`,import.meta.url);await mkdir(new URL('../data/',import.meta.url),{recursive:true});
let cursor=0;
async function worker(){while(cursor<cases.length){const c=cases[cursor++],start=Date.now();let goal,error,intakeTrace,partialSemantic;
 try{goal=await understandGoal(brain,catalog,c,AbortSignal.timeout(120000));}catch(e){error=e.message;intakeTrace=e.intakeTrace;partialSemantic=e.partialSemantic;}
 const checks={schema:!!goal};
 if(goal){const expected=c.expected;const actual=[...new Set(goal.tasks.map(t=>t.operation))].sort();
  checks.operations=JSON.stringify(actual)===JSON.stringify([...new Set(expected.operations)].sort());
  checks.clarification=goal.needsClarification===expected.needsClarification;checks.safety=goal.safety.disposition===expected.disposition;
  if(expected.count)checks.count=goal.tasks.reduce((n,t)=>n+t.count,0)===expected.count;
  if(expected.reference)checks.reference=goal.tasks.some(t=>t.references.includes(expected.reference)||t.references.includes(c.assets.find(a=>a.assetId===expected.reference)?.url));
  if(expected.dependency)checks.dependency=goal.tasks.some(t=>t.dependsOn.length);
  if(expected.independent)checks.independent=goal.tasks.every(t=>!t.dependsOn.length);
 }
 const setEqual=(a,b)=>JSON.stringify([...new Set(a)].sort())===JSON.stringify([...new Set(b)].sort());
 const semanticChecks=goal?{medium:setEqual(goal.tasks.map(t=>t.output),c.expected.operations.map(o=>capabilities[o].output)),evidence:setEqual(goal.tasks.map(t=>t.requiredEvidence).filter(e=>e!=='none'),c.expected.operations.map(o=>capabilities[o].evidence).filter(e=>e!=='none')),riskPurpose:!c.expected.operations.includes('review_content')||goal.semantic.deliverables.some(d=>d.purpose==='risk_review'),gapConsistency:goal.needsClarification===goal.semantic.gaps.some(g=>g.level==='blocking')}:{medium:false,evidence:false,riskPurpose:false,gapConsistency:false};
 const result={id:c.id,category:c.category,split:c.split,query:c.query,expected:c.expected,goal,error,intakeTrace,partialSemantic,durationMs:Date.now()-start,checks,semanticChecks,passed:Object.values(checks).every(Boolean)};
 report.results.push(result);console.log(JSON.stringify({id:c.id,passed:result.passed,failed:Object.entries(checks).filter(([,v])=>!v).map(([k])=>k),ms:result.durationMs}));
 }}
await Promise.all(Array.from({length:4},worker));
report.results.sort((a,b)=>a.id.localeCompare(b.id));report.finishedAt=new Date().toISOString();report.summary={total:report.results.length,passed:report.results.filter(r=>r.passed).length,categories:Object.fromEntries([...new Set(cases.map(c=>c.category))].map(category=>{const r=report.results.filter(r=>r.category===category);return[category,{total:r.length,passed:r.filter(x=>x.passed).length}];}))};
await writeFile(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary));
