import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {appendRecord} from './history.mjs';
import {buildContext} from './context.mjs';
import {publicMediaUrl} from '../media.mjs';
import {maintainMemory,memoryOptions} from './memory.mjs';
import {interactions,validateAnswer,selectedAssets} from './interactions.mjs';
import {appendPublicEvent,resultSummary,safeText} from './public-events.mjs';
import {finalDeliveryCheck} from './delivery-check.mjs';

const prompt = await readFile(new URL('./prompt.md', import.meta.url), 'utf8');
const errorResult = (error, code = 'tool_error') => ({isError:true, code:error.code || code, message:error.message || String(error), submitted:false});
const contentText = content => typeof content === 'string' ? content : (content || []).map(p => p.text || '').join('\n');

function protocolOutput(output) {
  if (!Array.isArray(output) || !output.length) throw Object.assign(new Error('模型未返回消息或工具调用'), {code:'model_protocol'});
  const ids = new Set();
  for (const part of output) {
    if (!part || (part.status !== undefined && part.status !== 'completed')) throw Object.assign(new Error('模型输出不完整，不能作为完成'), {code:'model_incomplete'});
    if (part.type === 'function_call') {
      if (typeof part.call_id !== 'string' || !part.call_id || ids.has(part.call_id) || typeof part.name !== 'string' || typeof part.arguments !== 'string') throw Object.assign(new Error('工具调用协议无效或调用 ID 重复'), {code:'model_protocol'});
      ids.add(part.call_id);
    } else if (part.type !== 'message' || part.role !== 'assistant' || !contentText(part.content).trim() || (Array.isArray(part.content) && part.content.some(p => !['output_text','text'].includes(p.type)))) {
      throw Object.assign(new Error('模型返回了不支持的消息协议'), {code:'model_protocol'});
    }
  }
  return output;
}

function stageInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length > 12) throw new Error('每次最多添加 12 份素材');
  if (Buffer.byteLength(JSON.stringify(inputs)) > 128 * 1024) throw new Error('附件内容超过 128 KiB');
  return inputs.map(a => {
    if (!a || !['text','image','video'].includes(a.type) || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 240) throw new Error('附件需要 type 与有效 name');
    if (a.type === 'text' && (typeof a.content !== 'string' || !a.content.trim())) throw new Error('文字附件需要真实正文');
    if (a.type !== 'text') publicMediaUrl(a.url);
    return {id:randomUUID(),type:a.type,name:a.name,...(a.type==='text'?{content:a.content}:{url:a.url}),version:1,createdAt:new Date().toISOString(),origin:'user_input'};
  });
}

/** Native tool loop only. Runtime outcomes below describe this HTTP/model run, never business progress. */
export class ContextAgent {
  constructor({brain,tools,save=async()=>{},catalog={skills:[]},maxSteps=16,maxModelCalls=maxSteps,maxToolCalls=48,contextTokenBudget=24000,maxMediaCalls=0,systemPrompt=prompt,memory={}}={}) {
    if (!brain?.respond || !tools?.execute || !Array.isArray(tools.definitions)) throw new Error('需要模型接入与真实工具注册表');
    for (const [name,value] of Object.entries({maxSteps,maxModelCalls,maxToolCalls,contextTokenBudget,maxMediaCalls})) if (!Number.isInteger(value) || value < (name==='maxMediaCalls'?0:1)) throw new Error('运行预算无效：'+name);
    Object.assign(this,{brain,tools,save,catalog,maxSteps,maxModelCalls,maxToolCalls,contextTokenBudget,maxMediaCalls,systemPrompt});
    this.memory=memoryOptions(memory);
    this.active = new Set();
  }

