const operationNames={generate_image:'生成图片',edit_image:'修改图片',generate_video:'生成视频',edit_video:'编辑视频'};
const statuses={PLANNING:'正在规划',EXECUTING:'正在执行',VERIFYING:'正在验收',COMPLETED:'已完成',SIMULATED:'模拟完成',BLOCKED:'暂时无法继续',WAIT_CONFIRM:'等待确认',NEEDS_INPUT:'需要补充信息',PARTIAL:'部分完成',WAITING:'等待结果',FAILED:'执行失败',CANCELLED:'已取消',REFUSED:'无法执行',pending:'待处理',submitted:'已提交',succeeded:'执行成功',failed:'执行失败',unknown:'状态待核实'};
const typeNames={string:'文字',number:'数字',integer:'整数',boolean:'是/否',array:'列表',object:'对象'};
function parameterDescription(schema={}){
 const parts=[typeNames[schema.type]||'按参数定义填写'];
 if(schema.items)parts[0]=(typeNames[schema.items.type]||'内容')+'列表';
 if(schema.enum)parts.push('可选：'+schema.enum.join('、'));
 if(schema.const!==undefined)parts.push('固定值：'+String(schema.const));
 if(schema.minimum!==undefined)parts.push('至少 '+schema.minimum);
 if(schema.maximum!==undefined)parts.push('最多 '+schema.maximum);
 if(schema.minLength)parts.push('至少 '+schema.minLength+' 字符');
 if(schema.maxLength)parts.push('最多 '+schema.maxLength+' 字符');
 return parts.join('；');
}
export function formatRuntimeFacts(facts){
 const sections=[];
 if(facts.query?.type==='history')return facts.message?facts.message.content:'未找到对应的历史消息，请指定要查询的那一轮。';
 if(facts.query?.type==='model_identity')return facts.modelIdentity?.configuredModel?'当前配置的模型标识为 '+facts.modelIdentity.configuredModel+'；没有可验证的底层版本信息。':'当前没有可核验的模型配置信息。';
 if(facts.query?.type==='skill_detail')return facts.skills?.length===1?facts.skills.map(s=>s.name+'（'+s.slug+'）\n'+(s.description||'')+'\n方法步骤：\n'+s.workflow.map((step,i)=>(i+1)+'. '+step).join('\n')).join('\n'):'该名称对应多个 Skill，请指定：'+(facts.skills||[]).map(s=>s.name+'（'+s.slug+'）').join('、');
 if(facts.entries){
  const lines=['当前工具与能力'];
  for(const entry of facts.entries){
   const state=!entry.compilable||!entry.adapterImplemented?'尚未开放':entry.configured===false?'已实现，尚未配置':entry.configured===true?'已实现、已配置':'已实现，配置状态待核实';
   lines.push('• '+(operationNames[entry.operation]||entry.operation)+'：'+state+'。实际工具：'+entry.tool+(entry.operation==='edit_image'?'，使用参考图片进行修改':'')+'。');
   const support=entry.specSupport;
   if(support?.durationSeconds)lines.push('  视频时长：'+support.durationSeconds.min+'–'+support.durationSeconds.max+' 秒；默认 '+support.defaultDurationSeconds+' 秒。');
   if(support?.defaultSize)lines.push('  默认尺寸：'+support.defaultSize+'。');
  }
  for(const entry of facts.unsupported||[])lines.push('• '+(operationNames[entry.operation]||entry.operation)+'：'+entry.reason+'。');
  sections.push(lines.join('\n'));
  const parameters=[],seen=new Set();
  for(const entry of facts.entries){if(seen.has(entry.tool)||!entry.parameters)continue;seen.add(entry.tool);parameters.push(entry.tool+' 参数：');
   for(const [name,schema] of Object.entries(entry.parameters.properties||{}))parameters.push('• '+name+'（'+(entry.parameters.required?.includes(name)?'必填':'可选')+'）：'+parameterDescription(schema));
  }
  if(parameters.length&&!facts.query)sections.push(parameters.join('\n'));
 }
 if(facts.skills?.length)sections.push('本地 Skill（'+facts.skills.length+' 个）\n'+facts.skills.map(s=>'• '+s.name+'（'+s.slug+'）').join('\n'));
 if(facts.quote){const q=facts.quote;sections.push('实际报价\n'+(q.status==='available'&&q.total!==null&&q.total!==undefined?'总价：'+q.total+(q.currency?' '+q.currency:'')+'。':q.reason||'当前没有可核验的报价，无法提供实际金额。'));}
 // Broad capability inquiries do not need the unrelated task ledger. Explicit
 // task queries carry execution_ledger as their top-level source.
 if(facts.source==='execution_ledger'){
  sections.push('任务状态\n'+((facts.tasks||[]).map(t=>'• '+t.id+'：'+(statuses[t.status]||t.status)+(t.reason?'。'+t.reason:'')).join('\n')||'当前没有任务记录。'));
  if(facts.executions?.length)sections.push('工具执行记录\n'+facts.executions.map(e=>'• '+(e.providerTaskId||e.id)+'：'+(statuses[e.status]||e.status)).join('\n'));
 }
 return sections.join('\n\n');
}
// Upgrade only the known legacy runtime-facts envelope. User-requested JSON,
// model code samples, and the raw trace remain untouched.
export function displayReply(text){
 return String(text??'').replace(/以下信息来自当前运行时记录：\s*```json\s*([\s\S]*?)\s*```/g,(original,raw)=>{
  try{const value=JSON.parse(raw);if(!['runtime_registry','execution_ledger'].includes(value.source))return original;return formatRuntimeFacts(value)||original;}catch{return original;}
 });
}
