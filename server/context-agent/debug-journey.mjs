import {inputBlocks} from './debug-view.mjs';
import {debugLabels,toolNames,eventNames,plain,excerpt,readable} from './debug-labels.mjs';
import {resultSummary} from './public-events.mjs';

const parse=s=>{try{return JSON.parse(s);}catch{return {message:String(s||'')};}};
const gateFailures={invalid_arguments:'工具参数不符合要求',unknown_tool:'工具未接通',asset_not_found:'素材引用不可用',asset_type_mismatch:'素材类型不符',asset_version_mismatch:'素材版本不符',real_image_required:'缺少真实图片',approval_required:'没有可执行批准方案',approval_not_found:'批准对象不匹配',approval_parameters_changed:'批准后的参数发生变化',proposal_withdrawn:'方案已经撤回',revision_source_required:'修改缺少原方案',source_content_missing:'来源没有正文',invalid_edits:'局部修改参数冲突',invalid_replacement:'修改目标不匹配'};
const bad=new Set(['failed','not_executed','unknown','cancelled']);

// Read-only, deterministic evidence projection. Never decides if the user's task was understood.
export async function debugJourney(state,turnId,readTrace,{running=false}={}){
 const rows=state.records.map((r,seq)=>({...r,seq})).filter(r=>(r.turnId||'historical')===turnId);
 if(!rows.length)throw new Error('未找到这一轮记录');
 const labels=debugLabels(state),nodes=[],issues=[],requests=[],tools=new Map(),results=new Map(),models=new Map(),executions=new Map();
 const full=async r=>r.traceRef?{...await readTrace(r.id),seq:r.seq}:r;
 const push=(r,module,title,status,summary,extra={})=>{const node={id:r.id,seq:r.seq,at:r.at,module,title,status,summary:readable(summary,labels),...extra};nodes.push(node);return node;};
 const issue=(node,title,description,severity='error',extra={})=>issues.push({nodeId:node.id,title,description:readable(description,labels),severity,...extra});
 let decisions=0;
 for(const short of rows){
  if(short.event==='model_request'){
   const r=await full(short),input=r.input||[],blocks=inputBlocks(input),phase=r.phase||'agent';
   const feedback=input.filter(m=>m.type==='function_call_output').map(m=>m.call_id);
   const observationIds=blocks.filter(b=>b.name==='rawResultRef').map(b=>b.data?.id).filter(Boolean);
   const context={recordCount:r.metrics?.retainedRecords??null,omitted:r.metrics?.omittedRecords??null,inputEstimate:r.metrics?.estimatedInputTokens??null,toolEstimate:r.metrics?.estimatedToolDefinitionTokens??null,budget:r.metrics?.tokenBudget??null,feedbackCount:feedback.length,systemParagraphs:blocks.filter(b=>b.role==='system').length};
   if(phase==='agent')push({...r,id:'context-'+r.id,seq:r.seq-0.1},'context','组装本次决策输入','ready',`保留 ${context.recordCount??'未记录数量的'} 条会话记录，包含 ${feedback.length} 条工具反馈。${context.omitted>0?'另有 '+context.omitted+' 条历史未进入本次输入。':''}`,{recordId:r.id});
   const node=push(r,phase==='agent'?'agent':'context',phase==='agent'?'Agent 第'+(++decisions)+'次决策':phase==='summary'?'记忆模块请求整理摘要':'视觉模块请求观察','unanswered',phase==='agent'?'根据当前输入选择下一步；等待模型返回。':'等待模型返回。',{phase,context,choices:[],feedback,observationIds});
   requests.push(node);models.set(r.traceId,node);
   if(phase==='agent'&&context.omitted>0)issue(node,'部分历史未进入本次输入','本次保留 '+context.recordCount+' 条记录，省略 '+context.omitted+' 条。裁剪本身不等于出错，需核查必要来源是否仍在。','signal');
   const latestUser=rows.filter(x=>x.seq<=r.seq&&x.kind==='message'&&x.role==='user').at(-1);
   if(phase==='agent'&&latestUser&&Array.isArray(r.metrics?.retainedRecordIds)&&!r.metrics.retainedRecordIds.includes(latestUser.id))issue(node,'最新用户原话不在保留记录列表','需检查本次输入是否仍承载完整最新要求。','warning');
  }else if(['model_response','model_error'].includes(short.event)){
   const r=await full(short),node=models.get(r.traceId);if(!node)continue;
   node.responseId=r.id;node.usage=r.usage;node.status=r.event==='model_error'?'failed':'returned';
   const output=Array.isArray(r.output)?r.output:[],choices=output.filter(p=>p.type==='function_call').map(p=>({name:p.name,label:toolNames[p.name]||p.name,arguments:parse(p.arguments)}));node.choices=choices;
   node.publicText=output.filter(p=>p.type==='message').map(p=>plain(p.content)).join('\n');
   if(r.event==='model_error'){node.summary=readable(r.message||'模型调用失败',labels);issue(node,'模型调用或响应校验失败',node.summary);}
   else node.summary=choices.length?'选择 '+choices.length+' 个工具：'+choices.map(c=>c.label).join('、'):node.publicText?'返回公开文字，未选择工具。':'模型返回，具体内容见证据。';
  }else if(short.kind==='tool_call'){
   const args=parse(short.arguments),name=toolNames[short.name]||short.name;
   const node=push(short,'system','Agent 申请'+name,'requested','系统收到工具参数，随后检查并处理。',{tool:short.name,arguments:args,callId:short.callId});tools.set(short.callId,node);
   const previous=[...tools.values()].filter(n=>n.id!==node.id&&n.tool===node.tool&&JSON.stringify(n.arguments)===JSON.stringify(args));
   if(previous.length)issue(node,'相同工具参数再次出现','这是本轮第 '+(previous.length+1)+' 次相同调用；可能是必要回读，也可能是无效重试，需要结合前次结果检查。','signal');
  }else if(short.kind==='tool_result'){
   const raw=parse(short.output),view=resultSummary(raw),call=tools.get(short.callId),name=toolNames[call?.tool]||'工具';
   const status=view.status,gate=gateFailures[raw.error?.code||raw.code],reason=raw.error?.message||raw.message||raw.note;
   const text=status==='not_executed'?'系统没有执行这项调用。':status==='prepared'?'具体方案已保存，实际媒体尚未生成。':status==='succeeded'?'调用返回成功；这不等于最终交付已经合格。':status==='failed'?'调用返回错误。':status==='unknown'?'提交或结果状态不确定。':'调用状态：'+status;
   const node=push(short,status==='not_executed'||gate?'system':'feedback',(gate?'系统拒绝：':status==='not_executed'?'系统未执行：':status==='failed'?'调用失败：':'工具反馈：')+name,status,text+(reason?' '+reason:''),{systemRejected:!!gate,callId:short.callId,requestId:call?.id,tool:call?.tool,output:raw,simulated:raw.simulated===true});
   const execution=executions.get(short.callId);if(execution){execution.status=status;execution.summary='本次工具处理已返回，具体状态和结果见下一条反馈。';}
   results.set(short.callId,node);if(call){call.resultId=short.id;call.status=status;}
   if(bad.has(status))issue(node,gate?'系统拒绝：'+gate:status==='not_executed'?'系统未执行工具':status==='unknown'?'执行结果未知':status==='cancelled'?'工具调用取消':'工具调用失败',node.summary,status==='not_executed'?'warning':'error',{callId:short.callId});
  }else if(short.kind==='system_observation'){
   const raw=parse(short.output),view=resultSummary(raw),node=push(short,'system',eventNames[short.name]||'系统反馈',view.status,raw.error?.message||raw.message||raw.note||'系统记录了一条反馈。',{output:raw});
   if(bad.has(view.status)||short.name==='delivery_check')issue(node,short.name==='delivery_check'?'交付检查没有通过':'系统反馈异常',node.summary,'warning',{observationId:short.id});
  }else if(short.kind==='message'){
   push(short,short.role==='user'?'request':'answer',short.role==='user'?'用户本轮要求':'Agent 公开回复','recorded',plain(short.content),{text:plain(short.content)});
  }else if(short.event==='summary_attempt'){
   const from=short.coveredFromSeq,to=short.coveredToSeq,range=state.records.slice(from,to+1),users=range.filter(r=>r.kind==='message'&&r.role==='user');
   const saved=Object.values(state.summaries||{}).find(s=>s.sourceHash===short.sourceHash&&s.coveredToSeq===to);
   const failed=rows.find(r=>r.event==='summary_failed'&&r.sourceHash===short.sourceHash);
   const node=push(short,'context','会话记忆整理',saved?'succeeded':failed?'failed':'unanswered',`整理较早的 ${range.length} 条记录，其中有 ${users.length} 条用户消息。`+(saved?'摘要已保存，原始记录保留。':failed?'整理失败，未推进本次覆盖范围。':'只有开始记录，尚不能确认摘要已保存。'),{coverage:users.map(r=>({id:r.id,label:labels[r.id]})),savedSummary:saved?.summaryText});
   if(failed&&!saved)issue(node,'摘要整理失败','此前记录未被这次整理覆盖；后续可能继续依赖原文或裁剪。');
  }else if(short.event==='summary_failed'){
   push(short,'context','摘要整理返回错误','failed',short.message||'摘要失败，原因未记录。');
  }else if(short.event==='tool_batch_policy'){
   push(short,'system','系统安排执行方式','recorded',short.rule||'没有记录具体规则。',{note:short.semanticIndependenceVerified===false?'程序只按工具副作用分类，未证明语义独立。':undefined});
  }else if(short.event==='end'){
   const status=short.result?.status,node=push(short,'answer',status==='completed'?'本轮运行结束':status==='waiting_user'?'流程等待用户回答':'本轮流程停止',status,short.result?.message||(status==='completed'?'Agent 已结束本轮运行；内容是否满足用户要求仍需核查。':'查看前面的反馈与停止原因。'));
   if(!['completed','waiting_user'].includes(status))issue(node,'本轮未正常结束',node.summary);
  }else if(short.event==='public_event'&&short.public?.category==='tool'&&short.public.status==='running'){
   executions.set(short.public.activityId,push(short,'execution','处理工具调用：'+(toolNames[short.public.name]||'工具调用'),'running','开始解析参数并处理调用；这一步不代表已经向供应商提交。'));
  }else if(short.event==='public_event'&&short.public?.category==='model'){
   const node=models.get(short.public.activityId);if(node&&short.public.durationMs!==undefined)node.durationMs=short.public.durationMs;
  }
 }
 for(const tool of tools.values())if(!tool.resultId)issue(tool,'工具请求没有返回记录','目前只有调用请求，不能推定已经执行成功。',running?'signal':'warning');
 for(const model of requests)if(model.status==='unanswered')issue(model,'模型请求没有返回记录','当前只能确认请求已记录，无法确认模型结果。',running?'signal':'warning');
 // Demonstrate delivery of feedback from the next actual input, never infer comprehension.
 for(const problem of issues){
  const origin=nodes.find(n=>n.id===problem.nodeId),next=requests.find(n=>n.phase==='agent'&&n.seq>origin.seq);
  if(problem.callId||problem.observationId){
   const delivered=next&&(problem.callId?next.feedback.includes(problem.callId):next.observationIds.includes(problem.observationId));
   problem.followUp=!next?'之后没有新的 Agent 决策记录。':delivered?'该反馈已进入下一次实际输入；是否理解并纠正仍需核对后续选择。':'下一次实际输入未找到这条反馈的直接记录；可能被摘要或裁剪，需要核查。';
   problem.nextId=next?.id;problem.feedbackDelivered=!!delivered;
   if(next){next.incomingProblems||=[];next.incomingProblems.push({title:problem.title,delivered:!!delivered,nodeId:origin.id});}
  }
 }
 const modules=['context','agent','system','execution','feedback','answer'].map(key=>{const last=nodes.filter(n=>n.module===key).at(-1);return {key,title:{context:'上下文与记忆',agent:'Agent 决策',system:'系统处理',execution:'工具处理',feedback:'结果反馈',answer:'回复与结束'}[key],status:last?.status||'absent',nodeId:last?.id,summary:last?.title||'本轮没有独立记录'};});
 return {turnId,query:rows.filter(r=>r.kind==='message'&&r.role==='user').map(r=>plain(r.content)).join('\n'),nodes,issues,modules,labels,decisions,running,recordCount:state.records.length,note:'问题卡来自实际错误与可核查信号，不自动判断创作语义是否正确；反馈进入输入不代表模型已经理解。'};
}
