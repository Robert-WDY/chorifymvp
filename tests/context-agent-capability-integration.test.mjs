import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
import {buildContext} from '../server/context-agent/context.mjs';
import {maintainMemory,summaryRecords} from '../server/context-agent/memory.mjs';
import {createVisionBrain} from '../server/context-agent/runtime.mjs';
import {createImageObserver} from '../server/context-agent/providers.mjs';
import {historyRows,historyPage} from '../server/context-agent/history-view.mjs';
const say=text=>[{type:'message',content:[{type:'output_text',text}]}];
test('vision uses independent configured provider and sends both actual image inputs',async()=>{
 let body;const brain=createVisionBrain({LLM_PROVIDER:'deepseek',DEEPSEEK_MODEL:'text-only',CONTEXT_AGENT_VISION_PROVIDER:'doubao',DOUBAO_CHAT_MODEL:'vision',DOUBAO_API_KEY:'fake',DOUBAO_BASE_URL:'https://example.com'},async(url,options)=>{assert.match(url,/responses$/);body=JSON.parse(options.body);return new Response(JSON.stringify({output:say('左红右蓝'),usage:{input_tokens:1,output_tokens:1}}));});
 const result=await createImageObserver(brain)({images:[{id:'original',url:'https://example.com/original.png'},{id:'result',url:'https://example.com/result.png'}],question:'比较背景',materials:[{content:'容量未知'}],comparisons:[{original:'original',result:'result'}]});
 assert.equal(body.model,'vision');assert.equal(body.input[1].content.filter(x=>x.type==='input_image').length,2);assert.match(JSON.stringify(body.input),/容量未知/);assert.deepEqual(result.imageIds,['original','result']);assert.throws(()=>createVisionBrain({}),/独立指定/);
});
test('oversized professional method cannot block later summary coverage; original stays complete',async()=>{
 const s=createSession();appendRecord(s,{kind:'message',role:'user',content:'使用专业方法'});
 appendRecord(s,{kind:'tool_call',callId:'a',name:'read_skill',arguments:'{"slug":"method"}',groupId:'a'});const raw=appendRecord(s,{kind:'tool_result',callId:'a',output:JSON.stringify({ok:true,slug:'method',content:'专业方法正文。'.repeat(6000)}),groupId:'a'});
 const correction=appendRecord(s,{kind:'message',role:'user',content:'价格改为20元，容量仍然未知。'});appendRecord(s,{kind:'message',role:'assistant',content:'已记录'});appendRecord(s,{kind:'message',role:'user',content:'继续'});appendRecord(s,{kind:'message',role:'user',content:'当前要求'});
 const unchanged=JSON.stringify(s.records);let requests=0;
 await maintainMemory(s,{contextOptions:{systemPrompt:'test',tokenBudget:24000,reservedTokens:6000},config:{inputMaxTokens:8000,summaryMaxTokens:1800,maxCallsPerTurn:1},respond:async input=>{requests++;const p=JSON.parse(input[1].content);assert.ok(p.records.some(r=>r.id===correction.id));const method=JSON.parse(p.records.find(r=>r.id===raw.id).output);assert.equal(method.methodBodyOmitted,true);assert.equal(method.sourceRecordId,raw.id);return say(JSON.stringify({summaryText:'已读方法，正文按来源回读。价格20元，容量未知。',sourceRefs:[{kind:'message',id:correction.id},{kind:'tool_result',id:raw.id}]}));},save:async()=>{},remainingCalls:()=>10,turnId:'now'});
 assert.equal(requests,1);assert.ok(Object.values(s.summaries).length,JSON.stringify(s.records.filter(r=>r.event==='summary_failed')));assert.ok(Object.values(s.summaries)[0].coveredToSeq>=s.records.findIndex(r=>r.id===correction.id));assert.equal(JSON.stringify(s.records.slice(0,JSON.parse(unchanged).length)),unchanged);
});
test('method summary projection never truncates user originals or failed feedback',()=>{
 const records=[{kind:'message',content:'原文'.repeat(10000)},{kind:'tool_call',name:'read_skill',callId:'a'},{kind:'tool_result',callId:'a',output:'{"ok":false,"error":"failed"}'}];assert.deepEqual(summaryRecords(records),records);
});
test('failed method reread does not replace successful body history pointer',()=>{
 const s=createSession();for(const [id,output]of [['success',JSON.stringify({ok:true,content:'方法'.repeat(3000)})],['failure','{"ok":false,"status":"not_executed"}']]){appendRecord(s,{kind:'tool_call',callId:id,name:'read_skill',arguments:'{"slug":"same"}',groupId:id});appendRecord(s,{kind:'tool_result',id,callId:id,output,groupId:id});}
 appendRecord(s,{kind:'message',role:'user',content:'当前请求'});const input=buildContext(s,{tokenBudget:1200}).input;const notice=input.find(r=>r.content?.includes?.('omittedSkillReads'));assert.ok(notice.content.includes('success'));const parsed=JSON.parse(notice.content.slice(notice.content.indexOf('{')));assert.equal(parsed.historyWindow.omittedSkillReads[0].recordId,'success');
});
test('history detail sections keep original bodies, versions and old records; list is paged metadata',()=>{
 const s=createSession();s.assets.a={id:'a',content:'原文',version:2,parentId:'old'};const r=appendRecord(s,{kind:'message',role:'user',content:'<script>original</script>'});assert.equal(historyRows(s,'records')[0],s.records[0]);assert.equal(historyRows(s,'assets')[0].parentId,'old');assert.equal(historyRows(s,'legacyCalls',{modelCalls:[{input:'full'}]})[0].input,'full');assert.equal(historyPage(s.records,0,1).rows[0].id,r.id);assert.equal(historyPage(s.records,0,1).rows[0].content,undefined);assert.throws(()=>historyPage(s.records,-1));assert.throws(()=>historyRows(s,'unknown'));
});
