import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {buildContext,completeGroups,estimateTokens} from './context.mjs';
import {appendRecord,currentSummary,summarySourceHash,validateSummary} from './history.mjs';

const prompt=await readFile(new URL('./summary-prompt.md',import.meta.url),'utf8');
export const memoryDefaults=Object.freeze({enabled:true,triggerRatio:0.75,targetRatio:0.55,summaryMaxTokens:1800,inputMaxTokens:8000,maxCallsPerTurn:2,reserveMainCalls:2,safetyTokens:500});
export function memoryOptions(options={}){
  const o={...memoryDefaults,...options};
  if(typeof o.enabled!=='boolean'||!(o.targetRatio>0&&o.targetRatio<o.triggerRatio&&o.triggerRatio<1))throw new Error('Invalid summary thresholds');
  for(const k of ['summaryMaxTokens','inputMaxTokens','maxCallsPerTurn','reserveMainCalls','safetyTokens'])if(!Number.isInteger(o[k])||o[k]<(k==='safetyTokens'?0:1))throw new Error('Invalid summary budget: '+k);
  return o;
}

/** No business tools and no authority changes: derived memory only. */
export async function maintainMemory(state,{contextOptions,config,respond,save,remainingCalls,turnId,signal}){
  const options=memoryOptions(config);if(!options.enabled)return {calls:0};
  const view=()=>buildContext(state,{...contextOptions,untrimmed:true}).metrics;
  const effective=contextOptions.tokenBudget-contextOptions.reservedTokens-options.safetyTokens;
  const pressure=()=>{const m=view();return m.estimatedInputTokens+m.estimatedToolDefinitionTokens;};
  if(pressure()<effective*options.triggerRatio)return {calls:0};
  let calls=0;
  while(calls<options.maxCallsPerTurn&&remainingCalls()>options.reserveMainCalls&&pressure()>effective*options.targetRatio){
    const prior=currentSummary(state),from=(prior?.coveredToSeq??-1)+1;
    const users=state.records.map((r,seq)=>({r,seq})).filter(({r})=>r.kind==='message'&&r.role==='user');
    let protectFrom=users.at(-2)?.seq??users.at(-1)?.seq??0;
    const latestText=JSON.stringify(users.at(-1)?.r.content||'');
    for(const [seq,r]of state.records.entries())if(r.kind!=='run_event'&&latestText.includes(r.id))protectFrom=Math.min(protectFrom,seq);
    const seqById=new Map(state.records.map((r,i)=>[r.id,i]));
    const {groups,incomplete}=completeGroups(state.records.slice(from));
    let to=from-1;
    let source=[];
    const payload=records=>[{role:'system',content:prompt},{role:'user',content:JSON.stringify({summaryMaxTokens:options.summaryMaxTokens,previousSummary:prior,records})}];
    const inputBudget=Math.min(options.inputMaxTokens,effective-options.summaryMaxTokens);
    const groupByRecord=new Map(groups.flatMap(g=>g.records.map(r=>[r.id,g])));
    const ends=new Map(groups.map(g=>[g.id,Math.max(...g.records.map(r=>seqById.get(r.id)))]));
    for(let cursor=from;cursor<protectFrom;){
      let end=cursor,closed=true;
      // Close the whole contiguous range, including interleaved observer traces.
      for(let i=cursor;i<=end;i++){
        const group=groupByRecord.get(state.records[i].id);
        if(incomplete.has(group.id)){closed=false;break;}
        end=Math.max(end,ends.get(group.id));
        if(end>=protectFrom){closed=false;break;}
      }
      if(!closed)break;
      const candidate=state.records.slice(from,end+1).filter(r=>r.kind!=='run_event');
      if(estimateTokens(payload(candidate))>inputBudget)break;
      source=candidate;to=end;cursor=end+1;
    }
    if(to<from||!source.length)break;
    const sourceHash=summarySourceHash(state,from,to);
    if(state.records.some(r=>r.event==='summary_attempt'&&r.sourceHash===sourceHash))break;
    appendRecord(state,{kind:'run_event',event:'summary_attempt',sourceHash,coveredFromSeq:from,coveredToSeq:to,turnId});
    try{
      await save();
      signal?.throwIfAborted();calls++;
      const output=await respond(payload(source));
      if(!Array.isArray(output)||output.some(x=>x.type!=='message'||(x.status&&x.status!=='completed')))throw new Error('Summary must be complete text without tools');
      const text=output.flatMap(x=>x.content||[]).map(x=>x.text||'').join('');
      const generated=JSON.parse(text);
      if(Object.keys(generated).some(k=>!['summaryText','sourceRefs'].includes(k)))throw new Error('Summary model may only supply text and references');
      const summary={kind:'session_summary',schemaVersion:1,summaryId:'summary_'+randomUUID(),sessionId:state.id,coveredFromSeq:from,coveredToSeq:to,sourceHash,
        summaryText:generated.summaryText,sourceRefs:generated.sourceRefs,previousSummaryId:prior?.summaryId||null,generatorVersion:'session-summary-v1'};
      validateSummary(state,summary);
      if(estimateTokens(summary)>options.summaryMaxTokens)throw new Error('Summary exceeds its complete payload budget');
      state.summaries||={};state.summaries[summary.summaryId]=summary;
      try{await save();}catch(error){delete state.summaries[summary.summaryId];throw error;}
    }catch(error){
      appendRecord(state,{kind:'run_event',event:'summary_failed',sourceHash,message:error.message,turnId});
      // Failure never advances coverage. Original records and last valid summary stay intact.
      try{await save();}catch{}break;
    }
  }
  return {calls};
}
