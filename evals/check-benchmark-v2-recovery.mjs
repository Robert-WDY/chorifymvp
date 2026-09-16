// Post-run diagnostic. Never overwrite original traces or benchmark scores.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {refreshTasks,hasPendingTasks} from '../server/task-monitor.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {scoreCase} from './benchmark-v2-scoring.mjs';
const root=new URL('../data/benchmark-v2-200/',import.meta.url);
const source=JSON.parse(await readFile(new URL('source.json',root),'utf8'));
const report=JSON.parse(await readFile(new URL('results.json',root),'utf8'));
const catalog=await loadCatalog();const rows=[];
for(const r of report.results){
 const {state}=JSON.parse(await readFile(new URL('runs/'+r.id+'.json',root),'utf8'));
 if(!hasPendingTasks(state)&&!r.mediaCountCheck?.count)continue;
 const pendingBefore=Object.values(state.videoTasks||{}).filter(t=>['queued','running'].includes(t.status)).length;
 const owned=new Set(Object.keys(state.videoTasks||{}));
 const media={getVideo:async taskId=>{if(!owned.has(taskId))throw new Error('Unknown original task');return{taskId,status:'succeeded',videoUrl:`https://benchmark.invalid/${r.id}/${taskId}.mp4`,simulated:true};}};
 const runtime=new ToolRuntime({catalog,media,brain:{respond:async()=>{throw new Error('No additional model calls allowed');}},extended:{query:async()=>{throw new Error('No extended mock tasks');}}});
 const beforeEvents=state.events.length;
 const changed=await refreshTasks(state,runtime,AbortSignal.timeout(10000));
 const score=scoreCase(source.find(c=>c.id===r.id),state);
 rows.push({id:r.id,statusBefore:r.status,statusAfter:state.status,pendingBefore,submittedVideoTasks:owned.size,changed,mediaCountBefore:r.mediaCountCheck,mediaCountAfter:score.mediaCountCheck,newEvents:state.events.slice(beforeEvents)});
}
const diagnostic={method:'Supplemental post-run check of actual refreshTasks using a cloned saved state and the same simulated task completion semantics. No new media submission, no model calls, no original score changes. Not a live HTTP or real provider test.',checkedAt:new Date().toISOString(),monitorSourceHash:createHash('sha256').update(await readFile(new URL('../server/task-monitor.mjs',import.meta.url))).digest('hex'),rows};
await writeFile(new URL('recovery-diagnostic.json',root),JSON.stringify(diagnostic,null,2));
console.log(JSON.stringify(rows.filter(r=>r.pendingBefore||r.mediaCountBefore?.count===10).map(({newEvents,...r})=>r)));
