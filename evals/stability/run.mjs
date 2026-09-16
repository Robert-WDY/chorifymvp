import {mkdir,writeFile,readFile,readdir,copyFile} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cases} from './cases.mjs';
import {score} from './scorer.mjs';
import {brainConfig} from '../../server/adapters.mjs';
const project=fileURLToPath(new URL('../../',import.meta.url)),tag=process.argv[2]||'v1',concurrency=Number(process.argv[3]||4);
if(!/^[a-z0-9-]+$/.test(tag)||!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('Invalid arguments');
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7).split(','),selected=cases.filter(c=>!only||only.includes(c.id));if(!selected.length)throw new Error('No cases selected');
const root=resolve(project,'data/stability-'+tag);await mkdir(root,{recursive:false});
async function files(dir){const entries=await readdir(dir,{withFileTypes:true});return(await Promise.all(entries.map(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]))).flat().sort();}
const inputs=(await Promise.all(['server','skills','evals/production24','evals/stability'].map(d=>files(join(project,d))))).flat().sort();
async function hash(){const h=createHash('sha256');for(const path of inputs){h.update(relative(project,path));h.update(await readFile(path));}return h.digest('hex');}
const startHash=await hash(),startedAt=new Date().toISOString();
for(const path of inputs){const dest=join(root,'code',relative(project,path));await mkdir(resolve(dest,'..'),{recursive:true});await copyFile(path,dest);}
const config=brainConfig();
const manifest={startedAt,sourceHash:startHash,provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort||'none',mode:'chain-stability-real-model-simulated-tools',qualityJudging:false,finalModelProbe:'separate-from-production-template',total:selected.length,sourceScenarios:new Set(selected.map(c=>c.sourceId)).size,concurrency,sourceZipSHA256:'D299AB1D2A87D39FAF6E4F8A12127B9DAB838C16592031BF542F980D23635B27'};
await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
function worker(directory,phase){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('./worker.mjs',import.meta.url)),directory,phase],{cwd:project,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 let checkpoint=false,output='';const timer=setTimeout(()=>{child.kill();reject(new Error('Worker exceeded 12 minute deadline'));},720000);
 child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 child.on('message',m=>{if(m.type==='checkpoint'){checkpoint=true;child.kill();}});
 child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',async code=>{clearTimeout(timer);await writeFile(join(directory,'worker-'+phase+'.log'),output);if(checkpoint)resolve('restart');else if(code!==0)reject(new Error('Worker failed; inspect local trace'));else resolve('done');});
});}
let cursor=0;const results=[];
await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<selected.length){const c=selected[cursor++],directory=join(root,c.id),started=Date.now();await mkdir(directory);await writeFile(join(directory,'case.json'),JSON.stringify(c,null,2));let error;
 try{if(await worker(directory,'initial')==='restart')await worker(directory,'resume');}catch(e){error=e.message;}
 let result;try{const trace=JSON.parse(await readFile(join(directory,'trace.json'),'utf8'));result=score(c,trace);if(error||trace.harnessError){result.passed=false;result.harnessError=error||trace.harnessError.message;}}catch(e){result={id:c.id,passed:false,classification:'harness_error',error:error||e.message,modelCalls:0};}
 result.durationMs=Date.now()-started;results.push(result);await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));await writeFile(join(root,'progress.json'),JSON.stringify({completed:results.length,total:selected.length,passed:results.filter(r=>r.passed).length}));console.log(JSON.stringify({id:c.id,passed:result.passed,status:result.status,failed:[...Object.entries(result.checks||{}),...Object.entries(result.hard||{})].filter(([,v])=>!v).map(([k])=>k),completed:results.length,total:selected.length}));
}}));
const summary={...manifest,finishedAt:new Date().toISOString(),sourceUnchanged:startHash===await hash(),passed:results.filter(r=>r.passed).length,modelCalls:results.reduce((n,r)=>n+r.modelCalls,0),realMediaArtifacts:0,classifications:Object.fromEntries([...new Set(results.map(r=>r.classification))].map(k=>[k,results.filter(r=>r.classification===k).length]))};
await writeFile(join(root,'results.json'),JSON.stringify(results.sort((a,b)=>a.id.localeCompare(b.id)),null,2));await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
