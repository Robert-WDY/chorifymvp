// Offline extraction only: provide the existing 23-case run directory as argv[2].
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const base=process.argv[2];if(!base)throw new Error('Expected existing run directory');
const selected=new Set(['FACT_001','PAR_001','DEP_001','USER_STYLE_07','IMG_EDIT_002','MEDIA_001','USER_STYLE_01']);
const cases=[];
for(const e of await fs.readdir(base,{withFileTypes:true})){
 if(!e.isDirectory()||e.name==='source')continue;
 const file=path.join(base,e.name,'session.json');let raw;try{raw=await fs.readFile(file,'utf8');}catch{continue;}
 const s=JSON.parse(raw),calls=s.records.filter(r=>r.kind==='tool_call');
 const first=s.records.find(r=>r.event==='model_request'&&r.phase==='agent');
 const final=s.records.filter(r=>r.event==='model_request'&&r.phase==='agent').at(-1);
 const results=new Map(s.records.filter(r=>r.kind==='tool_result').map(r=>[r.callId,{id:r.id,...JSON.parse(r.output)}]));
 const observations=calls.filter(c=>['analyze_image','compare_images'].includes(c.name)).map(c=>({callRecordId:c.id,name:c.name,args:JSON.parse(c.arguments),result:results.get(c.callId)}));
 const semanticRecords=selected.has(e.name)?s.records.filter(r=>r.kind==='message'||r.kind==='tool_call'||r.kind==='tool_result').map(r=>r.kind==='tool_result'?{id:r.id,kind:r.kind,callId:r.callId,result:JSON.parse(r.output)}:r):undefined;
 cases.push({id:e.name,sessionSha256:createHash('sha256').update(raw).digest('hex'),firstRequestId:first?.id,firstMetrics:first?.metrics,firstToolNames:first?.tools?.map(t=>t.name),finalRequestId:final?.id,finalMetrics:final?.metrics,
  observedMaterials:observations.map(o=>({callRecordId:o.callRecordId,tool:o.name,succeeded:o.result?.ok===true,materialCount:o.result?.materials?.length??null,imageIds:o.result?.imageIds,comparisons:o.result?.comparisons})),
  toolCounts:calls.reduce((m,c)=>(m[c.name]=(m[c.name]||0)+1,m),{}),notExecuted:[...results.values()].filter(r=>r.status==='not_executed').length,
  proposals:Object.values(s.approvals).filter(a=>a.kind==='proposal').map(a=>({id:a.proposalId,name:a.name,args:a.args})),
  actualRequests: selected.has(e.name)?s.records.filter(r=>r.event==='model_request').map(r=>({recordId:r.id,phase:r.phase,input:r.input,toolNames:r.tools?.map(t=>t.name),metrics:r.metrics})):undefined,
  semanticRecords});
}
const successful=cases.flatMap(c=>c.observedMaterials).filter(o=>o.succeeded);
const stats={cases:cases.length,successfulObservations:successful.length,successfulObservationsWithoutMaterials:successful.filter(o=>o.materialCount===0).length,notExecuted:cases.reduce((n,c)=>n+c.notExecuted,0),firstRequestsWithOmissions:cases.filter(c=>c.firstMetrics?.omittedRecords>0).map(c=>c.id)};
await fs.writeFile(new URL('./external-evidence.json',import.meta.url),JSON.stringify({sourceRun:path.basename(base),stats,cases},null,2)+'\n');
console.log(JSON.stringify(stats,null,2));
