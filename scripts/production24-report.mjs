import {readFile,writeFile} from 'node:fs/promises';
const tag=process.argv[2]||'v3';if(!/^[a-z0-9-]+$/.test(tag))throw new Error('Invalid tag');
const base='data/production24-'+tag,read=async p=>JSON.parse(await readFile(p,'utf8'));
const summary=await read(base+'/summary.json'),results=await read(base+'/results.json'),traces=await Promise.all(results.map(r=>read(base+'/'+r.id+'/trace.json')));
const artifacts=traces.flatMap(t=>Object.values(t.state.taskStore.artifacts||{})).filter(a=>a.purpose==='deliverable');
const media=artifacts.filter(a=>a.metadata.simulated),text=artifacts.filter(a=>a.type==='text'&&a.verification.semantic==='passed');
const restart=traces.find(t=>t.restart)?.restart;
const previous=await Promise.all(['v1','v2'].map(async v=>({v,...await read('data/production24-'+v+'/summary.json')})));
const report=`# 24 场景评测修复与结果（2026-09-10）

最新完整运行：**${summary.passed}/${summary.total} 项断言通过**，覆盖 24 个主场景与 4 个变体；${summary.modelCalls} 次真实豆包调用，耗时 ${((Date.parse(summary.finishedAt)-Date.parse(summary.startedAt))/60000).toFixed(2)} 分钟，${summary.concurrency} 路并发。

这不是生产生成成功率或开放域意图准确率。本轮媒体提供方是模拟器，真实图片/视频生成数为 **0**。文字及计划由真实豆包生成和验证；模拟媒体不证明画面质量、参考图一致性、字幕准确或真实供应商可用性。

## 修复内容

1. 附件原样保留为 source-cases.json，补充可运行的场景、逐轮状态、故障注入、独立进程恢复、评分器与负例测试。期望结果不进入模型输入。
2. 失败草稿修复与用户更改目标分开理解；继续原目标保留 Task ID，使用已有验收反馈生成新版本。
3. 原始目标数量与工具限制分开：语义合同可保留更大数量；单批支持 20 件媒体，超过 20 的单项保留目标并明确阻断，不擅自减量。
4. 多条文案可以在同一正文交付，验证器检查 requiredUnits，已验收正文记录 unitCount，状态机据此判断覆盖数量。未核验产物不计入完成。
5. NEEDS_INPUT 禁止通过 continue/approve 跳过目标重建；模型收到结构化错误反馈后改为 clarify，保留原 ID 并重新编译完整需求。空执行图不再保持运行状态。
6. Goal 校验器核对确认义务来源，不接受模型自行添加的“谨慎原则”。识别仍由豆包执行，没有添加 Query 关键词路由。
7. 修复评分器对多行脚本的 JSON 转义误判，实际解析 Skill 输入中的 sources 检查依赖消费。

## 分开看结果

| 类别 | 数量 |
|---|---:|
${Object.entries(summary.classifications).map(([k,v])=>`| ${k} | ${v} |`).join('\n')}

flow_completed 表示文字或模拟媒体流程完成；capability_gap_handled 表示明确保留目标并阻断，不算用户任务交付完成；safely_stopped 表示安全拒绝或未知提交正确停止。

本轮留存模拟媒体 Artifact ${media.length} 个（包括失败草稿版本），验收通过的文字 Artifact ${text.length} 份。所有模型调用均未获得自由执行工具权限：${traces.flatMap(t=>t.calls).filter(c=>c.tools.length===0).length}/${summary.modelCalls}；实际业务工具由执行器在 Skill 合同验证后调用。

重启证据：进程 ${restart?.beforePid} 在持久回执后终止，进程 ${restart?.afterPid} 加载磁盘状态；Task ID 为 ${restart?.taskId}，providerTaskId 为 ${restart?.providerTaskId}，生成提交仍只有一次。这是 Agent 工作进程的真实终止/重建，不是只重新构造内存对象。

## 逐项结果

| ID | 场景 | 结果 | 最终状态 | 模型调用 | 媒体提交 | 未通过断言 |
|---|---|---|---|---:|---:|---|
${results.map(r=>`| ${r.id} | ${r.name} | ${r.passed?'通过':'未通过'} | ${r.status} | ${r.modelCalls} | ${r.submissions} | ${[...Object.entries(r.checks||{}),...Object.entries(r.hard||{})].filter(([,v])=>!v).map(([k])=>k).join('、')||'—'} |`).join('\n')}

## 各轮区别

${previous.map(s=>`- ${s.v}：${s.passed}/${s.total}，${s.modelCalls} 次模型调用。`).join('\n')}
- ${tag}：${summary.passed}/${summary.total}，${summary.modelCalls} 次模型调用。

v1 是首次诊断：C004 草稿 Fixture 缺少最初的白背景要求；C008 错把单批上限当作整任务不支持；C024 的脚本引用被评分器转义问题误判。因此 v1 与后续得分不能直接解释为同一数据集上的提升。v2、v3 使用相同修订场景，均为完整新跑，不是把不同轮次的成功结果拼接。v2 的两项失败为 C001 自行要求确认，以及 C019 补素材后错误续跑。

## 仍未证明或未支持的部分

- 15 秒单条视频、竞品视频分析和按真实视频结构复刻仍是当前执行器的能力缺口。它们正确阻断也会通过对应安全断言，但没有完成原媒体任务。
- 模拟器只提供已知回执和虚拟 URL；没有下载、播放或视觉比对真实媒体。
- 本套只有 24 个业务/状态场景，部分原始模糊 Query 为可重复执行补齐了产品、媒介和素材。通过不能外推为任意自然语言都可靠。
- 入口 understanding 断言只检查是否成功形成目标且无入口错误；数量、引用、确认、依赖等另有断言。没有把它叫作完整语义准确率。正文的事实与创意质量依赖当前模型验证，仍需真实业务人工抽查。
- 未覆盖多进程同时写同一会话、真实供应商扣费去重、长时间服务故障与生产负载。

## 复现与证据

命令：\`npm run eval:production -- new-run-name 4\`。每次必须使用新名称；不覆盖既有结果。单项回归可追加 \`--only=C001,C019\`，但应单独报告为子集。

- [最新汇总](${base}/summary.json)、[逐项评分](${base}/results.json)
- [评测说明与修订](${base}/code/evals/production24/README.md)
- [原始场景备份](${base}/code/evals/production24/source-cases.json)
- 每个场景目录中的 trace.json 包含模型输入输出、逐轮快照、状态、工具调用、供应商记录与 Artifact；sessions 中为真实 SessionStore 文件。
- 本轮源码 SHA-256：\`${summary.sourceHash}\`；运行前后源码一致：**${summary.sourceUnchanged}**。server、skills、评测源码已复制到本轮 code 目录。
- 自动化回归：123/123；日志：[测试日志](data/production24-unit-tests.log)。
`;
await writeFile('PRODUCTION-24-EVALUATION-20260910.md',report);
console.log(JSON.stringify({passed:summary.passed,total:summary.total,modelCalls:summary.modelCalls,simulatedMediaArtifacts:media.length,verifiedTextArtifacts:text.length,classifications:summary.classifications,restart}));
