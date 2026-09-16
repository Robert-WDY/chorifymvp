import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Agent} from '../server/agent.mjs';
import {createBrain} from '../server/adapters.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {Verifier} from '../server/verification.mjs';
import {withTrace,redact} from '../server/trace-context.mjs';
const root='data/intermediate-eval-20260914',dir=root+'/setup-correction-W04-T3';await fs.mkdir(dir,{recursive:true});
const state=JSON.parse(await fs.readFile(root+'/cases/W04/W04-T3-before.json','utf8'));state.id=randomUUID();
const save=async s=>fs.writeFile(dir+'/session.json',JSON.stringify(redact(s),null,2));
const brain=createBrain(),catalog=await loadCatalog(),denied=[];
const deny=async a=>{denied.push(a);throw Error('NO_MEDIA_FOR_TEXT_SETUP_CORRECTION');};
const runtime=new ToolRuntime({brain,catalog,media:{config:{imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL},image:deny,video:deny},extended:{capabilities:()=>({}),submit:deny}});
const verifier=new Verifier(brain),agent=new Agent({brain,runtime,catalog,verifier,save});
const originalModelCalls=state.modelCalls.length,originalTask=state.taskStore.activeTaskId,validations=[];
for(const artifact of Object.values(state.taskStore.artifacts).filter(a=>a.metadata?.fixtureSetup&&!a.verification&&a.type==='text')){
 const task=state.taskStore.tasks[artifact.taskId],item=task.items.find(i=>i.id===artifact.itemId);state.taskStore.activeTaskId=task.id;state.currentRunId='fixture_validation_'+randomUUID();
 const verdict=await withTrace(state,save,()=>verifier.verifyText(item,artifact.content,state,AbortSignal.timeout(120000)));
 validations.push({artifactId:artifact.id,verdict});if(verdict.passed){artifact.verification={technical:'passed',semantic:'passed'};artifact.acceptance={...verdict,checker:verdict.checker,fixtureReadinessOnly:true};}
}
state.taskStore.activeTaskId=originalTask;await fs.writeFile(dir+'/ready-before.json',JSON.stringify(redact(state),null,2));
const query='保持耳机静态海报的主体、蓝背景和1:1，只把背景改成浅灰，其他不要动。';
const suite=JSON.parse(await fs.readFile('data/focused-eval-v2-text-20260914/suite/cases.json','utf8'));const actual=suite.find(c=>c.id==='W04').turns.find(t=>t.id==='W04-T3').user_query;
let final;await agent.run(state,actual,e=>{if(e.type==='final')final=e;},AbortSignal.timeout(300000));
await fs.writeFile(dir+'/result.json',JSON.stringify(redact({kind:'harness_correction_separate_replay',query:actual,validations,final,additionalModelCalls:state.modelCalls.length-originalModelCalls,denied,originalFailureRetained:true}),null,2));console.log(JSON.stringify({status:final?.status,additionalModelCalls:state.modelCalls.length-originalModelCalls,validations:validations.map(v=>({id:v.artifactId,passed:v.verdict.passed}))}));
