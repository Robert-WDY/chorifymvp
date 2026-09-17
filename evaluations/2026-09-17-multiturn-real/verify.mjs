// Offline forensic checks of frozen evidence, not a business-success scorer.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const estimate=v=>Math.ceil(Buffer.byteLength(typeof v==='string'?v:JSON.stringify(v),'utf8')/2)+4;
const results=[];
for(const batch of ['primary','diagnostic'])for(const c of read(batch+'/cases.json')){
 const p=batch+'/'+c.id,s=read(p+'/session.json'),rounds=read(p+'/rounds.json'),wire=read(p+'/transport.json');
 const requests=s.records.filter(r=>r.event==='model_request');
 assert.equal(requests.length,wire.length,c.id+' all wire calls retained');
 const calls=s.records.filter(r=>r.kind==='tool_call'),returns=s.records.filter(r=>r.kind==='tool_result');
 for(const call of calls)assert.equal(returns.filter(r=>r.callId===call.callId).length,1,c.id+' tool result pairing');
 const phases={};for(const r of rounds)for(const [phase,a]of Object.entries(r.result?.modelAccounting||{})){const v=phases[phase]??={calls:0,durationMs:0};v.calls+=a.calls;v.durationMs+=a.durationMs;}
 const summaryAttempts=s.records.filter(r=>r.event==='summary_attempt');
 const failed=s.records.filter(r=>r.event==='summary_failed');
 const summaryCalls=requests.map((r,i)=>({r,w:wire[i]})).filter(({r})=>r.phase==='summary').map(({r,w})=>{
  const text=w.response.output.flatMap(x=>x.content||[]).map(x=>x.text||'').join('');let parsed;try{parsed=JSON.parse(text);}catch{}
  return {requestId:r.id,round:w.round,estimatedGeneratedPayload:parsed?estimate(parsed):null,providerOutputTokens:w.response.usage?.output_tokens};
 });
 results.push({batch,id:c.id,planned:c.turns.length,executed:rounds.filter(r=>r.result).length,blocked:rounds.filter(r=>r.status==='not_run').length,notReached:c.turns.length-rounds.length,phases,calls:wire.length,http200:wire.filter(w=>w.httpStatus===200).length,inputTokens:wire.reduce((n,w)=>n+(w.response.usage?.input_tokens||0),0),outputTokens:wire.reduce((n,w)=>n+(w.response.usage?.output_tokens||0),0),toolCalls:calls.length,toolErrors:returns.filter(r=>{try{return JSON.parse(r.output).ok===false;}catch{return false;}}).map(r=>({id:r.id,output:r.output})),summaries:Object.keys(s.summaries).length,summaryAttempts,summaryFailures:failed,summaryCalls,proposals:Object.values(s.approvals).filter(a=>a.kind==='proposal').length,mediaReceipts:Object.values(s.invocations).filter(a=>a.kind==='media').length,duplicateInputItems:wire.reduce((n,w)=>{const a=w.request.input.map(x=>JSON.stringify(x));return n+a.length-new Set(a).size;},0)});
}
const chat=read('primary/CHAT_VERSION/session.json');
const bad=chat.records.find(r=>r.id==='525522bc-89f8-4917-b9db-dcf0377d9183');
assert.equal(JSON.parse(bad.arguments).parentMessageId,'e9a24e91-496a-4734-ac3f-0126c38ed37c');
const before=chat.records.slice(0,chat.records.indexOf(bad));
const request=before.filter(r=>r.event==='model_request'&&r.phase==='agent').at(-1);
for(const id of ['46a959b4-c317-4721-bfd2-b5b5ef088513','e9a24e91-496a-4734-ac3f-0126c38ed37c'])assert.ok(JSON.stringify(request.input).includes(id),'Both original and short source IDs visible');
assert.equal(before.filter(r=>r.event==='summary_attempt').length,0,'No summary caused first wrong binding');
const diag=read('diagnostic/DIAG_SAVED_CONFIRM/session.json');
const receipts=Object.values(diag.invocations).filter(r=>r.kind==='media');assert.equal(receipts.length,2);
for(const r of receipts){assert.equal(r.mode,'simulation');assert.deepEqual(r.args,diag.approvals[r.proposalId].args);}
assert.ok(Object.values(diag.approvals).some(a=>a.replacesProposalId==='proposal_8b696c31eb2a6246f2d5be7ba3cf3420'));
assert.ok(!receipts.some(r=>r.proposalId==='proposal_8b696c31eb2a6246f2d5be7ba3cf3420'));
const button=read('diagnostic/DIAG_BUTTON/session.json');assert.equal(Object.values(button.invocations).filter(r=>r.kind==='media').length,1);
const observation=button.records.findIndex(r=>r.kind==='system_observation'&&r.name==='confirm_media');
assert.ok(observation>=0);assert.equal(button.records.slice(observation+1).find(r=>r.event==='model_request').phase,'agent');
const metrics={cases:results,total:Object.fromEntries(['planned','executed','blocked','notReached','calls','http200','inputTokens','outputTokens','summaries','proposals','mediaReceipts','duplicateInputItems'].map(k=>[k,results.reduce((n,c)=>n+c[k],0)])),assertions:'Wire completeness, tool pairing, wrong-parent visibility, frozen media args, replacement identity, receipt counts, button observation before Agent request verified offline. No model or media calls.'};
fs.writeFileSync(path.join(root,'forensic-metrics.json'),JSON.stringify(metrics,null,2)+'\n');
console.log(JSON.stringify({total:metrics.total,phases:results.map(c=>({id:c.id,phases:c.phases,failedSummaries:c.summaryFailures.length})),assertions:metrics.assertions},null,2));
