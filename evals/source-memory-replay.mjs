// Offline replay of archived evidence. No adapter, model, vision or media calls.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {summaryBudget,memoryDefaults} from '../server/context-agent/memory.mjs';
import {estimateTokens} from '../server/context-agent/context.mjs';
const root=new URL('../evaluations/2026-09-17-multiturn-real/',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL(name,root),'utf8'));
const out=resolve(process.argv[2]||'evaluation-runs/source-memory-replay');await mkdir(out,{recursive:true});
const tools=createTools(),chat=await read('primary/CHAT_VERSION/session.json');
const bad=chat.records.find(r=>r.id==='525522bc-89f8-4917-b9db-dcf0377d9183'),long=chat.records.find(r=>r.id==='46a959b4-c317-4721-bfd2-b5b5ef088513');
const args=JSON.parse(bad.arguments),short=chat.records.find(r=>r.id===args.parentMessageId),state=createSession();
for(const r of [long,short])appendRecord(state,{id:r.id,kind:'message',role:r.role,content:r.content});
const context=id=>({state,ownerId:state.ownerId,turnId:'offline-replay',callId:id,fromModel:true,save:async()=>{}});
const missingQuote=await tools.execute('save_document',args,context('legacy-args'));
assert.equal(missingQuote.error.code,'source_text_required');
const conflictingQuote=await tools.execute('save_document',{...args,sourceText:long.content},context('mismatch'));
assert.equal(conflictingQuote.error.code,'original_content_mismatch');assert.equal(Object.keys(state.assets).length,0);
const repaired=await tools.execute('save_document',{...args,parentMessageId:long.id,sourceText:long.content},context('matching'));
assert.equal(repaired.parentEvidence.content,long.content);assert.equal(repaired.asset.content,args.content);
await writeFile(join(out,'parent-replay.json'),JSON.stringify({historicalCallId:bad.id,missingQuote,conflictingQuote,repaired,state},null,2));

const memory=await read('primary/LONG_MEMORY/session.json'),original=memory.records.find(r=>r.id==='cbf076f4-1775-4658-b8f7-91e65403f1e5');
const body=original.content.slice(original.content.indexOf('青禾茶铺原稿：')).trim();
const bodyState=createSession();appendRecord(bodyState,{id:original.id,kind:'message',role:original.role,content:original.content});
const revised=await tools.execute('save_document',{parentMessageId:original.id,sourceText:body,content:body.replace('18元','20元')},{state:bodyState,ownerId:bodyState.ownerId,turnId:'replay',callId:'body',fromModel:true,save:async()=>{}});
assert.equal(revised.parentEvidence.content,body);assert.equal(bodyState.records[0].content,original.content);assert.ok(!revised.parentEvidence.content.startsWith('记录以下'));
await writeFile(join(out,'body-replay.json'),JSON.stringify({original,body,revised,state:bodyState},null,2));

const wire=await read('primary/LONG_MEMORY/transport.json');
const summaries=wire.filter(w=>w.request.input?.some(m=>typeof m.content==='string'&&m.content.includes('"summaryMaxTokens"'))).map(w=>{
 const payload=JSON.parse(w.request.input.find(m=>typeof m.content==='string'&&m.content.startsWith('{')&&m.content.includes('"summaryMaxTokens"')).content);
 const generated=JSON.parse(w.response.output.flatMap(x=>x.content||[]).map(x=>x.text||'').join(''));
 const envelope={kind:'session_summary',schemaVersion:1,summaryId:'summary_offline-comparison',sessionId:memory.id,coveredFromSeq:0,coveredToSeq:100,sourceHash:'0'.repeat(64),previousSummaryId:payload.previousSummary?.summaryId||null,generatorVersion:'session-summary-v1'};
 const target=summaryBudget(memory,memoryDefaults,envelope);
 return {historicalRound:w.round,generatedEstimatedTokens:estimateTokens(generated),completeEstimatedTokens:estimateTokens({...envelope,...generated}),historicalLimit:payload.summaryMaxTokens,newExplicitTarget:target};
});
assert.ok(summaries.some(s=>s.completeEstimatedTokens>s.historicalLimit));
await writeFile(join(out,'summary-budget-comparison.json'),JSON.stringify(summaries,null,2));
const result={status:'passed',checks:['historical-missing-source-text-rejected','wrong-parent-and-intended-quote-rejected','correct-parent-body-bound','wrapper-excluded-original-retained','historical-summary-total-budget-compared'],realModelCalls:0,realMediaCalls:0,note:'This supplies the intended original explicitly. It does not prove the model autonomously chooses it or compresses accurately.'};
await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
