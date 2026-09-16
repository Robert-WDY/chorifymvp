import assert from 'node:assert/strict';
import {Agent as CompiledAgent} from '../server/agent.mjs';
import {Agent as RuntimeAgent} from '../server/agent-loop.mjs';
import {renderFacts} from '../server/runtime-facts.mjs';

// Existing fixture queues describe intake/planning/execution calls. The new
// presentation stage has its own response and ledger; it must not consume a
// future planning response. No production path or assertion is bypassed.
export function finalFixtureText(context){
 if(context.facts){
  // The fixture reads the same in-request pointers available to the composer.
  const facts=structuredClone(context.facts);
  if(facts.completion)facts.completion=facts.completion.map(c=>c.contextRef?context.state.selectedTasks[Number(c.contextRef.split('/').at(-1))]:c);
  if(facts.tasks)facts.tasks=facts.tasks.map(t=>{if(!t.savedPlanRef)return t;const p=context.savedPlans[Number(t.savedPlanRef.split('/').at(-1))];return {...t,approval:p.approval,proposals:p.proposals,batches:p.parameters?{saved:{items:p.parameters}}:undefined};});
  return renderFacts(facts);
 }
 return context.executionMessage||'本轮记录已保存。';
}
// Translate a fixture's corrected values into the real field-patch wire format.
// Production tests that intentionally submit a whole plan do not use this helper.
export function fieldPatchFor(input,corrected){
 const request=JSON.parse(input.find(m=>m.role==='user').content);
 assert.ok(request.paths?.length,'expected a concrete field-repair request');
 return Object.fromEntries(request.paths.map(path=>{
  const value=path.split('/').slice(1).reduce((v,k)=>v?.[k.replace(/~1/g,'/').replace(/~0/g,'~')],corrected);
  return [request.fieldKeys[path],request.removePaths?.includes(path)?null:value??[]];
 }));
}
export function withFinalFixture(brain){
 const finalResponses=[];
 const wrapped=Object.create(brain);
 wrapped.respond=async(input,tools,signal,options)=>{
  if(options?.tracePhase!=='final_response')return brain.respond(input,tools,signal,options);
  assert.deepEqual(tools,[]);
  const context=JSON.parse(input[1].content);
  assert.equal(typeof context.query,'string');assert.ok(context.state);
  const text=finalFixtureText(context);
  finalResponses.push({input:structuredClone(input),options:structuredClone(options),text});
  return [{type:'message',content:[{type:'output_text',text}]}];
 };
 return {brain:wrapped,finalResponses};
}
function fixtureAgent(Base){return class extends Base{
 constructor(options){const fixture=withFinalFixture(options.brain);super({...options,brain:fixture.brain});this.finalResponses=fixture.finalResponses;}
};}
export const Agent=fixtureAgent(CompiledAgent);
export const LegacyAgent=fixtureAgent(RuntimeAgent);
