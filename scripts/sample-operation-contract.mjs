import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createBrain} from '../server/adapters.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {understandGoal} from '../server/intent.mjs';
import {capabilitySnapshot} from '../server/runtime-facts.mjs';
const out='data/operation-contract-repair-20260914',catalog=await loadCatalog(),fixtures=JSON.parse(fs.readFileSync('tests/fixtures/operation-contract-raw.json'));
const source=fs.readdirSync('server').filter(f=>f.endsWith('.mjs')).map(f=>({path:'server/'+f,hash:createHash('sha256').update(fs.readFileSync('server/'+f)).digest('hex')}));
let requests=0;const results=[];
const transport=async(url,options)=>{if(++requests>70)throw Error('Sampling request budget');const u=new URL(url),allowed=new URL(process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com');if(u.origin!==allowed.origin||!u.pathname.endsWith('/responses'))throw Error('Network denied');const response=await fetch(url,options);return response;};
for(let round=1;round<=2;round++)for(const fixture of fixtures.filter(f=>f.id==='C03-T4')){
 const f=structuredClone(fixture),calls=[],base=createBrain(process.env,transport),brain={config:base.config,respond:async(input,tools,signal,options)=>{const c={input,options,startedAt:new Date().toISOString()};calls.push(c);try{c.output=await base.respond(input,tools,signal,options);return c.output;}catch(e){c.error=e.message;throw e;}finally{c.finishedAt=new Date().toISOString();c.usage=base.lastCall?.usage;}}};
 const row={id:f.id,round,startedAt:new Date().toISOString(),mode:'real_deepseek_intake_only',calls};
 try{row.goal=await understandGoal(brain,catalog,{query:f.query,taskCandidates:f.candidates,taskSnapshot:f.candidates.find(t=>t.id===f.taskId),assets:f.artifacts,history:f.history,strictControl:true,auditContracts:true,runtimeFacts:capabilitySnapshot({brain},catalog)},AbortSignal.timeout(180000));const g=row.goal;
  row.passed=f.id==='G01-T1'?(g.tasks[0]?.runtimeQuery?.type==='capabilities'||g.requestContract?.systemFacts?.includes('capabilities')&&g.requestContract.readOnly):f.id==='G02-T8'||f.id==='C02-T4'?g.readOnlyTurn&&g.tasks[0]?.runtimeQuery?.type==='presentation':f.id==='C01-T4'?g.tasks.length===1&&g.tasks[0].operation==='edit_image'&&!g.tasks[0].spec?.selectedDirectionIndex:f.id==='C03-T4'?g.tasks.length>=2&&g.tasks.every(t=>t.references.length===1&&t.changeContract?.source):g.tasks.some(t=>t.output==='video'&&t.spec.ratio==='9:16'&&t.spec.durationSeconds===5)&&g.tasks.filter(t=>t.output==='text').every(t=>!t.requiredMethods.includes('direction-designer-zh-v1'))&&g.semantic.approval.required;
 }catch(e){row.passed=false;row.error=e.message;}
 row.finishedAt=new Date().toISOString();results.push(row);fs.writeFileSync(out+'/real-samples-impact-release.json',JSON.stringify({source,requests,realMedia:0,results},null,2));console.log(JSON.stringify({id:row.id,round,passed:row.passed,error:row.error,calls:calls.length}));
}
