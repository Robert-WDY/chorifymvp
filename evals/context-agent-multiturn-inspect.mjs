// Full-trace indexing and mechanical evidence only. Business verdicts require human review.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]||'evaluation-runs/multiturn-20260917-review');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const overview=[];
for(const directory of await readdir(root,{withFileTypes:true})){
 if(!directory.isDirectory())continue;const p=join(root,directory.name);
 let state,rounds,transport;try{state=JSON.parse(await readFile(join(p,'session.json')));rounds=JSON.parse(await readFile(join(p,'rounds.json')));transport=JSON.parse(await readFile(join(p,'transport.json')));}catch{continue;}
 const items={},requests=[];
 for(const [index,wire]of transport.entries()){
  const ids=(wire.request.input||[]).map(item=>{const id=hash(item);items[id]=item;return id;});
  requests.push({call:index+1,round:wire.round,httpStatus:wire.httpStatus,startedAt:wire.startedAt,finishedAt:wire.finishedAt,inputIds:ids,exactDuplicateItems:ids.length-new Set(ids).size,requestCharacters:JSON.stringify(wire.request).length,outputTokens:wire.response?.usage?.output_tokens,inputTokens:wire.response?.usage?.input_tokens,usage:wire.response?.usage,error:wire.error});
 }
 await writeFile(join(p,'model-input-index.json'),JSON.stringify({note:'Lossless deduplication: each ordered request points to complete exact wire input items below. Original requests/responses remain transport.json.',requests,items},null,2));
 const transcript=[];
 for(const r of state.records){
  if(r.kind==='message')transcript.push(`\n${r.role.toUpperCase()} ${r.id}\n${r.content}`);
  if(r.kind==='tool_call')transcript.push(`\nTOOL CALL ${r.id} ${r.callId} ${r.name}\n${r.arguments}`);
  if(r.kind==='tool_result'||r.kind==='system_observation')transcript.push(`\n${r.kind.toUpperCase()} ${r.id} ${r.callId||r.name}\n${r.output}`);
  if(r.kind==='run_event'&&['summary_failed','model_error'].includes(r.event))transcript.push(`\nRUNTIME ${JSON.stringify(r)}`);
 }
 transcript.push('\nSUMMARIES\n'+JSON.stringify(state.summaries,null,2),'\nASSETS\n'+JSON.stringify(state.assets,null,2),'\nAPPROVALS\n'+JSON.stringify(state.approvals,null,2),'\nRECEIPTS\n'+JSON.stringify(state.invocations,null,2));
 await writeFile(join(p,'full-transcript.txt'),transcript.join('\n'));
 overview.push({id:directory.name,rounds:rounds.map(r=>({round:r.round,status:r.result?.status,modelCalls:r.result?.modelCalls,toolCalls:r.result?.toolCalls,accounting:r.result?.modelAccounting})),requests:requests.map(({inputIds,usage,...r})=>({...r,inputItems:inputIds.length})),summaryCount:Object.keys(state.summaries).length,summaryFailures:state.records.filter(r=>r.event==='summary_failed').map(r=>({id:r.id,message:r.message})),assets:Object.values(state.assets).map(a=>({id:a.id,type:a.type,title:a.title,version:a.version,parentId:a.parentId,sourceMessageId:a.sourceMessageId,sourceIds:a.sourceIds})),mediaReceipts:Object.values(state.invocations).filter(i=>i.kind==='media').map(i=>({receiptId:i.receiptId,proposalId:i.proposalId,status:i.status,simulated:i.mode==='simulation'}))});
}
await writeFile(join(root,'mechanical-evidence.json'),JSON.stringify(overview,null,2));
console.log(JSON.stringify(overview.map(c=>({id:c.id,rounds:c.rounds.length,calls:c.requests.length,summaries:c.summaryCount,summaryFailures:c.summaryFailures,mediaReceipts:c.mediaReceipts.length})),null,2));
