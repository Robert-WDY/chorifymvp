import {debugLabels,eventNames,toolNames} from './debug-labels.mjs';
import {resultSummary} from './public-events.mjs';

const parse=value=>{try{return JSON.parse(value);}catch{return value;}};
const compact=r=>({id:r.id,seq:r.seq,turnId:r.turnId,at:r.at,kind:r.kind,event:r.event,name:r.name,role:r.role,traceId:r.traceId,callId:r.callId,phase:r.phase});

// Index only: full model inputs and tool bodies are fetched by record ID on demand.
export function debugSnapshot(state,{running=false}={}) {
  const turns=new Map(), calls=new Map(), models=new Map();
  const turn=id=>{if(!turns.has(id))turns.set(id,{id,query:'',status:'historical',models:[],tools:[],events:[]});return turns.get(id);};
  for(const [seq,original] of state.records.entries()){
    const r={...original,seq};
    const t=turn(r.turnId||'historical');
    if(r.kind==='message'&&r.role==='user')t.query=r.content;
    if(r.event==='start')t.status='unfinished';
    if(r.event==='end'){t.status=r.result?.status;t.accounting=r.result?.modelAccounting;}
    if(r.event==='model_request'){
      const m={...compact(r),status:'unanswered'};t.models.push(m);models.set(r.traceId,m);
    }
    if(['model_response','model_error'].includes(r.event)){
      const m=models.get(r.traceId);if(m){m.status=r.event==='model_error'?'failed':'returned';m.responseId=r.id;}
    }
    if(r.event==='public_event'&&r.public?.category==='model'){
      const m=models.get(r.public.activityId);if(m&&r.public.durationMs!==undefined)m.durationMs=r.public.durationMs;
    }
    if(r.kind==='tool_call'){
      const c={...compact(r),agentTraceId:t.models.findLast(m=>m.phase==='agent')?.traceId,status:'unanswered'};t.tools.push(c);calls.set(r.callId,c);
    }
    if(r.kind==='tool_result'){
      const c=calls.get(r.callId);if(c){c.resultId=r.id;const raw=parse(r.output);Object.assign(c,resultSummary(typeof raw==='object'&&raw?raw:{message:String(raw)}));}
    }
    if(r.kind==='system_observation'||(r.kind==='run_event'&&!['public_event','model_request','model_response'].includes(r.event)))t.events.push(compact(r));
  }
  const phaseCounts={};for(const m of models.values())phaseCounts[m.phase||'unknown']=(phaseCounts[m.phase||'unknown']||0)+1;
  return {sessionId:state.id,running,recordCount:state.records.length,counts:{models:models.size,phases:phaseCounts,tools:calls.size,failedTools:[...calls.values()].filter(c=>c.status==='failed').length,deferredTools:[...calls.values()].filter(c=>c.status==='not_executed').length},turns:[...turns.values()].filter(t=>t.query||t.models.length||t.tools.length||t.events.length),legacy:state.records.some(r=>r.event==='legacy_import')};
}

export function inputBlocks(input=[]) {
  return input.flatMap((message,index)=>{
    const base={index,role:message.role||message.type,callId:message.call_id};
    const content=message.content??message.output??message;
    if(typeof content==='string'){
      const boundary=content.indexOf('\n');
      if(content.startsWith('Context reference data supplied by the server.')&&boundary>=0){
        const data=parse(content.slice(boundary+1));
        if(data&&typeof data==='object'&&!Array.isArray(data))return [{...base,name:'服务端数据来源说明',format:'text',data:content.slice(0,boundary)},...Object.entries(data).map(([name,data])=>({...base,name,format:'json',data}))];
      }
      const value=parse(content);
      if(value&&typeof value==='object'&&!Array.isArray(value))return Object.entries(value).map(([name,data])=>({...base,name,format:'json',data}));
      if(message.role==='system')return content.split(/\n\s*\n/).map((data,i)=>({...base,name:'系统段落 '+(i+1),format:'text',data}));
      return [{...base,name:message.type==='function_call_output'?'工具反馈':'消息原文',format:'text',data:content}];
    }
    if(Array.isArray(content))return content.map((data,i)=>({...base,name:(data.type||'内容')+' '+(i+1),format:'json',data}));
    return [{...base,name:'原始消息',format:'json',data:content}];
  });
}

export async function debugDetail(state,id,readTrace) {
  const found=state.records.find(r=>r.id===id);if(!found)throw new Error('Debug record not found');
  const resolve=async r=>r?.traceRef?await readTrace(r.id):r;
  const record=await resolve(found),labels=debugLabels(state);
  const presentation={labels,title:toolNames[record.name]||eventNames[record.event||record.name]||labels[record.id]||'原始记录'};
  if(record.event==='model_request'){
    const response=await resolve(state.records.find(r=>r.traceId===record.traceId&&['model_response','model_error'].includes(r.event)));
    const blocks=inputBlocks(record.input),values=new Set();
    const visit=value=>{if(typeof value==='string'){values.add(value);const decoded=parse(value);if(decoded!==value)visit(decoded);}else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){values.add(key);visit(item);}};
    for(const block of blocks)visit(block.data);
    const references=Object.values(state.assets||{}).filter(a=>values.has(a.id)).map(a=>({id:a.id,type:a.type,name:a.name||a.title,version:a.version,parentId:a.parentId,sourceIds:a.sourceIds}));
    return {...presentation,record,sources:(record.metrics?.retainedRecordIds||[]).map(id=>({id,label:labels[id]||'来源原文'})),response:response||null,references,blocks,tools:record.tools||[],note:'记录的是应用传入适配器的完整输入；供应商HTTP序列化与隐藏推理不在此记录中。分块仅供阅读，原始记录保留。'};
  }
  if(record.kind==='tool_call')return {...presentation,record,arguments:parse(record.arguments),result:state.records.find(r=>r.kind==='tool_result'&&r.callId===record.callId)||null};
  return {...presentation,record,...(record.output!==undefined?{output:parse(record.output)}:{})};
}
