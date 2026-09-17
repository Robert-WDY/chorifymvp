// Evidence integrity/index only. Semantic judgments are written by the reviewer separately.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]),run=JSON.parse(await readFile(join(root,'run.json'),'utf8'));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
await mkdir(join(root,'input-blobs'),{recursive:true});
const saved=new Set(),rows=[];
async function blob(value){const id=hash(value);if(!saved.has(id)){await writeFile(join(root,'input-blobs',id+'.json'),JSON.stringify(value,null,2));saved.add(id);}return id;}
for(const row of run.results){
 if(!row.sessionId)continue;
 let s;try{s=JSON.parse(await readFile(join(root,row.id,'session.json'),'utf8'));}catch{continue;}
 const requests=s.records.filter(r=>r.event==='model_request'),responses=s.records.filter(r=>r.event==='model_response'),errors=s.records.filter(r=>r.event==='model_error');
 const indexes=[];
 for(const r of requests)indexes.push({recordId:r.id,traceId:r.traceId,turnId:r.turnId,phase:r.phase,metrics:r.metrics,tools:await blob(r.tools||[]),input:await Promise.all((r.input||[]).map(blob))});
 await writeFile(join(root,row.id,'input-index.json'),JSON.stringify(indexes,null,2));
 const toolErrors=s.records.filter(r=>r.kind==='tool_result').flatMap(r=>{const o=JSON.parse(r.output);return o.ok===false?[{recordId:r.id,turnId:r.turnId,callId:r.callId,error:o.error,status:o.status}]:[];});
 rows.push({id:row.id,requests:requests.length,responses:responses.length,modelErrors:errors.length,unpaired:requests.filter(r=>![...responses,...errors].some(o=>o.traceId===r.traceId)).map(r=>r.id),unexpandedTraceRefs:s.records.filter(r=>r.traceRef).length,toolErrors,phases:requests.reduce((o,r)=>(o[r.phase]=(o[r.phase]||0)+1,o),{}),videoToolCalls:s.records.filter(r=>r.kind==='tool_call'&&r.name==='generate_video').length,invocations:Object.values(s.invocations).map(v=>({kind:v.kind,status:v.status,name:v.name,mode:v.mode})),summaryCount:Object.keys(s.summaries).length});
}
const audit={kind:'evidence_integrity_not_semantic_score',cases:rows,requestCount:rows.reduce((n,r)=>n+r.requests,0),inputBlobCount:saved.size,missingPairs:rows.reduce((n,r)=>n+r.unpaired.length,0),unexpandedTraceRefs:rows.reduce((n,r)=>n+r.unexpandedTraceRefs,0)};
await writeFile(join(root,'trace-audit.json'),JSON.stringify(audit,null,2));console.log(JSON.stringify({cases:rows.length,calls:audit.requestCount,missingPairs:audit.missingPairs,unexpanded:audit.unexpandedTraceRefs,blobs:saved.size}));
