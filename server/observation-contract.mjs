import {createHash} from 'node:crypto';
import {resolveSources,resolveSupportingSources} from './sources.mjs';
import {withNode} from './trace-context.mjs';
const identity=source=>createHash('sha256').update(JSON.stringify([source.id,source.version||1,source.url])).digest('hex');
const collectionIdentity=sources=>sources.map(identity).join(':');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique=items=>[...new Map(items.map(value=>[JSON.stringify(value),value])).values()];
// One pure construction for writing, reading and cache identity. No attribute inference.
export function observationQuestion(item,sources,state={}){
 const task=state.taskStore?.tasks?.[state.taskStore.activeTaskId],semantic=task?.goal?.semantic||{};
 const providedFacts=task?.contract?.facts||semantic.facts||[];
 const unknownFacts=unique([...(task?.contract?.unknownFacts||[]),...(semantic.unknownFacts||[]),...(semantic.gaps||[]).filter(g=>g.level==='factual').map(g=>g.description)]);
 const userConstraints=unique([...(task?.contract?.globalConstraints||semantic.globalConstraints||[]),...(item.constraints||[])]);
 const sourceExcerpts=sources.filter(s=>typeof s.content==='string'&&s.content).map(s=>({id:s.id,version:s.version||1,text:s.content,provenance:s.provenance}));
 if(task?.query)sourceExcerpts.unshift({id:task.requestId||task.id,version:task.revision||1,text:task.query,origin:'user_request'});
 for(const segment of item.evidenceSegments||[])if(segment.text)sourceExcerpts.push({id:segment.messageId,version:1,text:segment.text,origin:'user_evidence'});
 return JSON.stringify({question:item.description,...(providedFacts.length?{providedFacts}:{}),...(unknownFacts.length?{unknownFacts}:{}),...(userConstraints.length?{userConstraints}:{}),...(sourceExcerpts.length?{sourceExcerpts:unique(sourceExcerpts)}:{})});
}
export function imageObservationInputs(item,sources,state={}){
 if(item.requiredEvidence!=='image')return [];
 const images=sources.filter(s=>s.type==='image'&&s.url);
 if(!images.length)throw new Error('观察合同没有绑定图片来源');
 const question=observationQuestion(item,sources,state),sourceSet=collectionIdentity(images),seen=new Map();
 return images.map((source,index)=>{
  const found=(item.observations||[]).find(o=>o.tool==='analyze_image'&&!o.result?.isError&&o.result?.text?.trim()&&o.source?.id===source.id&&o.source?.version===(source.version||1)&&o.source?.digest===identity(source)&&o.args?.question===question&&o.sourceSet===sourceSet);
  if(!found)throw new Error('缺少当前图片版本和问题的观察回执：'+source.id);
  const resultId=digest([sourceSet,question,found.result]),prior=seen.get(resultId);seen.set(resultId,prior??index);
  return {source:found.source,inputIndex:index+1,checker:found.checker,...(prior===undefined?{resultId,question:found.args.question,result:found.result}:{resultRef:resultId})};
 });
}
export async function observeImages(executor,item,signal){
 if(item.requiredEvidence!=='image')return;
 const sources=[...resolveSources(executor.state,item),...resolveSupportingSources(executor.state,item)],images=sources.filter(s=>s.type==='image'&&s.url);
 if(!images.length)throw Object.assign(new Error('缺少实际图片，无法进行画面分析'),{code:'missing_observation_source'});
 item.observations??=[];
 try{return imageObservationInputs(item,sources,executor.state);}catch{}
  const args={...(images.length===1?{url:images[0].url}:{urls:images.map(s=>s.url)}),question:observationQuestion(item,sources,executor.state)};
  const result=await withNode(item.id,'image_observation',()=>executor.runtime.execute('analyze_image',args,executor.state,signal));
  if(result.isError||!result.text?.trim())throw new Error(result.error||'图像观察没有返回可用正文');
  for(const source of images)item.observations.push({tool:'analyze_image',args,result,source:{id:source.id,version:source.version||1,digest:identity(source)},sourceSet:collectionIdentity(images),checker:'vision_model'});
  await executor.record('analyze_image',args,result);await executor.save(executor.state);
 return imageObservationInputs(item,sources,executor.state);
}
