import {isDeepStrictEqual} from 'node:util';
// Interpret a model proposal against durable state; never mutate the old task.
export function reconcileContinuation(value,snapshot){
 const s=structuredClone(value),c=s.continuation;
 if(!snapshot?.id||c?.taskId!==snapshot.id||!['continue','approve','clarify'].includes(c.mode))return s;
 const incoming=s.deliverables||[],previous=snapshot.goal?.semantic?.deliverables||[];
 if(snapshot.status==='NEEDS_INPUT'){
  if(incoming.length&&!s.gaps.some(g=>g.level==='blocking')){
   c.mode='clarify';
   // Missing fixed specifications are inherited for the same unresolved result.
   for(const p of previous){
    const matches=incoming.filter(d=>p.kind===d.kind&&p.action===d.action);
    if(matches.length!==1)throw new Error('补充输入不能遗漏或歧义匹配原交付；请保留完整目标，改变目标使用revise');
    const d=matches[0];
    if(d.count!==p.count||(p.constraints||[]).some(v=>!d.constraints.includes(v))||Object.entries(p.spec||{}).some(([k,v])=>d.spec?.[k]!==undefined&&!isDeepStrictEqual(d.spec[k],v)))throw new Error('补充输入不能丢失或改变原数量、约束和规格；请逐字保留原约束，改变目标使用revise');
    d.spec={...p.spec,...d.spec};
   }
   if(snapshot.approval?.required)s.approval.required=true;
  }
  return s;
 }
 if(c.mode==='clarify')return s;
 // A modification of an already delivered artifact is a new revision even if
 // the model accidentally labels it "continue" or "approve".
 const delivered=new Set((snapshot.artifacts||[]).filter(a=>(a.purpose===undefined||a.purpose==='deliverable')&&['passed','simulated_passed'].includes(a.verification?.semantic)).flatMap(a=>[a.id,a.url].filter(Boolean)));
 const editsDelivered=incoming.some(d=>d.action==='modify'&&d.references?.some(r=>delivered.has(r)));
 const stable=ds=>ds.map(d=>({description:d.description,kind:d.kind,count:d.count,action:d.action,spec:d.spec||{},constraints:d.constraints||[],references:d.references||[]}));
 const changed=previous.length&&incoming.length&&!isDeepStrictEqual(stable(previous),stable(incoming));
 if(editsDelivered){c.mode='revise';return s;}
 // Do not silently discard changed constraints or spawn a new paid task from an
 // ambiguous continuation. Require the model to resolve its contradictory draft.
 if(changed&&c.mode==='continue')throw new Error('续跑草稿改变了动作、数量、规格、约束或引用；不能直接复用旧任务。新修改使用revise；仅恢复执行时保留原目标。');
 if(changed&&c.mode==='approve'){
  // Approval often contains only the remaining media rather than completed text.
  const pending=(snapshot.items||[]).filter(i=>i.status!=='COMPLETED');
  const compatible=incoming.every(d=>pending.some(i=>i.description===d.description&&isDeepStrictEqual(i.references||[],d.references||[])&&previous[i.index]?.action===d.action&&i.output===d.kind&&i.count===d.count&&Object.entries(d.spec||{}).every(([k,v])=>isDeepStrictEqual(i.spec?.[k],v))&&(d.constraints||[]).every(c=>(i.constraints||[]).includes(c))));
  if(!compatible)throw new Error('批准内容与待确认任务不一致；纯确认请用approve和deliverables=[]，由持久状态恢复原方案；如有新修改须revise，不能批准旧参数');
 }
 return s;
}
