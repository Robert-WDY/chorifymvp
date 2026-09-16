import {readFile,writeFile} from 'node:fs/promises';
const tag=process.argv[2]||'v1';if(!/^[a-z0-9-]+$/.test(tag))throw new Error('Invalid tag');
const root='data/production500-'+tag,read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const source=await read(root+'/code/evals/production500/source-cases.json'),results=await read(root+'/results.json'),summary=await read(root+'/summary.json');
const reviewed=await read(root+'/reviewed-causes.json');
const byId=new Map(results.map(r=>[r.id,r])),ids=new Set(source.map(c=>c.id)),queryOf=c=>c.conversation.filter(m=>m.role==='user').map(m=>m.content).join('\n');
const frequencies=key=>Object.fromEntries([...new Set(source.map(key))].map(k=>[k,source.filter(c=>key(c)===k).length]));
const queries=frequencies(queryOf),levels=frequencies(c=>c.level),statuses={},tools={},failed=[],calls={total:0,withTools:0,errors:0},artifacts={text:0,simulatedImage:0,simulatedVideo:0,rejected:0},checks={};
let traceCount=0,actualModelCases=0,queryPreserved=0,completedStates=0;
for(const c of source){const r=byId.get(c.id);if(!r)continue;statuses[r.status]=(statuses[r.status]||0)+1;
 const trace=await read(root+'/'+c.id+'/trace.json');traceCount++;if(trace.calls.length)actualModelCases++;
 if(c.conversation.filter(m=>m.role==='user').every(m=>trace.state.messages.some(x=>x.role==='user'&&x.content===m.content)))queryPreserved++;
 calls.total+=trace.calls.length;calls.withTools+=trace.calls.filter(x=>x.tools.length).length;calls.errors+=trace.calls.filter(x=>x.error).length;
 const store=trace.state.taskStore||{},task=store.tasks?.[store.activeTaskId];
 if(['completed','simulated'].includes(trace.state.status))completedStates++;
 for(const call of Object.values(store.toolCalls||{}))tools[call.name]=(tools[call.name]||0)+1;
 for(const a of Object.values(store.artifacts||{})){if(a.purpose!=='deliverable')continue;if(a.verification?.semantic==='failed'){artifacts.rejected++;continue;}if(a.type==='text'&&a.verification?.semantic==='passed')artifacts.text++;if(a.metadata?.simulated&&a.verification?.semantic==='simulated_passed')artifacts[a.type==='image'?'simulatedImage':'simulatedVideo']++;}
 for(const [name,value] of [...Object.entries(r.checks||{}),...Object.entries(r.hard||{})]){checks[name]??={checked:0,passed:0};checks[name].checked++;if(value)checks[name].passed++;}
 if(!r.passed)failed.push({id:c.id,query:queryOf(c),context:c.business_context,status:r.status,checks:[...Object.entries(r.checks||{}),...Object.entries(r.hard||{})].filter(([,v])=>!v).map(([k])=>k),reason:r.reason||r.harnessError||'',goal:task?.goal||trace.state.events?.findLast(e=>e.type==='intent_error')?.partialSemantic,final:trace.state.events?.filter(e=>e.type==='final').at(-1)?.text,modelErrors:trace.calls.filter(x=>x.error).map(x=>x.error)});
}
const proof={sourceRecords:source.length,resultRecords:results.length,uniqueResultIds:byId.size,missingIds:[...ids].filter(id=>!byId.has(id)),unexpectedIds:results.filter(r=>!ids.has(r.id)).map(r=>r.id),traceCount,actualModelCases,queryPreserved,sourceUnchanged:summary.sourceUnchanged,uniqueQueries:Object.keys(queries).length,uniqueQueryContexts:new Set(source.map(c=>JSON.stringify([queryOf(c),c.business_context]))).size,calls,artifacts,checks,statuses,tools,completedStates};
await writeFile(root+'/coverage-proof.json',JSON.stringify(proof,null,2));await writeFile(root+'/failures.json',JSON.stringify(failed,null,2));
const failureReasons=Object.fromEntries([...new Set(failed.flatMap(f=>f.checks))].map(k=>[k,failed.filter(f=>f.checks.includes(k)).length]));
const row=(a)=>a.map(x=>String(x??'').replaceAll('|','／').replaceAll('\n',' ')).join(' | ');
const report=`# 完整 500 条评测结果（2026-09-10）

已执行原包 **${results.length}/500 条**，没有去重或抽样。实际调用模型的记录 ${actualModelCases} 条，完整 trace ${traceCount} 份，原始 Query 保留 ${queryPreserved} 条。诊断断言通过 **${summary.passed}/${results.length}（${(100*summary.passed/results.length).toFixed(1)}%）**。

本次使用真实豆包 ${summary.model}，${summary.concurrency} 路并发，模型调用 ${calls.total} 次，用时 ${((Date.parse(summary.finishedAt)-Date.parse(summary.startedAt))/60000).toFixed(2)} 分钟。媒体提供方是模拟器，**真实图片/视频生成数为 0**，不把诊断通过率称为生产完成率或完整意图准确率。

## 任务结果必须分开看

| 结果类别 | 条数 |
|---|---:|
${Object.entries(summary.classifications).map(([k,v])=>'| '+row([k,v])+' |').join('\n')}

flow_completed：文字或模拟媒体交付通过断言；missing_fixture_or_input：缺素材或历史，正确澄清但没有完成任务；awaiting_confirmation：方案待用户确认，未提交媒体；capability_gap_handled：保留目标但当前能力不支持；failed：至少一项诊断断言未通过。

最终状态为 completed/simulated 的记录有 ${completedStates} 条，其中是否完全符合逐项断言需结合上表。留存通过验收的文字 Artifact ${artifacts.text} 份、模拟图片 ${artifacts.simulatedImage} 个、模拟视频 ${artifacts.simulatedVideo} 个，另外有 ${artifacts.rejected} 个被拒绝版本。模拟媒体仅证明回执、参数和状态闭环。

## 原包六层覆盖

| 原始层级 | 原始条数 | 已执行 | 断言通过 |
|---|---:|---:|---:|
${Object.entries(levels).map(([level,count])=>'| '+row([level,count,results.filter(r=>r.level===level).length,results.filter(r=>r.level===level&&r.passed).length])+' |').join('\n')}

## 按原始 Query 查看

| Query | 次数 | 通过 | 未通过 |
|---|---:|---:|---:|
${Object.entries(queries).map(([q,n])=>{const selected=source.filter(c=>queryOf(c)===q).map(c=>byId.get(c.id));return'| '+row([q,n,selected.filter(r=>r?.passed).length,selected.filter(r=>!r?.passed).length])+' |';}).join('\n')}

## 未通过记录

同一记录可能同时触发多个断言，下面的原因数量不能直接相加：${Object.entries(failureReasons).map(([k,v])=>k+' '+v).join('；')||'无'}。

| ID | Query | 状态 | 未通过断言 | 原因 |
|---|---|---|---|---|
${failed.map(f=>'| '+row([f.id,f.query,f.status,f.checks.join('、'),f.reason.slice(0,260)])+' |').join('\n')||'| — | 无 | — | — | — |'}

详细语义目标、最后回复、错误和上下文见 [失败明细](${root}/failures.json)。这些记录保留在本次结果中，没有以另一次成功重跑替换。

## 工具与状态检查

| 检查 | 通过／检查数 |
|---|---:|
${Object.entries(checks).map(([k,v])=>'| '+row([k,v.passed+'/'+v.checked])+' |').join('\n')}

模型获直接工具权限的调用：${calls.withTools}/${calls.total}。实际工具由执行器调用，记录频次为：${Object.entries(tools).map(([k,v])=>k+' '+v).join('；')}。模型请求报错记录 ${calls.errors} 次，结构修复重试仍计入总调用。

understanding 只表示成功形成任务且无入口错误；noFakeMedia 检查登记的媒体 Artifact 有供应商回执来源；noFalseCompletion 检查完成状态具有足量已验收 Artifact。这些不是所有语义、正文事实或视觉质量的人工金标准。

## 已核对的原因与修复方向

${reviewed.map(g=>`- **${g.priority} ${g.category}**（${g.ids.join('、')}）：${g.finding} 建议：${g.suggestion}`).join('\n')}

本轮先完成冻结版本的全量测量，上述失败没有中途修改代码或用成功重跑替换。建议优先修复素材绑定，其次统一参数来源和确认合同；这些是语义合同与状态约束，不是增加 Query 关键词匹配。

## 数据与结论的限制

- 原包 500 条只有 ${Object.keys(queries).length} 种 Query、${proof.uniqueQueryContexts} 种 Query 与上下文组合。500 条均运行，但不能等同 500 种独立需求。
- 原包记录全为单轮，缺少关联的真实素材、已有任务状态、审批记录和故障脚本。标成 L4/L6 不代表实际测试了多轮或重启恢复；本次没有虚构这些输入。之前 24 场景里的状态 Fixture 和故障注入不计入这 500 条。
- 原 expected.goal 固定为同一标签、golden trace 为通用文字、评分程序未实现。原标签已保留；本次报告的是明确说明的可执行诊断断言，不是伪造官方分数。
- 业务上下文按原文作为用户资料提供，当前 Query 的明确要求优先。没有为了适配能力改成 5 秒、补上素材或自动确认。
- 文本内部数量及质量沿用语义验证器；离线断言没有用正则替代完整正文评审。真实媒体质量、外部服务可靠性和线上成功率仍需另外实测。

## 复现与完整性

运行命令：\`node --env-file-if-exists=.env evals/production500/run.mjs new-run 16\`。原包 SHA-256：\`${summary.sourceZipSHA256}\`。

代码快照 SHA-256：\`${summary.sourceHash}\`；运行前后代码一致：${summary.sourceUnchanged}。缺失结果 ID：${proof.missingIds.length}；额外结果 ID：${proof.unexpectedIds.length}。

- [完整性核对](${root}/coverage-proof.json)
- [500 条逐项结果](${root}/results.json)
- [汇总](${root}/summary.json)
- [原始记录](${root}/code/evals/production500/source-cases.json)
- 每条目录中的 trace.json 保存模型输入输出、状态、Skill/工具调用、回执和产物；code 目录保存本轮服务及评测代码。
`;
await writeFile('PRODUCTION-500-EVALUATION-20260910.md',report);
console.log(JSON.stringify({passed:summary.passed,total:results.length,...proof,failures:failed.map(f=>({id:f.id,checks:f.checks,reason:f.reason}))}));
