export const operationAliases={propose_image_batch:'generate_image',propose_video_batch:'generate_video'};
const setEqual=(a,b)=>JSON.stringify([...new Set(a)].sort())===JSON.stringify([...new Set(b)].sort());
export function scoreCase(c,state){
 const goal=state.goal,events=state.events||[];
 const returned=events.filter(e=>e.type==='tool_result'&&!e.result?.isError);
 const called=returned.map(e=>e.name);
 const actualOps=goal?.tasks.map(t=>t.operation)||[];
 const clarification=!!goal&&(goal.needsClarification||state.status==='needs_input');
 const dependency=!!goal?.tasks.some(t=>t.dependsOn.length);
 const raw={schema:!!goal,operations:!!goal&&setEqual(actualOps,c.expected.operations),clarification:!!goal&&clarification===c.expected.needClarification,dependency:!!goal&&dependency===c.expected.dependency};
 // Compatibility is reported separately, never substituted for original exact scoring.
 const projected=[...actualOps];
 if(called.includes('find_material'))projected.push('find_material');
 if(called.some(n=>['search_history','read_current_deliverables'].includes(n)))projected.push('history_reference','读取历史方案');
 if(clarification)projected.push('clarification');
 const requiredCoverage=c.expected.operations.every(op=>projected.includes(operationAliases[op]||op)||called.includes(op));
 const noUnexpectedExecution=c.expected.operations.length>0||!returned.some(e=>['generate_image','edit_image','generate_video','generate_voiceover','clone_voice','propose_lipsync','slice_video','propose_video_upscale','propose_video_replication','merge_videos'].includes(e.name));
 const compatible={schema:!!goal,requiredOperations:!!goal&&requiredCoverage&&noUnexpectedExecution,clarification:raw.clarification,dependency:raw.dependency};
 const artifacts={images:new Set(returned.flatMap(e=>(e.result.images||[]).map(i=>i.url))).size,videos:new Set(returned.flatMap(e=>e.result.videoUrl?[e.result.videoUrl]:[])).size,audio:new Set(returned.flatMap(e=>e.result.audioUrl?[e.result.audioUrl]:[])).size,textCommits:(state.deliverables||[]).length};
 const last=events.findLast(e=>e.type==='final');
 const readOnlyExpected=c.category==='intent'||[149,154,159,164,169].includes(Number(c.id.slice(1)));
 const writes=returned.filter(e=>['generate_image','edit_image','generate_video','generate_voiceover','clone_voice','propose_lipsync','slice_video','propose_video_upscale','propose_video_replication','merge_videos'].includes(e.name));
 const knownURLs=new Set(returned.flatMap(e=>[...(e.result.images||[]).map(i=>i.url),e.result.videoUrl,e.result.audioUrl,...(e.result.scenes||[]).map(s=>s.videoUrl)]).filter(Boolean));
 const answerURLs=[...(last?.text||'').matchAll(/https?:\/\/[^\s<>"\)\]，。；]+/g)].map(m=>m[0]);
 const expectedMediaCount=c.category==='image_creation'?{kind:'images',count:[33,41,49,57].includes(Number(c.id.slice(1)))?3:1}:c.category==='video_creation'?{kind:'videos',count:[82,88,94,100,106].includes(Number(c.id.slice(1)))?10:1}:null;
 return {raw,rawPassed:Object.values(raw).every(Boolean),compatible,compatiblePassed:Object.values(compatible).every(Boolean),actualOps,called,artifacts,
  answerReturned:!!last?.text?.trim(),status:state.status,hasToolError:events.some(e=>e.type==='tool_result'&&e.result?.isError),
  forbiddenGeneration:readOnlyExpected?writes.length>0:null,
  mediaCountCheck:expectedMediaCount?{...expectedMediaCount,actual:artifacts[expectedMediaCount.kind],passed:artifacts[expectedMediaCount.kind]===expectedMediaCount.count}:null,
  unsupportedAnswerURLs:answerURLs.filter(url=>!knownURLs.has(url)),
  // This only verifies observable output, not whether prose fulfils every semantic requirement.
  completedWithObservableOutput:state.status==='completed'&&!!last?.text?.trim()};
}
export function auditDataset(cases){
 const queries=new Map(),exact=new Map();
 for(const c of cases){const key=JSON.stringify([c.query,c.history]);if(!queries.has(key))queries.set(key,[]);queries.get(key).push(c);const full=JSON.stringify([c.query,c.history,c.expected]);if(!exact.has(full))exact.set(full,[]);exact.get(full).push(c.id);}
 return {rows:cases.length,uniqueQueries:new Set(cases.map(c=>c.query)).size,uniqueInputContexts:queries.size,uniqueInputAndLabels:exact.size,
  categoryCounts:Object.fromEntries([...new Set(cases.map(c=>c.category))].map(k=>[k,cases.filter(c=>c.category===k).length])),
  duplicates:[...exact.values()].filter(ids=>ids.length>1),
  conflictingLabels:[...queries.values()].filter(g=>new Set(g.map(c=>JSON.stringify(c.expected))).size>1).map(g=>({query:g[0].query,ids:g.map(c=>c.id),labels:g.map(c=>({id:c.id,expected:c.expected}))})),
  historyWithoutAssets:cases.filter(c=>c.history.length&&!c.assets?.length).map(c=>c.id),
  nonNativeOperationLabels:['propose_image_batch','propose_video_batch','find_material','history_reference','clarification','读取历史方案']};
}
