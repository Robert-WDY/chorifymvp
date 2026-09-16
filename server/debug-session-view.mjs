const arr=x=>Array.isArray(x)?x:[];
const runOf=x=>x.runId||x.requestId;
const content=m=>typeof m?.content==='string'?m.content:arr(m?.content).map(p=>p.text||'').join('\n');
export function requestAssembly(call){
 const actual=call.normalizedRequest??call.actualRequest;
 const input=actual?.input??actual?.messages??call.input??call.preTransportInput;
 const messages=typeof input==='string'?[{role:'user',content:input}]:arr(input);
 const components=[];
 for(const [index,m] of messages.entries()){
  let payload;try{payload=JSON.parse(content(m));}catch{}
  if(payload?.original?.conversation)payload=payload.original;
  if(payload&&typeof payload==='object'&&!Array.isArray(payload))components.push({messageIndex:index,...payload});
 }
 const conversation=components.find(p=>p.conversation)?.conversation??components.find(p=>p.relevantEvidence?.conversation)?.relevantEvidence.conversation??null;
 const directHistory=conversation?[]:messages.filter(m=>m.role==='assistant'||m.role==='tool'||m.type==='function_call_output');
 return {source:actual?.input!=null||actual?.messages!=null?'actual_request':'pre_transport',conversation,components,directHistory,
  sequence:messages.map((m,i)=>({index:i,role:m.role||m.type,content:content(m),keys:components.find(p=>p.messageIndex===i)?Object.keys(components.find(p=>p.messageIndex===i)).filter(k=>k!=='messageIndex'):[]}))};
}
export function sessionEvidence(state,turnIndex,calls,diff){
 const turns=arr(state.turns),events=arr(state.events),current=turns[turnIndex];
 const rounds=turns.map((t,index)=>{const final=events.findLast(e=>runOf(e)===runOf(t)&&e.type==='final');return {number:index+1,runId:runOf(t),query:t.rawInput||'',status:t.status,answer:final?.text??null};});
 const history=rounds.slice(0,turnIndex).flatMap(t=>[{role:'user',content:t.query,round:t.number,source:'turn.rawInput'},...(t.answer===null?[]:[{role:'assistant',content:t.answer,round:t.number,source:'recorded_final_event'}])]);
 const globalRounds=turns.slice(0,turnIndex+1).map((t,index)=>{
  const taskSnapshots=events.filter(e=>runOf(e)===runOf(t)&&e.type==='task_state'&&e.task).map(e=>({at:e.occurredAt,task:e.task}));
  return {...rounds[index],before:t.stateBefore??null,after:t.stateAfter??null,changes:t.stateBefore&&t.stateAfter?diff(t.stateBefore.data,t.stateAfter.data):null,taskSnapshots};
 });
 return {roundNumber:turnIndex+1,rounds,history,assembly:calls.map(c=>({callId:c.id,...requestAssembly(c)})),globalRounds,
  currentState:{before:current.stateBefore??null,after:current.stateAfter??null},
  historySource:'Only earlier turns and their recorded final replies; no later messages or latest task ledger.'};
}
