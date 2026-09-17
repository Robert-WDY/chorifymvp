// Offline evidence inventory, not a semantic success scorer. No network calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]);
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,v)=>fs.writeFileSync(path.join(root,p),JSON.stringify(v,null,2)+'\n');
const cases=read('cases.json'),items=[];
for(const c of cases){
 if(!fs.existsSync(path.join(root,c.id,'session.json')))continue;
 const s=read(c.id+'/session.json'),wire=read(c.id+'/transport.json'),rounds=read(c.id+'/rounds.json');
 const requests=s.records.filter(r=>r.event==='model_request'),calls=s.records.filter(r=>r.kind==='tool_call'),results=s.records.filter(r=>r.kind==='tool_result');
 const unsubmittedRequests=requests.filter(r=>s.records.some(e=>e.event==='model_error'&&e.traceId===r.traceId&&e.code==='budget_exceeded'&&e.message==='Global evaluation budget exhausted')&&!s.records.some(e=>e.event==='model_response'&&e.traceId===r.traceId));
 assert.equal(requests.length-unsubmittedRequests.length,wire.length,c.id+' actual requests retained; local budget rejection separately retained');
 for(const call of calls)assert.equal(results.filter(r=>r.callId===call.callId).length,1,c.id+' tool result pairing');
 const phases={};for(const r of rounds)for(const [k,v]of Object.entries(r.result?.modelAccounting||{})){const a=phases[k]??={calls:0,durationMs:0};a.calls+=v.calls;a.durationMs+=v.durationMs;}
 const transcripts=rounds.map(round=>({round:round.round,user:round.user,status:round.result?.status||round.status,result:round.result?.text,records:s.records.filter(r=>round.recordIds?.includes(r.id)&&(['message','tool_call','tool_result','system_observation'].includes(r.kind))).map(r=>r.kind==='tool_result'?{...r,output:JSON.parse(r.output)}:r)}));
 write(c.id+'/review-records.json',transcripts);
 fs.writeFileSync(path.join(root,c.id,'full-transcript.txt'),transcripts.map(t=>`ROUND ${t.round} ${t.status}\nUSER: ${t.user}\n`+t.records.map(r=>JSON.stringify(r,null,2)).join('\n')+'\nFINAL: '+t.result).join('\n\n')+'\n');
 const receipts=Object.values(s.invocations).filter(r=>r.kind==='media');
 for(const r of receipts){assert.equal(r.mode,'simulation');assert.deepEqual(r.args,s.approvals[r.proposalId].args);}
 items.push({id:c.id,planned:c.turns.length,executed:rounds.filter(r=>r.result).length,notRun:rounds.filter(r=>!r.result).length,notReached:c.turns.length-rounds.length,phases,unsubmittedRequests,calls:wire.length,http200:wire.filter(w=>w.httpStatus===200).length,inputTokens:wire.reduce((n,w)=>n+(w.response?.usage?.input_tokens||0),0),outputTokens:wire.reduce((n,w)=>n+(w.response?.usage?.output_tokens||0),0),errors:results.flatMap(r=>{const o=JSON.parse(r.output);return o.ok===false?[{id:r.id,callId:r.callId,error:o.error}]:[];}),summaries:Object.values(s.summaries||{}),summaryFailures:s.records.filter(r=>r.event==='summary_failed'),proposals:Object.values(s.approvals).filter(a=>a.kind==='proposal').length,mediaReceipts:receipts.length,assets:Object.values(s.assets),sessionHash:createHash('sha256').update(fs.readFileSync(path.join(root,c.id,'session.json'))).digest('hex')});
}
const total=Object.fromEntries(['planned','executed','notRun','notReached','calls','http200','inputTokens','outputTokens','proposals','mediaReceipts'].map(k=>[k,items.reduce((n,c)=>n+c[k],0)]));
write('inventory.json',{total,items,proof:'Complete model requests, tool pairing and frozen simulation arguments checked; no semantic verdict inferred.'});
console.log(JSON.stringify({total,items:items.map(c=>({id:c.id,executed:c.executed,errors:c.errors.length,summaries:c.summaries.length,summaryFailures:c.summaryFailures.length,proposals:c.proposals,mediaReceipts:c.mediaReceipts,phases:c.phases}))},null,2));
