# 评测适配与离线验证

本页只记录新 context-agent 的语料适配及脚本化行为验证，不表示它已通过原 23 条真实用户语义验收。

## 已运行结果

| 层次 | 命令 | 真实结果 |
| --- | --- | --- |
| 原语料完整性 | `node evals/context-agent-evaluate.mjs` | 23 条用例、27 个文件 SHA-256 一致；模型调用 0，媒体调用 0 |
| 脚本化模型/工具反馈 | `node --test --test-reporter=tap tests/context-agent-behavior.test.mjs` | 13/13 通过，0 失败，0 skip；见 `behavior-test.tap` |
| 原 23 条真实模型理解 | 尚未运行 | 全部 `not_run`，见 `semantic-status.json` |
| 真实媒体执行与视觉审核 | 尚未运行 | `not_run`；模拟图片不含真实成品 URL，不算视觉通过 |

13 项覆盖：原语料完整性；同一 query 的成品、处理中、参数错误三个反馈分支；一个方向且仅文字；编辑原图与父版本；第二方向原文与产品原图；观察输入中的未知身份；历史裁剪后的跨话题原文读取；两种独立读取顺序的 call ID 回传；真实 wire 参数拒绝后的修正；共用评测驱动对原 EDIT_001 三轮查询及后台审批回执的传递。

这些 fixture 在 `brain.respond` 中预设合理动作，因此只能证明动作可用、输入和反馈真实传递、工具保护有效，不能证明真实模型会选对动作。观察测试使用注入的本地观察回执，反馈分支测试使用无网络工具。其他资产保存与媒体审批使用当前真实工具实现，但媒体为 simulation。

观察输入测试另外注入一段错误的 `verified` 模型附注，断言观察工具收到的主资料仍为真实保存的“容量未知；功效未经证明”原文、原版本和 `stored_original` 来源；模型文字与其自称 verified 的状态只出现在 `agentAnnotation`，不能覆盖原文或变成顶层事实身份。这是工具输入边界的证明，不是模型必然会尊重未知事实的证明。

历史测试显式断言原稿不在首轮投影视图，随后由 search_history 和 read_history 找回完全相同的原消息。总预算包含工具 Schema 和 6000 token 输出预留，历史有效窗口保持 2300；没有通过扩大历史窗口或改变完成 expected 消除失败。开发集成时曾因新预算口径导致该 fixture 首轮预算不足，修正测试预算的计算口径后通过。

`scripted-traces/` 保存 10 份上述离线状态与实际模型请求投影；每份标明 `realModel:false`、`realMedia:false`。它们不是原 23 条真实 Trace 的替代物。

## 原业务要求不变

固定 case JSON、原 setup_turns、原 query、expected、review_criteria 均按源文件字节复制。`ADAPTATION.md` 解释新旧 API 的对应关系。原工具名称保留，由原 tool_policy 允许的等价行为审查；不会为了新架构删除原业务要求。

在原 EDIT_001 的第三轮，用户提出编辑但没有新的确认 API 动作。新工具会保存编辑方案并等待批准；驱动不自动制造批准，测试也不把这次正常结束当成“编辑已交付”。这项审批差异必须在后续真实业务审核中明确记录，不能靠改 expected 掩盖。

这里冻结的是基准目录当前保存的两张图片字节。历史 23 条评测报告曾记录图片 URL 失效与替换，因此本轮不声称这些本地图等同于每次历史运行下载到的远程图，也不声称已完成严格同条件 A/B。

## 真实模型 runner 的关闭与启用条件

默认命令只做离线核对。真实模型入口必须同时具备：

1. 显式 `--real`，以及 `--cases=ID,ID` 或 `--all`。
2. `CHORIFY_CONTEXT_REAL_MODEL_AUTHORIZED=1`，须先另行核对用户授权。
3. `CHORIFY_CONTEXT_MODEL_MAX_CALLS` 为明确正整数；所有 case 共用该总预算，每次真实请求之前扣计数，用完即停止继续用例。
4. `CHORIFY_CONTEXT_EXPECTED_MODEL` 与已配置模型名严格一致，模型凭据由既有配置提供，报告不输出凭据。
5. 带图用例提供 `CHORIFY_CONTEXT_INPUT_URLS` 指向映射 JSON。每项格式为 `{"inputs/images/product_a.png":{"url":"https://...","sha256":"固定文件哈希"}}`。映射缺失则该用例 `not_run`，不换图、不伪造观察。声明哈希仅是操作者声明，远程字节是否一致仍须独立核验。

该 runner 强制媒体 simulation，不接受付费媒体开关。它未注入视觉观察服务，因此实际看图语义与媒体视觉质量仍不可验证；以后接入受控观察与媒体测试应另有授权和预算。即使真实模型运行结束，报告也只标 `executed_requires_review` / `unreviewed`，需要针对原 expected 审查 Trace，不自动写 pass。

## 回滚与重新生成证据

这些评测文件和测试均在新增路径；移除新入口的启动选择即可回到旧入口，不需要修改原语料或旧回归。若要重新冻结基准，需要显式运行 `node evals/context-agent-freeze.mjs <原评测目录>` 并审查 manifest diff；普通评测命令不会更改固定语料。

重新保存离线 Trace：设置 `CHORIFY_CONTEXT_TRACE_DIR=evaluations/2026-09-16-context-agent/scripted-traces`，再运行上述行为测试。生成内容必须继续标注脚本化证据等级。
