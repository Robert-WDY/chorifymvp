import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Doubao} from '../server/adapters.mjs';
import {understandGoal} from '../server/intent.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {auditDataset,operationAliases,scoreCase} from './benchmark-v2-scoring.mjs';

const tag=process.argv[2];if(!tag||!/^[a-z0-9-]+$/.test(tag))throw new Error('Provide a new run tag');
const concurrency=Number(process.argv[3]||8);if(!Number.isInteger(concurrency)||concurrency<1||concurrency>12)throw new Error('Concurrency must be 1–12');
const baselineRoot=new URL('../data/benchmark-v2-200/',import.meta.url),root=new URL('../data/intent-200-'+tag+'/',import.meta.url);
const bytes=await readFile(new URL('source.json',baselineRoot)),cases=JSON.parse(bytes),baseline=JSON.parse(await readFile(new URL('results.json',baselineRoot)));
const hash=x=>createHash('sha256').update(x).digest('hex');
if(cases.length!==200||new Set(cases.map(c=>c.id)).size!==200||hash(bytes)!==baseline.metadata.sourceHash)throw new Error('Original dataset integrity failed');
await mkdir(root,{recursive:false});await mkdir(new URL('runs/',root));await copyFile(new URL('source.json',baselineRoot),new URL('source.json',root));
async function freeze(directory,prefix){const out={};for(const entry of await readdir(directory,{withFileTypes:true})){const path=prefix+entry.name;if(entry.isDirectory())Object.assign(out,await freeze(new URL(entry.name+'/',directory),path+'/'));else out[path]=hash(await readFile(new URL(entry.name,directory)));}return out;}
const sourceHashes={...await freeze(new URL('../server/',import.meta.url),'server/'),...await freeze(new URL('../skills/',import.meta.url),'skills/'),'evals/rerun-intent-200.mjs':hash(await readFile(new URL('./rerun-intent-200.mjs',import.meta.url)))};
const catalog=await loadCatalog(),metadata={startedAt:new Date().toISOString(),sourceHash:hash(bytes),model:process.env.DOUBAO_CHAT_MODEL,baselineModel:baseline.metadata.model,concurrency,caseDeadlineMs:180000,sourceHashes,mode:'real-doubao-intent-and-capability-selection-only',executionTools:false,mediaGeneration:false,expectedLabelsSentToModel:false,audit:auditDataset(cases),baseline:'benchmark-v2-200; rescored from intake goal only, without execution events'};
await writeFile(new URL('metadata.json',root),JSON.stringify(metadata,null,2));
const equal=(a,b)=>JSON.stringify([...new Set(a)].sort())===JSON.stringify([...new Set(b)].sort());
export function measure(c,goal){
 const operations=goal?.tasks.map(t=>t.operation)||[],clarification=goal?.needsClarification,dependency=goal?.tasks.some(t=>t.dependsOn.length);
 const checks={schema:!!goal,operations:!!goal&&equal(operations,c.expected.operations),clarification:!!goal&&clarification===c.expected.needClarification,dependency:!!goal&&dependency===c.expected.dependency};
 const normalizedExpected=c.expected.operations.map(o=>operationAliases[o]||o),projected=[...operations,...(clarification?['clarification']:[])];
 const compatible={schema:!!goal,operations:!!goal&&normalizedExpected.every(o=>projected.includes(o)),clarification:checks.clarification,dependency:checks.dependency};
 const media=scoreCase(c,{}).mediaCountCheck,deliverables=goal?.semantic?.deliverables||[];
 const mediaTarget=media?{type:media.kind==='images'?'image':'video',expectedCount:media.count}:null;
 if(mediaTarget){mediaTarget.actualCount=deliverables.filter(d=>d.kind===mediaTarget.type).reduce((n,d)=>n+d.count,0);mediaTarget.passed=!!goal&&mediaTarget.actualCount===mediaTarget.expectedCount&&deliverables.every(d=>d.kind===mediaTarget.type);}
 return{checks,rawPassed:Object.values(checks).every(Boolean),compatible,compatiblePassed:Object.values(compatible).every(Boolean),operations,clarification,dependency,mediaTarget,semanticKinds:deliverables.map(d=>d.kind),disposition:goal?.safety.disposition,routingDeferred:!!goal?.planningDeferred};
}
let cursor=0,finished=0;const results=[];
async function run(c){
 const previous=JSON.parse(await readFile(new URL('runs/'+c.id+'.json',baselineRoot))),first=previous.modelCalls.find(x=>x.phase==='understand');
 // Reuse the exact original entry payload, excluding labels and invented state.
 const originalPayload=JSON.parse(first.inputSuffix.find(x=>x.role==='user').content),input={query:originalPayload.query,history:originalPayload.history,assets:originalPayload.assets};
 if(input.query!==c.query)throw new Error('Input mismatch '+c.id);
 const base=new Doubao({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL,model:process.env.DOUBAO_CHAT_MODEL}),modelCalls=[];
 const brain={respond:async(messages,tools,signal,options)=>{if(tools.length)throw new Error('Intent evaluation must not expose tools');const started=Date.now(),record={input:structuredClone(messages),tools:[],options,phase:messages[0].content.startsWith('你是创作助手的')?'understand':'select_capabilities'};modelCalls.push(record);try{return record.output=await base.respond(messages,tools,signal,options);}catch(e){record.error=e.message;throw e;}finally{record.durationMs=Date.now()-started;}}};
 const started=Date.now();let goal,error,intakeTrace,partialSemantic;
 try{goal=await understandGoal(brain,catalog,input,AbortSignal.timeout(metadata.caseDeadlineMs));}catch(e){error=e.message;intakeTrace=e.intakeTrace;partialSemantic=e.partialSemantic;}
 const oldGoal=previous.result.goal,result={id:c.id,category:c.category,query:c.query,history:c.history,expected:c.expected,goal,error,intakeTrace,partialSemantic,durationMs:Date.now()-started,modelCalls:modelCalls.length,...measure(c,goal),before:measure(c,oldGoal)};
 await writeFile(new URL('runs/'+c.id+'.json',root),JSON.stringify({result,input,modelCalls,baselineGoal:oldGoal},null,2));results.push(result);finished++;
 await writeFile(new URL('progress.json',root),JSON.stringify({finished,total:200,lastId:c.id,at:new Date().toISOString()}));
 console.log(JSON.stringify({finished,id:c.id,ok:!!goal,raw:result.rawPassed,compatible:result.compatiblePassed,calls:modelCalls.length,ms:result.durationMs}));
}
await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<cases.length)await run(cases[cursor++]);}));
results.sort((a,b)=>a.id.localeCompare(b.id));
const unchanged=Object.fromEntries(await Promise.all(Object.entries(sourceHashes).map(async([path,value])=>[path,value===hash(await readFile(new URL('../'+path,import.meta.url)))])));
const report={metadata:{...metadata,finishedAt:new Date().toISOString(),unchanged},results};await writeFile(new URL('results.json',root),JSON.stringify(report,null,2));
console.log(JSON.stringify({finished,valid:results.filter(r=>r.checks.schema).length,raw:results.filter(r=>r.rawPassed).length,compatible:results.filter(r=>r.compatiblePassed).length,codeUnchanged:Object.values(unchanged).every(Boolean)}));
