# 上下文 Agent 实现与分阶段验收

日期：2026-09-16。工作副本：`chorifymvp-git`。基线：`242289a2dcbe7ea4d0c46a4c590176facf3ed21b`（旧合同修复分支）。新分支：`feat/context-agent-20260916`。

本轮根据用户提供的架构附件新增独立实现。旧入口、业务合同、调度和旧会话均未改动；现有文件中只为 `package.json` 增加独立启动和验证命令，其余为新增文件。本轮真实模型调用 0，真实媒体提交 0，没有运行 CLEAR。

## 阶段一：主循环、真实记录和工具

已实现并完成离线验收：一个原生工具循环，模型直接回复或提出当前调用；结果回到同一个 Agent。没有调用 `understandGoal/createTask/compileGoal/runCompiled/TaskExecutor/reconcileTask`，也没有把旧执行器包装成工具。

- 短会话直接回答不经过理解器/参数模型/最终回答模型。
- 同轮多个独立调用保留各自 call ID，收到反馈后才决定后续调用。
- 错误参数返回未提交的可操作错误；截断或非法协议不算正常结束。
- 请求重放不重复模型调用；中断恢复从真实回执找回结果或查询 ID。
- 字数测量复用确定性口径；Skill 只提供方法，不产生任务或授权。

证据：`tests/context-agent-loop.test.mjs`、`tests/context-agent-tools.test.mjs`，运行日志 `context-tests.log`。

## 阶段二：历史检索与受预算约束的上下文

已实现并完成离线验收：原始角色/时间/消息标识保留；owner 与会话隔离；关键词/时间检索和分页回读；按预算保留完整消息组，包含工具 Schema 与 6000 token 输出预留。

附件 ID 进入实际模型请求；旧稿被裁后可以回读同一原文；已加载 Skill 被裁时保留准确回读指针。存储原文和版本不被压缩覆盖。未实现自动摘要或跨会话语义记忆，首版使用可回查原始材料。

实际批准账本也进入低权限上下文，保留精确参数；用户聊天里声称批准不会生成批准记录。观察材料从真实 sourceId 读取，模型自称的事实状态不会覆盖原文。

证据：`tests/context-agent-history.test.mjs`、`tests/context-agent-behavior.test.mjs`，`scripted-traces/cross-topic-original-history.json`、`original-case-driver-approval.json`、`facts-and-observation.json`。

## 阶段三：受控媒体接入与真实测试准备

工具接入和保护已完成离线验收；真实模型/媒体效果验收尚未执行。

- 默认模拟媒体，模拟产物明确标记且无伪成品 URL。
- 同组方案可一次展示并选择批准；提交前保存调用身份。
- 参数、工具、模式、用户/会话变化不能复用批准。
- 同一批准方案重试不重复提交；新方案可以合法生成相同提示词。
- 断网未知、进程中断和持久化失败均不自动重新付费提交。
- 原图编辑自动保留父版本；创意文档与产品图有独立来源记录。
- 视频只查询实际回执，无后台自动推进或旧任务状态机。
- 主模型与视觉观察共享总模型调用预算；取消在下一次副作用之前检查。

此阶段不能宣称真实图片主体保持、视觉质量或真实模型选择能力通过。仅凭模拟轨迹与 Schema 合法不能证明新架构比旧版准确。

## 实际测试结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 新路径全部离线测试 | 73/73，0 skip | `context-tests.log` |
| 旧版及新路径全量回归 | 824/824，0 skip | `full-regression.log` |
| 原 23 条语料与业务 expected | 27 个文件 SHA-256 一致 | `fixture/manifest.json`、`semantic-status.json` |
| 原 23 条真实模型测试 | 23 条全部 not_run | `semantic-status.json` |
| 真实媒体/视觉验收 | not_run，真实媒体提交 0 | `TESTING.md` |
| HTTP 协议 | 独立会话、CSRF、禁止未授权模型、流式回复、重放、非法附件、批量批准均通过离线测试 | `context-agent-loop.test.mjs` |
| 浏览器手工冒烟 | 独立页面加载、模型关闭提示、发送被阻止、新对话清空均已实际验证 | `ui-smoke.json` |

完整命令（PowerShell；不加载 `.env` 运行测试）：

```powershell
$env:PYTHON_BIN = 'C:/Users/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
& 'C:/Users/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --test tests/context-agent-*.test.mjs
& 'C:/Users/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --test tests/*.test.mjs
& 'C:/Users/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/check.mjs
& 'C:/Users/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' evals/context-agent-evaluate.mjs
```

首次全量为 817/820：旧脚本测试默认调用 WindowsApps Python 启动入口，发生初始化输出 `Extracting`/超时。固定真实 `PYTHON_BIN` 后旧测试全部通过。随后一次集成为 823/824：新增行为 fixture 仍断言旧材料投影字段；更新为真实原文及 `agentAnnotation` 分离后的断言，并加强错误 verified 附注测试后，最终 824/824。原始失败日志分别保存在 `full-regression-initial.log`、`full-regression-integration.log`。没有删除用例、改原业务 expected 或增加 skip。

## 交付文件与已知限制

- 实现与启动说明：`server/context-agent/README.md`。
- 23 条适配：`ADAPTATION.md`；真实模型 runner 授权与预算说明：`TESTING.md`。
- 10 份脚本化 Trace：`scripted-traces/`，均明确 realModel=false、realMedia=false，包含实际请求与工具结果。
- 真实视觉观察仅在已配置模型确实支持图像输入且显式启用时注册。
- 模型仍可能选错工具、漏用原图或写出无依据承诺；本轮没有用固定工作流重新替模型做这些决定。
- 没有自动摘要、跨会话语义检索、后台视频续跑或分布式幂等；它们未被模拟成已完成能力。
- 旧媒体接口没有幂等键/查询回执的情形只能记录 unknown；不能保证任意供应商提供恰好一次处理。

回滚：停止 `start:context`，重新选择原来的 `npm start`；旧会话目录和入口保持原样。新会话仅供新引擎读取，不自动迁移到旧任务表。Git 可切回 `fix/contract-boundaries-20260916` 的基线；先保留本分支和新会话文件。无需删除原始历史或清空数据。
