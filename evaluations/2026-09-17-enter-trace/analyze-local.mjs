// Read only a locally supplied snapshot. No model/network calls or raw query export.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {completeGroups,estimateTokens} from '../../server/context-agent/context.mjs';
import {maintainMemory,memoryDefaults} from '../../server/context-agent/memory.mjs';
import {loadAgentCatalog} from '../../server/context-agent/skills.mjs';
if(!process.argv[2])throw new Error('Pass a local exported session JSON');
const raw=await readFile(process.argv[2],'utf8'),state=JSON.parse(raw);
const request=state.records.filter(r=>r.event==='model_request').at(-1),turnId=request.turnId;
const requests=state.records.filter(r=>r.event==='model_request'&&r.turnId===turnId);
const originalCoverage=Object.values(state.summaries).at(-1).coveredToSeq;
const group=completeGroups(state.records.slice(originalCoverage+1)).groups.find(g=>g.records.some(r=>r.kind!=='run_event'));
let modelCallbacks=0;
const result=await maintainMemory(state,{contextOptions:{systemPrompt:request.input[0].content,skillDirectory:(await loadAgentCatalog()).skills.map(({slug,name,description})=>({slug,name,description})),toolDefinitions:request.tools,tokenBudget:24000,reservedTokens:6000,currentTurnId:turnId},config:memoryDefaults,respond:async()=>{modelCallbacks++;throw new Error('Offline diagnostic prohibits model calls');},save:async()=>{},remainingCalls:()=>16,turnId,signal:new AbortController().signal});
const evidence={snapshotSha256:createHash('sha256').update(raw).digest('hex'),recordCount:state.records.length,summaryCount:Object.keys(state.summaries).length,originalCoverage,coverageAfter:Object.values(state.summaries).at(-1).coveredToSeq,firstUncoveredGroupTokens:estimateTokens(group.records.filter(r=>r.kind!=='run_event')),summaryInputLimit:memoryDefaults.inputMaxTokens,memoryResult:result,modelCallbacks,lastTurn:state.records.filter(r=>r.event==='end').at(-1).result.status,decisions:requests.map(r=>({step:r.step,omitted:r.metrics.omittedRecords,estimatedInputTokens:r.metrics.estimatedInputTokens,retainedSuccessfulSkills:state.records.filter(x=>x.kind==='tool_result'&&r.metrics.retainedRecordIds.includes(x.id)).map(x=>JSON.parse(x.output)).filter(x=>x.ok&&x.slug).map(x=>({slug:x.slug,reference:x.reference})),currentUserRetained:state.records.filter(x=>x.kind==='message'&&x.role==='user'&&x.turnId===turnId).every(x=>r.metrics.retainedRecordIds.includes(x.id))}))};
await writeFile(new URL('./diagnostic.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({firstUncoveredGroupTokens:evidence.firstUncoveredGroupTokens,summaryInputLimit:evidence.summaryInputLimit,modelCallbacks,coverageAfter:evidence.coverageAfter,decisions:requests.length}));