  async run(state,message,emit=()=>{},signal=new AbortController().signal,{inputs=[],requestId=randomUUID(),confirmation,selectedAssetIds=[],interactionResponse}={}) {
    if (state?.engine !== 'context-agent' || !Array.isArray(state.records)) throw new Error('新入口只接受独立 context-agent 会话');
    if (typeof message !== 'string' || !message.trim() || message.length > 30000 || typeof requestId !== 'string' || !requestId || requestId.length>128) throw new Error('请求正文或请求标识无效');
    if (this.active.has(state.id)) throw Object.assign(new Error('会话正在运行'), {code:'session_busy'});
    const previous = state.records.find(r=>r.kind==='run_event' && r.event==='start' && r.requestId===requestId);
    if (previous) {
      if (previous.message !== message || JSON.stringify(previous.inputs||[]) !== JSON.stringify(inputs)||JSON.stringify(previous.confirmation)!==JSON.stringify(confirmation)||JSON.stringify(previous.selectedAssetIds||[])!==JSON.stringify(selectedAssetIds)||JSON.stringify(previous.interactionResponse)!==JSON.stringify(interactionResponse)) throw Object.assign(new Error('相同请求标识不能更改正文、附件、选择、回答或批准对象'), {code:'request_identity_conflict'});
      const end=state.records.find(r=>r.kind==='run_event' && r.event==='end' && r.turnId===previous.turnId);
      const result=end ? {...end.result,replayed:true} : {status:'interrupted',turnId:previous.turnId,replayed:true,message:'先前运行没有结束回执；不会自动重放可能已提交的调用。可在新请求中读取原调用回执。'};
      emit({type:'end',...result});return result;
    }
    const assets=stageInputs(inputs),turnId=randomUUID();
    const selected=selectedAssets(state,selectedAssetIds);
    const answer=interactionResponse?validateAnswer(state,interactionResponse):undefined;
    let steps=0,callsUsed=0,modelCalls=0;
    const accounting=Object.fromEntries(['agent','image_observation','summary'].map(p=>[p,{calls:0,durationMs:0,usage:[],cost:null}]));
    const persist = () => this.save(state);
    const record = value => appendRecord(state,{turnId,...value});
    const publish=async event=>{const value=appendPublicEvent(state,turnId,event);await persist();emit(value);return value;};
    let lastAgentTraceId;
    const modelRespond=async(brain,input,definitions,metadata={})=>{
      signal.throwIfAborted();
      if(modelCalls>=this.maxModelCalls)throw Object.assign(new Error('达到本轮模型总调用上限（含视觉观察）'),{code:'budget_exceeded'});
      const traceId=randomUUID(),phase=metadata.phase||'agent',startedAt=Date.now();
      if(phase==='agent')lastAgentTraceId=traceId;
      let deltaBuffer='',streamStarted=false;const flushDelta=async()=>{if(deltaBuffer){const delta=deltaBuffer;deltaBuffer='';streamStarted=true;await publish({kind:'text_delta',streamId:traceId,delta,status:'partial'});}};
      record({kind:'run_event',event:'model_request',traceId,step:steps,phase:metadata.phase||'agent',input,tools:definitions,metrics:metadata.metrics,startedAt:new Date().toISOString()});
      await persist();signal.throwIfAborted();modelCalls++;
      accounting[phase].calls++;
      await publish({kind:'activity',activityId:traceId,category:'model',name:phase,status:'running'});
      try{
        const requestSignal=phase==='summary'?AbortSignal.any([signal,AbortSignal.timeout(30000)]):signal;
        const raw=await brain.respond(input,definitions,requestSignal,{singleToolCall:phase==='agent',json:phase==='summary',...(phase==='agent'?{onTextDelta:async delta=>{deltaBuffer+=delta;if(!streamStarted||deltaBuffer.length>=80)await flushDelta();}}:{}),...(phase==='summary'?{maxOutputTokens:Math.min(6000,this.memory.summaryMaxTokens)}:{})});
        await flushDelta();
        if(phase==='agent'){
          protocolOutput(raw);
          if(streamStarted&&!raw.some(p=>p.type==='message'))await publish({kind:'text_incomplete',streamId:traceId,note:'本次响应未返回完整公开文字'});
        }
        const usage=brain.lastCall?.usage||null;
        if(usage)accounting[phase].usage.push(structuredClone(usage));
        if(brain.lastCall?.cost!==undefined){accounting[phase].cost||=[];accounting[phase].cost.push(structuredClone(brain.lastCall.cost));}
        record({kind:'run_event',event:'model_response',traceId,phase,output:structuredClone(raw),usage});await persist();await publish({kind:'activity',activityId:traceId,category:'model',name:phase,status:'succeeded',durationMs:Date.now()-startedAt});return raw;
      }catch(error){await flushDelta();await publish({kind:'text_incomplete',streamId:traceId});record({kind:'run_event',event:'model_error',traceId,code:error.code||'model_error',message:error.message});await persist();await publish({kind:'activity',activityId:traceId,category:'model',name:phase,status:signal.aborted?'cancelled':'failed',error:safeText(error.message),durationMs:Date.now()-startedAt});throw error;}
      finally{accounting[phase].durationMs+=Date.now()-startedAt;}
    };
    this.active.add(state.id);
    try {
      // Complete interrupted protocol groups without retrying their side effects.
      for (const call of state.records.filter(r=>r.kind==='tool_call'&&!state.records.some(x=>x.kind==='tool_result'&&x.callId===r.callId))) {
        const invocation=Object.values(state.invocations).find(r=>r.callId===call.callId&&r.turnId===call.turnId);
        const proposal=Object.values(state.approvals).find(r=>r.kind==='proposal'&&r.callId===call.callId&&r.turnId===call.turnId);
        const recovered=invocation?.result?{...structuredClone(invocation.result),receiptId:invocation.receiptId,recoveredFromReceipt:true}
          :invocation?.kind==='document'&&state.assets[invocation.assetId]?{ok:true,asset:state.assets[invocation.assetId],recoveredFromReceipt:true}
          :proposal&&!invocation?{ok:true,status:'approval_required',submitted:false,proposalId:proposal.proposalId,name:proposal.name,args:proposal.args,recoveredFromReceipt:true}
          :{isError:true,code:'interrupted_call',submitted:invocation?.attempted?'unknown':false,receiptId:invocation?.receiptId,providerReceiptId:invocation?.providerReceiptId,message:invocation?'此前调用结果未进入历史；先查询此回执，不自动重新提交。':'没有持久提交记录，此调用未自动重试。',callId:call.callId};
        appendRecord(state,{kind:'tool_result',turnId:call.turnId,groupId:call.groupId,callId:call.callId,output:JSON.stringify(recovered)});
      }
      record({kind:'run_event',event:'start',requestId,message,inputs,selectedAssetIds,...(interactionResponse?{interactionResponse}:{}),...(confirmation?{confirmation}: {})});
      for(const a of assets) state.assets[a.id]=a;
      const pendingQuestion=!confirmation&&!answer?[...interactions(state)].reverse().find(i=>i.status==='pending'):undefined;
      const linkedAnswer=answer||(pendingQuestion?{interactionId:pendingQuestion.interactionId,action:'text',text:message}:undefined);
      const userRecord=record({kind:'message',role:'user',groupId:turnId,content:message,attachments:assets.map(a=>({id:a.id,type:a.type,name:a.name,version:a.version})),...(selected.length?{workspace:{selectedAssets:selected}}:{}),...(linkedAnswer?{interactionResponse:linkedAnswer}:{}),...(confirmation?{confirmation}: {})});
      await persist();
      await publish({kind:'message',messageId:userRecord.id,role:'user',text:message});
      if(linkedAnswer){
        const item=interactions(state).find(i=>i.interactionId===linkedAnswer.interactionId);
        await publish({kind:'interaction',interaction:item});
        if(item.status==='pending'||['cancel','decline'].includes(item.status)){
          const result={status:item.status==='pending'?'waiting_user':item.status==='cancel'?'cancelled':'declined',turnId,modelCalls,toolCalls:0,modelAccounting:accounting};
          record({kind:'run_event',event:'end',result});await publish({kind:'turn_end',status:result.status});emit({type:'end',...result});return result;
        }
      }
      emit({type:'user_recorded',turnId,assets});
      const confirmationSource={kind:confirmation?'button':linkedAnswer?'interaction':'text',messageId:userRecord.id,requestId};
      if(confirmation){
        const confirmationStart=Date.now();await publish({kind:'activity',activityId:turnId+':confirmation',category:'tool',name:'confirm_media',status:'running'});
        let result;
        try{
          if(typeof this.tools.approveAndExecute!=='function')throw new Error('确认执行服务未装配');
          result=await this.tools.approveAndExecute({proposalIds:confirmation.proposalIds},{state,signal,turnId,ownerId:state.ownerId,save:persist,maxMediaCalls:this.maxMediaCalls,requestId,confirmationSource});
        }catch(error){result=errorResult(error);}
        const observation=record({kind:'system_observation',name:'confirm_media',source:confirmationSource,output:JSON.stringify(result)});
        await persist();emit({type:'system_observation',name:'confirm_media',recordId:observation.id,result,turnId});
        await publish({kind:'activity',activityId:turnId+':confirmation',category:'tool',name:'confirm_media',...resultSummary(result),durationMs:Date.now()-confirmationStart});
      }
      for (;steps<this.maxSteps;steps++) {
        signal.throwIfAborted();
        const contextOptions={systemPrompt:this.systemPrompt,skillDirectory:(this.catalog.skills||[]).map(({slug,name,description})=>({slug,name,description})),toolDefinitions:this.tools.definitions,tokenBudget:this.contextTokenBudget,reservedTokens:6000,currentTurnId:turnId};
        if(accounting.summary.calls<this.memory.maxCallsPerTurn)await maintainMemory(state,{contextOptions,config:{...this.memory,maxCallsPerTurn:this.memory.maxCallsPerTurn-accounting.summary.calls},respond:input=>modelRespond(this.brain,input,[],{phase:'summary'}),save:persist,remainingCalls:()=>this.maxModelCalls-modelCalls,turnId,signal});
        const context=buildContext(state,{...contextOptions,reservedTokens:contextOptions.reservedTokens+this.memory.safetyTokens});
        // Persist the exact request, not a reconstructed approximation of its model view.
        const raw=await modelRespond(this.brain,context.input,this.tools.definitions,{metrics:context.metrics});
        signal.throwIfAborted();
        const output=raw,calls=output.filter(x=>x.type==='function_call'),groupId=randomUUID();
        if(calls.some(c=>state.records.some(r=>r.kind==='tool_call'&&r.callId===c.call_id))) throw Object.assign(new Error('模型重复使用已记录的调用 ID；不会再次提交'),{code:'duplicate_call_id'});
        if(calls.length<=1&&callsUsed+calls.length>this.maxToolCalls) throw Object.assign(new Error('达到本轮工具调用上限'),{code:'budget_exceeded'});
        const text=output.filter(x=>x.type==='message').map(x=>contentText(x.content)).join('\n');
        const deliveryFailure=!calls.length&&finalDeliveryCheck(state,turnId,text);
        if(deliveryFailure){
          record({kind:'system_observation',groupId,name:'delivery_check',source:{kind:'measurement',callId:deliveryFailure.measurementCallId},output:JSON.stringify(deliveryFailure)});
          await publish({kind:'text_incomplete',streamId:lastAgentTraceId,note:'草稿未通过已声明要求，正在修正'});
          await publish({kind:'activity',activityId:groupId,category:'check',name:'delivery_check',status:'failed',error:deliveryFailure.message});
          continue;
        }
        for(const part of output) {
          if(part.type==='message'){const m=record({kind:'message',role:'assistant',groupId,content:contentText(part.content)});await publish({kind:'message',messageId:m.id,streamId:lastAgentTraceId,role:'assistant',text:m.content});}
          else record({kind:'tool_call',groupId,callId:part.call_id,name:part.name,arguments:part.arguments});
        }
        await persist();
        if(text) emit({type:calls.length?'assistant_progress':'assistant',text,turnId});
        if(!calls.length) {
          const result={status:'completed',turnId,text,modelCalls,toolCalls:callsUsed,modelAccounting:accounting};
          record({kind:'run_event',event:'end',result});await publish({kind:'turn_end',status:result.status});emit({type:'end',...result});return result;
        }
        callsUsed+=calls.length;
        if(calls.length>1){
          for(const call of calls){
            const result={ok:false,status:'not_executed',submitted:false,error:{code:'single_tool_call_required',message:'每次只选择一个工具。整组均未执行；请根据本次反馈重新选择下一步。'}};
            record({kind:'tool_result',groupId,callId:call.call_id,output:JSON.stringify(result)});
            await publish({kind:'activity',activityId:call.call_id,category:'tool',name:call.name,...resultSummary(result),durationMs:0});
            emit({type:'tool_result',callId:call.call_id,name:call.name,result,turnId});
          }
          await persist();if(callsUsed>=this.maxToolCalls)throw Object.assign(new Error('达到工具协议调用预算'),{code:'budget_exceeded'});continue;
        }
        // Exactly one call remains. Its real result precedes the next Agent decision.
        for(const call of calls) {
          const toolStartedAt=Date.now();await publish({kind:'activity',activityId:call.call_id,category:'tool',name:call.name,status:'running'});
          let result,started=false;
          try {
            signal.throwIfAborted();
            let args;try{args=JSON.parse(call.arguments);}catch{throw Object.assign(new Error('工具参数不是合法 JSON；此调用未执行，请修正参数'),{code:'invalid_arguments'});}
            if(!args||typeof args!=='object'||Array.isArray(args)) throw Object.assign(new Error('工具参数必须是 JSON 对象'),{code:'invalid_arguments'});
            started=true;
            result=await this.tools.execute(call.name,args,{state,signal,callId:call.call_id,turnId,ownerId:state.ownerId,save:persist,maxMediaCalls:this.maxMediaCalls,modelRespond,fromModel:true,requestId,confirmationSource});
            if(result===undefined) throw new Error('工具未提供结果');
          } catch(error) {
            result=signal.aborted?{isError:true,code:'cancelled',submitted:started?'unknown':false,message:started?'运行已取消；已经开始的调用可能已提交，请查调用回执。':'运行已取消；此调用尚未开始。'}:errorResult(error);
          }
          record({kind:'tool_result',groupId,callId:call.call_id,output:JSON.stringify(result)});
          await persist();emit({type:'tool_result',callId:call.call_id,name:call.name,result,turnId});
          await publish({kind:'activity',activityId:call.call_id,category:'tool',name:call.name,...resultSummary(result),durationMs:Date.now()-toolStartedAt});
          if(result.status==='approval_required'&&result.proposalId){record({kind:'run_event',event:'proposal_published',proposalIds:[result.proposalId]});await publish({kind:'proposal',proposal:{proposalId:result.proposalId,turnId,name:result.name,args:result.args,status:'prepared'}});}
          if(call.name==='request_user_input'&&result.ok&&result.interaction){
            await publish({kind:'interaction',interaction:{...result.interaction,answers:{},status:'pending'}});
            const waiting={status:'waiting_user',turnId,modelCalls,toolCalls:callsUsed,modelAccounting:accounting};
            record({kind:'run_event',event:'end',result:waiting});await publish({kind:'turn_end',status:'waiting_user'});emit({type:'end',...waiting});return waiting;
          }
        }
      }
      throw Object.assign(new Error('达到本轮模型调用上限，未收到正常结束回答'),{code:'budget_exceeded'});
    } catch(error) {
      const result={status:signal.aborted?'cancelled':error.code==='budget_exceeded'||error.code==='CONTEXT_BUDGET_EXCEEDED'?'budget_exceeded':'error',turnId,code:error.code||'run_error',message:error.message,modelCalls,toolCalls:callsUsed,modelAccounting:accounting};
      record({kind:'run_event',event:'end',result});await publish({kind:'turn_end',status:result.status,message:safeText(result.message)});emit({type:'end',...result});return result;
    } finally {this.active.delete(state.id);}
  }
}
