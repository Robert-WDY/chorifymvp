// Offline re-scoring: preserve raw responses and the initial, narrower score.
import {readFile,writeFile} from 'node:fs/promises';
import Ajv from 'ajv';
import {semanticSchema} from '../server/intent.mjs';
import {specializeMediaSchema} from '../server/goal-compiler.mjs';
import {mediaSkills} from '../server/media-skill-contracts.mjs';
const root=process.argv[2];if(!root)throw new Error('Specify an existing A/B directory');
const rows=JSON.parse(await readFile(root+'/results.json','utf8')),cases=JSON.parse(await readFile(root+'/cases.json','utf8'));
const ajv=new Ajv({strict:false,allErrors:true});
const verdictSchema={type:'object',additionalProperties:false,required:['passed','issues','uncertain'],properties:{passed:{type:'boolean'},issues:{type:'array',items:{type:'string'},maxItems:8},uncertain:{type:'boolean'}}};
const strict=[];
for(const row of rows){
 const result={id:row.id,arm:row.arm,repeat:row.repeat,apiSuccess:!!row.output,checks:{},originalPassed:row.passed};
 if(!row.output){result.passed=null;result.error=row.error;strict.push(result);continue;}
 try{
  const value=JSON.parse(row.output.filter(m=>m.type==='message').flatMap(m=>m.content||[]).map(p=>p.text||'').join('\n'));
  const fixture=cases.find(c=>c.id===row.id),payload=JSON.parse(fixture.before.find(m=>m.role==='user').content instanceof Array?fixture.before[1].content[0].text:fixture.before.find(m=>m.role==='user').content);
  const schema=row.id.startsWith('media-')?specializeMediaSchema(mediaSkills[1],payload.goal,payload.goal.count):row.id.startsWith('intent-')?semanticSchema:verdictSchema;
  const valid=ajv.compile(schema);result.checks={...row.checks,validSchema:valid(value)};if(!result.checks.validSchema)result.schemaErrors=valid.errors;
  if(row.id.startsWith('intent-'))result.checks.mediaEvidenceIsNone=(value.deliverables||[]).every(d=>d.kind==='text'||d.requiredEvidence==='none');
  // Diagnostic fixtures only: a rejection solely for "专治" is NOT evidence that
  // the verifier detected unsupported product properties. Keep matching evidence.
  if(row.id.startsWith('facts-')){
   const issues=value.issues?.join('\n')||'';
   result.checks.rejectsUnsupportedClaims=value.passed===false&&value.uncertain===false&&/结构稳固|稳定性|瓦楞纸|猫薄荷|双面|寿命|产品属性|无依据/.test(issues);
   result.issues=value.issues;
  }
  result.passed=Object.values(result.checks).every(Boolean);
 }catch(error){result.checks.validJSON=false;result.error=error.message;result.passed=false;}
 strict.push(result);
}
const summary=cases.map(c=>({id:c.id,...Object.fromEntries(['before','after'].map(arm=>{const r=strict.filter(x=>x.id===c.id&&x.arm===arm);return [arm,{passed:r.filter(x=>x.passed).length,scored:r.filter(x=>x.apiSuccess).length,apiErrors:r.filter(x=>!x.apiSuccess).length}];}))}));
await writeFile(root+'/strict-results.json',JSON.stringify(strict,null,2));await writeFile(root+'/strict-summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
