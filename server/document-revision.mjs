import {revisionPrompt} from './prompt-text.mjs';
import {applyTextDelta,deltaSchema,projectStructuredDelta} from './text-delta.mjs';
// Preserve the source's document representation without prescribing its wording.
function valueSchema(value){
 if(Array.isArray(value))return {type:'array',items:value.length?valueSchema(value[0]):{}};
 if(value&&typeof value==='object')return {type:'object',additionalProperties:false,required:Object.keys(value),properties:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,valueSchema(v)]))};
 return {type:value===null?'null':typeof value};
}
export function revisionSchema(source){
 const document=source?.structure?{structure:valueSchema(source.structure)}:{content:{type:'string',minLength:1}};
 return {type:'object',additionalProperties:false,properties:{mode:{enum:['patch','rewrite','no_change']},edits:deltaSchema.properties.edits,...document},oneOf:[
  {required:['mode','edits'],properties:{mode:{const:'patch'}},not:{anyOf:[{required:['content']},{required:['structure']}]}},
  {required:['mode',...Object.keys(document)],properties:{mode:{const:'rewrite'}},not:{required:['edits']}},
  {required:['mode'],properties:{mode:{const:'no_change'}},not:{anyOf:[{required:['edits']},{required:['content']},{required:['structure']}]}}
 ]};
}
export const revisionInstructions=revisionPrompt;
export function applyRevision(source,contract,proposal,render){
 if(proposal.mode==='patch')return projectStructuredDelta(source,applyTextDelta(contract,proposal.edits),render);
 if(proposal.mode==='no_change')return projectStructuredDelta(source,applyTextDelta(contract,[]),render);
 if(proposal.mode!=='rewrite')throw new Error('文档修改缺少执行模式');
 const content=source.structure?render(proposal.structure):proposal.content;
 if(typeof content!=='string'||!content.trim())throw new Error('重写结果为空');
 return {...(source.structure?{structure:proposal.structure}:{}),content,noChange:content===contract.original,deltaEvidence:{mode:'rewrite',source:contract.source,request:contract.request,outsideSpansPreserved:false}};
}
