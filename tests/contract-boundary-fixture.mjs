import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Agent} from './runtime-model-fixture.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Verifier} from '../server/verification.mjs';
export const catalog=await loadCatalog();
export const reply=v=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(v)}]}];
export const signal=()=>AbortSignal.timeout(15000);
export const contract=(deliverables,extra={})=>({summary:'边界测试',turnOperation:{kind:'create'},deliverables,safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''},...extra});
export const textItem=(extra={})=>({description:'文字结果',kind:'text',action:'create',form:'copy',count:1,...extra});
export const archived=(id,file)=>JSON.parse(fs.readFileSync(new URL('../evaluations/2026-09-16-language-variants/'+id+'/'+file+'.json',import.meta.url)));
export const rawDraft=id=>JSON.parse(archived(id,'state').modelCalls[0].output[0].content[0].text);
export function fixture({draft,generate=()=>({content:'完整文字'}),judge=()=>({outcome:'passed',issues:[]}),policy='delivery_only'}={}){
 const state={id:'boundary-'+crypto.randomUUID(),messages:[],events:[],assets:[]},calls=[];let generation=0,submissions=0;
 const brain={respond:async(input,_tools,_signal,options)=>{
  const part=input[1].content,p=JSON.parse(typeof part==='string'?part:part.find(x=>x.type==='input_text').text);
  calls.push({phase:options.tracePhase,input:structuredClone(input)});
  const captured=value=>{const output=reply(value);calls.at(-1).output=structuredClone(output);return output;};
  if(options.tracePhase==='understand')return captured(typeof draft==='function'?draft(p):draft);
  if(options.tracePhase==='text_generation')return captured(generate(p,++generation));
  if(options.tracePhase==='extract_confirmation_gate')return captured({required:true,evidence:p.query});
  if(options.tracePhase==='verify_turn_operation')return captured({operation:'approve',evidence:p.query});
  if(options.tracePhase.startsWith('verify_'))return captured(judge(p,options.tracePhase));
  if(options.tracePhase==='media_plan'){
   const schema=JSON.parse(input[0].content.split('Schema：').at(-1)),fields=schema.properties.items.items.properties;
   return captured({concept:'已保存方案',preservedConstraints:[],safety:{passed:true,reason:'普通场景'},items:[{prompt:'测试用静物，无人物无文字',...(fields.size?{size:'1440x2560'}:{duration:5,ratio:'9:16'})}]});
  }
  assert.fail('unexpected phase '+options.tracePhase);
 }};
 const media={config:{imageModel:'offline-only',videoModel:'offline-only'},image:async()=>{submissions++;throw Error('No paid calls in offline tests');},video:async()=>{submissions++;throw Error('No paid calls in offline tests');}};
 const runtime=new ToolRuntime({catalog,brain,media}),agent=new Agent({brain,runtime,catalog,actionMode:'core',effectPolicy:'explicit_approval',verifier:new Verifier(brain,{policy})});
 return {state,calls,agent,submissions:()=>submissions,run:query=>agent.run(state,query,()=>{},signal())};
}
