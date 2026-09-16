import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {Doubao} from '../server/adapters.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
import {currentTask,taskArtifacts} from '../server/task-state.mjs';
const root=new URL('../data/task-loop-confirmation-replay/',import.meta.url);await mkdir(root,{recursive:false});
const catalog=await loadCatalog(),hash=createHash('sha256');for(const n of (await readdir(new URL('../server/',import.meta.url))).filter(n=>n.endsWith('.mjs')).sort()){hash.update(n);hash.update(await readFile(new URL('../server/'+n,import.meta.url)));}
await writeFile(new URL('manifest.json',root),JSON.stringify({at:new Date().toISOString(),serverSha256:hash.digest('hex'),mode:'resume-two-real-failed-sessions-with-real-doubao-simulated-media'}));
const results=await Promise.all([2,3].map(async n=>{
 const source='../data/task-loop-confirmation-v5/confirmation-repeat-'+n+'.json',original=JSON.parse(await readFile(new URL(source,import.meta.url))),state=structuredClone(original.state),taskId=currentTask(state).id;
 if(currentTask(state).status!=='WAIT_CONFIRM')throw new Error('Fixture is not awaiting approval');
 const calls=[],submissions=[],base=new Doubao({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL,model:process.env.DOUBAO_CHAT_MODEL});
 const brain={respond:async(input,tools,signal,options)=>{const call={input:structuredClone(input),tools,options};calls.push(call);return call.output=await base.respond(input,tools,signal,options);}};
 const media={config:{imageModel:'simulated'},image:async args=>{submissions.push(args);return{status:'succeeded',images:[{url:'https://benchmark.invalid/replay-'+n+'.png'}],simulated:true};}};
 const runtime=new ToolRuntime({catalog,brain,media}),agent=new Agent({catalog,brain,runtime,verifier:new Verifier(brain)});
 await agent.run(state,'确认，就按刚才的方案生成。',()=>{},AbortSignal.timeout(180000));
 const checks={sameTask:currentTask(state).id===taskId,completed:state.status==='completed',oneSubmission:submissions.length===1,exactApprovedArguments:JSON.stringify(submissions[0])===JSON.stringify(original.snapshots[0].task.approval.payload.items[0]),artifact:taskArtifacts(state).some(a=>a.type==='image')};
 const result={id:n,checks,passed:Object.values(checks).every(Boolean),status:state.status,modelCalls:calls.length};await writeFile(new URL('replay-'+n+'.json',root),JSON.stringify({result,state,calls,source},null,2));console.log(JSON.stringify(result));return result;
}));
await writeFile(new URL('results.json',root),JSON.stringify({results},null,2));
