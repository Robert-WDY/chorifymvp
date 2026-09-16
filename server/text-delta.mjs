import {createHash} from 'node:crypto';
export const deltaSchema={type:'object',additionalProperties:false,required:['edits'],properties:{edits:{type:'array',minItems:0,maxItems:20,items:{type:'object',additionalProperties:false,required:['before','after'],properties:{before:{type:'string',minLength:1},after:{type:'string'}}}}}};
export function bindDelta(item,sources){
 if(!item.changeContract)return null;
 const explicit=sources.filter(s=>s.type==='text'&&s.content&&item.references?.includes(s.id));const candidates=explicit.length?explicit:sources.filter(s=>s.type==='text'&&s.content);
 if(candidates.length!==1)throw new Error('局部修订需要唯一的原文版本');
 const source=candidates[0];const expected=item.changeContract.source;if(expected&&(expected.id!==source.id||expected.version!==(source.version||1)||expected.contentHash!==createHash('sha256').update(source.content).digest('hex')))throw new Error('修改源版本已变化，必须重新绑定');return {...item.changeContract,source:{id:source.id,version:source.version||1,contentHash:createHash('sha256').update(source.content).digest('hex')},original:source.content};
}
export function applyTextDelta(contract,edits){
 if(!edits.length&&!contract.allowNoChange)throw new Error('本轮修改未声明允许无变化');
 const original=contract.original,spans=edits.map(e=>{const start=original.indexOf(e.before);if(!e.before||start<0||original.indexOf(e.before,start+1)>=0)throw new Error('修改片段必须唯一匹配原文，不能猜测或全文重写');return {...e,start,end:start+e.before.length};}).sort((a,b)=>a.start-b.start);
 if(spans.some((s,i)=>i&&s.start<spans[i-1].end))throw new Error('修改片段重叠');
 let content=original;for(const s of spans.toReversed())content=content.slice(0,s.start)+s.after+content.slice(s.end);
 return {content,noChange:content===original,deltaEvidence:{source:contract.source,request:contract.request,edits:spans.map(({before,after,start,end})=>({before,after,start,end})),outsideSpansPreserved:true}};
}
export function projectStructuredDelta(source,result,render){
 if(!source?.structure||render(source.structure)!==source.content)return result;
 const structure=structuredClone(source.structure);
 for(const edit of result.deltaEvidence.edits){
  const matches=[];
  const walk=(v)=>{for(const [k,x] of Object.entries(v)){if(typeof x==='string'&&x.includes(edit.before))matches.push({v,k,x});else if(x&&typeof x==='object')walk(x);}};walk(structure);
  if(matches.length!==1)throw new Error('结构文档增量须分别定位一个字段内的原文片段，不能跨字段修改');
  const {v,k,x}=matches[0];v[k]=x.replace(edit.before,edit.after);
 }
 if(render(structure)!==result.content)throw new Error('结构与正文增量不一致，拒绝发布');
 return {...result,structure};
}
