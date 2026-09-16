import {score as flowScore} from '../production24/scorer.mjs';
import {isDeepStrictEqual} from 'node:util';
import Ajv from 'ajv';
import {tools} from '../../server/tool-schemas.mjs';
const ajv=new Ajv({strict:false});
const validators=new Map(tools.filter(t=>['generate_image','generate_video'].includes(t.name)).map(t=>[t.name,ajv.compile(t.parameters)]));
export function score(c,t){
 const result=flowScore(c,t),store=t.state.taskStore||{},task=store.tasks?.[store.activeTaskId];
 const calls=t.calls||[],finals=t.state.events.filter(e=>e.type==='final');
 const toolCalls=t.state.messages.filter(m=>m.type==='function_call'),outputs=t.state.messages.filter(m=>m.type==='function_call_output');
 result.checks.toolsReturned=toolCalls.every(c=>outputs.filter(o=>o.call_id===c.call_id).length===1);
 result.checks.finalReturned=finals.length>=c.queries.length&&finals.every(e=>typeof e.text==='string'&&e.text.trim());
 result.checks.goalIntegrity=!!task&&task.items.every(i=>i.output==='text'||i.requiredEvidence==='none');
 // A final reporting node may consume both independent media results. It does
 // not create a dependency between the two media jobs or another media output.
 const isReport=i=>i.operation==='answer'&&task.goal.semantic?.deliverables?.[i.index]?.action==='respond';
 result.checks.intentOutputScope=!!task&&task.items.every(i=>i.output==='text'?!!(c.expect.text||c.expect.confirm||c.expect.dependency||isReport(i)):i.output==='image'?!!c.expect.image:i.output==='video'?!!(c.expect.video||c.fault==='unknown'):false);
 if(c.expect.independent)result.checks.independent=!!task&&task.items.filter(i=>i.output!=='text').every(i=>!i.dependsOn.length);
 result.checks.toolInputSchema=(t.submissions||[]).every(s=>validators.get(s.tool)?.(s.args));
 // Every generator must receive the raw user request; every media planning request
 // must receive the exact persisted structured item specification.
 result.checks.contextPreserved=calls.filter(x=>!x.phase).every(call=>{
  const system=call.input[0]?.content||'';let p;try{p=JSON.parse(call.input.find(m=>m.role==='user')?.content);}catch{return true;}
  const tasks=Object.values(store.tasks||{}),items=tasks.flatMap(t=>t.items),sources=Object.values(store.artifacts||{});
  const sourcesPreserved=ss=>Array.isArray(ss)&&ss.every(s=>!s.content||sources.some(a=>a.id===s.id&&a.content===s.content));
  if(system.includes('完成当前文字交付')){const owner=tasks.find(t=>t.items.some(i=>i.id===p.item?.id)),item=owner?.items.find(i=>i.id===p.item?.id);return !!item&&p.query===owner.query&&isDeepStrictEqual(p.item.spec,item.spec)&&isDeepStrictEqual(p.item.constraints,item.constraints)&&sourcesPreserved(p.sources);}
  if(system.includes('必须执行的媒体Skill'))return !!p.goal&&p.goal.count>0&&items.some(i=>i.description===p.goal.description&&isDeepStrictEqual(i.spec,p.goal.spec)&&isDeepStrictEqual(i.constraints,p.goal.constraints))&&sourcesPreserved(p.sources)&&Array.isArray(p.goal.references);
  return true;
 });
 result.checks.pollHasReceipt=(t.provider?.polledIds||[]).every(id=>!!t.provider.jobs[id]);
 if(c.forbiddenReference)result.checks.selectedReference=(t.submissions||[]).every(s=>![s.args.firstFrameUrl,...(s.args.referenceImages||[])].includes(c.forbiddenReference));
 if(c.expect.size)result.checks.size=(t.submissions||[]).some(s=>s.args.size===c.expect.size);
 if(c.contextMarker){const textCalls=calls.filter(x=>x.input[0]?.content.includes('完成当前文字交付')).map(x=>JSON.parse(x.input.find(m=>m.role==='user').content));const revisions=textCalls.filter(p=>p.item?.operation==='rewrite'&&task?.items.some(i=>i.id===p.item.id));result.checks.markerAtFirstGeneration=!!textCalls[0]&&JSON.stringify(textCalls[0]).includes(c.contextMarker);result.checks.originalSourceAtRevision=revisions.length>0&&revisions.every(p=>p.sources.some(s=>s.content));}
 result.flowPassed=Object.values(result.checks).every(Boolean)&&Object.values(result.hard).every(Boolean);
 const probes=t.finalProbes||[];result.finalModelPassed=probes.length===1&&probes.every(p=>p.ok);
 result.passed=result.flowPassed&&result.finalModelPassed;
 result.modelRepairs=calls.filter(x=>x.input.some(m=>m.role==='system'&&/结构或合同校验失败|系统格式\/一致性校验反馈|Goal合同核验反馈/.test(m.content||''))).length;
 result.withoutModelRepair=result.passed&&result.modelRepairs===0;
 result.sourceId=c.sourceId;result.repeat=c.repeat;result.finalAnswerOrigin='production:template; separate probe:real-model';
 result.classification=result.passed?'chain_passed':'chain_failed';
 return result;
}
