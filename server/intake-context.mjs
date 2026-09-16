// Deterministic identities/anchors, not keyword-based intent routing.
export function selectedContextIds(payload){
 const query=payload.query||'',entries=payload.referenceCatalog?.entries||[],selected=new Set();
 for(const entry of entries){
  const uniqueName=entry.filename&&entries.filter(e=>e.filename===entry.filename).length===1;
  if([entry.id,entry.handle,...(uniqueName?[entry.filename]:[])].some(id=>id&&query.includes(id))||payload.replyTo&&entry.sourceMessageId===payload.replyTo){selected.add(entry.id);selected.add(entry.handle);}
 }
 return selected;
}
export function selectIntakeDocuments(payload){
 const docs=payload.sourceDocuments||[],selected=selectedContextIds(payload);
 const pinned=docs.filter(d=>selected.has(d.id)||selected.has(d.artifactId));
 // Keep explicitly selected content regardless of age. The recent fallback is
 // only for unresolved conversational references and never evicts pinned docs.
 const recent=docs.filter(d=>!pinned.includes(d)).slice(-8);
 return [...pinned,...recent];
}
export function assertIntakePointers(payload){
 const evidence=payload.relevantEvidence||payload,docs=evidence.sourceDocuments||payload.sourceDocuments||[];
 const messages=(evidence.conversation||payload.conversation)?.recentMessages||[];
 const entries=evidence.references||payload.referenceCatalog?.entries||[];
 for(const doc of docs)if(doc.contentMessageId&&!messages.some(m=>m.messageId===doc.contentMessageId&&typeof m.content==='string'))throw new Error('模型资料指针没有正文：'+doc.id);
 for(const m of messages)if(m.contentMessageId&&!messages.some(t=>t.messageId===m.contentMessageId&&typeof t.content==='string'))throw new Error('模型消息指针没有正文：'+m.messageId);
 for(const entry of entries){
  const ref=entry.contentSource;
  if(ref&&!docs.some(d=>d.id===ref.sourceDocumentId&&d.version===ref.version))throw new Error('模型引用指针没有源文档：'+entry.id);
  for(const unit of entry.units||[])if(unit.valueSource){
   const ref=unit.valueSource,doc=docs.find(d=>d.id===ref.sourceDocumentId&&d.version===ref.version);
   if(doc?.structure?.[unit.type]?.[unit.index-1]===undefined)throw new Error('模型单元指针没有正文：'+unit.id);
  }
 }
 return payload;
}
