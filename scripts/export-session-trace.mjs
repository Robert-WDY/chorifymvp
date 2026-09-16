import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [source,destination]=process.argv.slice(2);
if(!source||!destination)throw new Error('Usage: node scripts/export-session-trace.mjs session.json destination');
const raw=await readFile(source),state=JSON.parse(raw),root=resolve(destination),manifest=[];
await mkdir(root,{recursive:true});await mkdir(join(root,'turns'),{recursive:true});
async function save(name,value){const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2));await writeFile(join(root,name),bytes);manifest.push({file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
await save('session-original.json',raw);
await save('messages.json',state.messages);await save('events.json',state.events);await save('task-store.json',state.taskStore);
const calls=state.messages.flatMap((m,index)=>m.type==='function_call'?[{messageIndex:index,...m,parsedArguments:(()=>{try{return JSON.parse(m.arguments);}catch{return null;}})(),outputs:state.messages.flatMap((o,i)=>o.type==='function_call_output'&&o.call_id===m.call_id?[{messageIndex:i,...o,parsedOutput:(()=>{try{return JSON.parse(o.output);}catch{return null;}})()}]:[]),persistedRecord:state.taskStore.toolCalls?.[m.call_id]||null}]:[]);
await save('tool-calls-and-results.json',calls);
const starts=state.events.flatMap((e,i)=>e.type==='start'?[i]:[]),userIndices=state.messages.flatMap((m,i)=>m.role==='user'?[i]:[]),turns=[],flow=[];
let lastSnapshot=null;
for(let n=0;n<starts.length;n++){
 const eventStart=starts[n],eventEnd=starts[n+1]??state.events.length,messageStart=userIndices[n],messageEnd=userIndices[n+1]??state.messages.length;
 const events=state.events.slice(eventStart,eventEnd).map((event,i)=>({eventIndex:eventStart+i,event}));
 for(const {eventIndex,event} of events)if(event.type==='task_state'){
  const current=event.task;
  flow.push({turn:n+1,eventIndex,kind:'persisted_task_snapshot',previousTaskId:lastSnapshot?.id||null,previousStatus:lastSnapshot?.status||null,taskId:current?.id||null,status:current?.status||null,changed:lastSnapshot?.id!==current?.id||lastSnapshot?.status!==current?.status,snapshot:current});lastSnapshot=current;
 }
 const messages=state.messages.slice(messageStart,messageEnd),ids=new Set(messages.filter(m=>m.type==='function_call').map(m=>m.call_id));
 const turn={number:n+1,runId:state.events[eventStart].runId,query:state.messages[messageStart]?.content,
  contextProvenance:'以下是应用完整已保存会话前缀，不是当时实际发送给模型的原始input。模型输入经过筛选和构建，但原始请求未落盘。',
  fullPersistedConversationBeforeTurn:state.messages.slice(0,messageStart),messages,events,toolCalls:calls.filter(c=>ids.has(c.call_id)),
  finalEvents:events.filter(e=>e.event.type==='final'),intentErrors:events.filter(e=>e.event.type==='intent_error')};
 turns.push(turn);await save('turns/'+String(n+1).padStart(2,'0')+'.json',turn);
}
await save('state-flow.json',{note:'状态流来自每个已保存task_state事件；changed是相邻快照差异计算，不是额外伪造的执行事件。最终会话状态与本轮状态分别保留。',snapshots:flow,finalSessionStatus:state.status,lastTurn:state.lastTurn,activeTaskId:state.taskStore.activeTaskId});
const contexts=Object.values(state.taskStore.tasks).flatMap(task=>task.items.flatMap(item=>(item.methods||[]).map(method=>({taskId:task.id,itemId:item.id,method}))));
await save('saved-method-contexts.json',contexts);
const gaps={rawModelInputsAvailable:false,rawModelOutputsAvailable:false,notes:[
 '生产适配器未持久化每次模型的原始input/output；本导出无法补回缺失数据。',
 '需求抽取/路由的最终接受结果保存在goal和intent事件；被拒绝草稿并非全部保存。',
 '媒体方法的input在item.methods中有部分实际记录，已逐字导出；不能把它当作整个模型请求。',
 '文字生成与验收的全部原始请求、原始响应、逐次usage和请求ID缺失。',
 'messages是应用保存的会话内容；历史前缀完整保留，但不是经上下文裁剪后的实际模型输入。',
 '保留原始状态中存在的矛盾，不把旧任务状态改写为本轮状态；未生成不存在的时间戳。',
 '工具返回中的原始媒体URL完整保留，可能有签名与有效期；没有复制.env或HTTP认证头。'
]};await save('completeness.json',gaps);
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const block=(label,value,open=false)=>`<details ${open?'open':''}><summary>${esc(label)}</summary><pre>${esc(typeof value==='string'?value:JSON.stringify(value,null,2))}</pre></details>`;
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>完整已保存会话 Trace</title><style>body{font:15px/1.7 system-ui;margin:32px auto;max-width:1100px;padding:0 24px;color:#202b32}h1{font-size:26px}nav{display:flex;flex-wrap:wrap;gap:12px}section{border-top:1px solid #ccc;margin-top:28px;padding-top:12px}details{border:1px solid #dce1e5;border-radius:6px;margin:12px 0;padding:10px}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace}.notice{background:#fff4d8;padding:16px}a{color:#126390}</style><h1>完整已保存会话 Trace</h1><p>会话 ${esc(state.id)} · ${turns.length}轮 · ${state.events.length}事件 · ${calls.length}次工具调用</p><p class="notice">包含全部已保存上下文、状态快照、工具输入输出与结果。原始模型请求/响应未落盘，无法补回；不能称为完整原始LLM trace。所有内容无截断。</p><nav>${turns.map(t=>`<a href="#turn-${t.number}">第${t.number}轮</a>`).join('')}</nav>${block('记录完整性与缺失项',gaps)}${turns.map(t=>`<section id="turn-${t.number}"><h2>第${t.number}轮</h2>${block('用户输入',t.query,true)}${block('最终结果',t.finalEvents,true)}${block('本轮完整消息',t.messages)}${block('本轮完整事件与状态快照',t.events)}${block('工具完整输入与输出',t.toolCalls)}${block('本轮之前完整已保存对话上下文（非实际LLM input）',t.fullPersistedConversationBeforeTurn)}${block('入口错误',t.intentErrors)}</section>`).join('')}<section><h2>全局账本</h2>${block('全部任务、执行、产物、输入与工具账本',state.taskStore)}${block('全部已保存状态流',flow)}${block('已保存方法上下文',contexts)}${block('原始会话全部字段',state)}</section></html>`;
await save('完整Trace.html',html);
await save('说明.md',`# 会话Trace导出\n\n会话：${state.id}\n\n打开“完整Trace.html”阅读，或读取JSON。所有已保存字段无截断。\n\n- session-original.json：原文件逐字节备份。\n- messages.json / events.json：完整消息与事件。\n- task-store.json：所有任务、执行记录、源材料与产物。\n- tool-calls-and-results.json：工具参数和返回按call_id配对。\n- state-flow.json：全部持久状态快照与相邻变化。\n- saved-method-contexts.json：实际保存的方法输入。\n- turns/：逐轮记录，含每轮之前完整应用会话前缀。\n- completeness.json：无法恢复的原始模型日志及证据边界。\n- manifest.json：文件长度和SHA256。\n\n**原始LLM请求/响应没有保存，无法事后补全。应用历史上下文不是实际模型input。**\n`);
await save('manifest.json',{sessionId:state.id,exportedAt:new Date().toISOString(),source:resolve(source),counts:{turns:turns.length,messages:state.messages.length,events:state.events.length,toolCalls:calls.length,toolOutputs:calls.reduce((n,c)=>n+c.outputs.length,0),stateSnapshots:flow.length,methodContexts:contexts.length},files:[...manifest]});
console.log(JSON.stringify({directory:root,turns:turns.length,files:manifest.length,bytes:manifest.reduce((n,f)=>n+f.bytes,0)}));
