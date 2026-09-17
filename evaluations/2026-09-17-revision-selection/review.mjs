// Offline evidence audit. Human judgments are explicit and kept separate from
// the original exact-string checks; never rewrites model output or expected.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('./',import.meta.url),real=new URL('real/',root);
const read=async name=>JSON.parse(await readFile(new URL(name,real),'utf8'));
const raw=await read('results.json'),fixtures=(await read('fixtures.json')).cases;
const rows=[],totals={networkCalls:0,inputTokens:0,outputTokens:0,totalTokens:0};
function usage(wire){for(const t of wire){totals.networkCalls++;assert.equal(t.status,200);const u=t.response.usage||{};totals.inputTokens+=u.input_tokens||0;totals.outputTokens+=u.output_tokens||0;totals.totalTokens+=u.total_tokens||0;}}
for(const r of raw){
 const full=await read(r.id+'.json');usage(full.transport);const c=fixtures.find(c=>c.id===r.caseId);
 let accepted=false,reason;
 if(r.check?.exactExpected){accepted=true;reason='精确完成用户指定替换，未变部分逐字一致。';}
 else if(r.caseId==='background'&&full.content===c.original.replace('米白背景','浅蓝色背景')){accepted=true;reason='人工复核：浅蓝色背景与用户要求等价，其余字符完全相同；原精确匹配误判保留。';}
 else if(r.caseId==='tone'&&r.check?.outsidePreserved&&r.check.targetChanged){accepted=true;reason='人工阅读正文：中段转为日常店员口吻，茶名、无糖与18元保留；未新增事实，标题末段不变。';}
 else reason=r.caseId==='tone'?'强调保持的全文输出两次原样返回，没有落实语气修改。':'未通过，需要人工复核。';
 rows.push({...r,semanticAccepted:accepted,reviewReason:reason});
}
const comparison=[];for(const method of ['whole','edits','segments'])for(const version of ['concise','explicit']){const subset=rows.filter(r=>r.method===method&&r.version===version);comparison.push({method,version,n:subset.length,exactOrScopeChecks:subset.filter(r=>r.check?.exactExpected||(r.check?.outsidePreserved&&r.check.targetChanged)).length,semanticAccepted:subset.filter(r=>r.semanticAccepted).length,totalTokens:subset.reduce((n,r)=>n+(r.usage?.total_tokens||0),0)});}
const sourceRuns=[];
for(const id of ['older_long','other_product','selected_short']){const x=await read(id+'.json');usage(x.transport);assert.equal(x.checks.savedCorrectParent,true);assert.equal(x.checks.savedExpected,true);sourceRuns.push({id,...x.checks,modelCalls:x.result.modelCalls,initialMultipleCallRejection:x.state.records.some(r=>r.kind==='tool_result'&&r.output.includes('not_executed')),replyReview:'人工核对最终回复与实际保存正文一致；前两组存在多调用整组拒绝后恢复，不计零错误路径。'});}
assert.equal(totals.networkCalls,95);assert.equal((await read('ledger.json')).calls,95);
const historical=JSON.parse(await readFile(new URL('historical-saved-replies.json',root),'utf8'));
const historicalReview=historical.map((r,i)=>({index:i,file:r.file,turnId:r.turnId,classification:i===0?'substantive_saved_reply_conflict':i===7?'presentation_difference':i===1||i===4?'separate_lineage_issue':'no_saved_reply_conflict',reason:i===0?'保存18元却明确声称并展示20元。':i===7?'脚本回复正文有强调格式和说明差异；核心脚本相同，未发现价格/行动承诺反向。':i===1||i===4?'历史父稿选择有独立问题，回答与实际所保存正文并未反向，不能混入此项计数。':'逐项对照所保存正文和最终说明，未发现实质冲突。'}));
await writeFile(new URL('review.json',root),JSON.stringify({validation:'human semantic review plus deterministic evidence audit, not a new model review',totals,comparison,rows,sourceRuns,historical:{reviewedSavedTurns:historical.length,substantiveConflicts:1,presentationDifferences:1,notes:'不同版本与样本，不是发生率估计；同一LONG_MEMORY两次一成一败，不能证明稳定复现，本轮不加回答拦截。',rows:historicalReview}},null,2)+'\n');
console.log(JSON.stringify({totals,comparison,sourceRuns},null,2));
