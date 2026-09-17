# a82bf5f 审查后：单 Agent 边界收紧

基线：`a82bf5f27b0ce780089b42954541fd241f7a0b5e`，分支 `feat/context-agent-20260916`。

保留用户需求与记忆 → 同一个 Agent 规划 → 选工具 → 执行 → Agent 判断 → 回复。`loop.mjs` 未修改，没有新增 Planner、业务任务图、自动总审查、摘要模型或向量库。`invocations` 和 `approvals` 继续记录真实调用与参数批准。

## P1 独立验收

| 项目 | 修改 | 验收证据 |
|---|---|---|
| 全部 Skill | `methods/v1/index.json` 和 15 份 `method.md` 为直接版本来源；95 份参考资料按原参考 ID 分页读取。删除运行时 slug 文案映射、正文替换与标题裁剪。旧共享 Skill 保留。 | 新测试遍历全部启用方法与全部参考的最终工具输出；核对直接文件与分页结果相等，排除旧节点/渲染/工具协议；专业长正文保留。 |
| 目录预算 | 本轮附件/显式 ID 优先，近期资产目录最多 24 个且参与 token 预算；保留消息指针最多 8 个，省略方法指针去重后最多 6 个；批准只带最近有限 ID，不带完整参数。 | 0/100/200/300/1000 个资产均能组装短请求；旧对象可 `list_assets` 搜索分页和 `read_asset` 精确读取；200 个长参数批准不塞满上下文。 |
| 服务和评测 | 共用 `assembleAgentTools`，显式装配视觉观察与媒体模式；真实评测支持独立视觉授权和媒体授权，分别计数，视觉计入全局模型预算。 | 注入观察适配器后 wire 实际包含 input_image；关闭视觉时不注册工具；未授权模型/视觉/媒体在建立外部调用前拒绝。 |

目录增长实验使用空系统、空工具、空 Skill，预算 24000、预留 6000，标题约 120 个汉字。数据见 `measurements.json`，估算不是供应商 token 账单。

| 历史资产数 | 输入估算 token | 实际注入资产数 | 结果 |
|---:|---:|---:|---|
| 0 | 38 | 0 | 通过 |
| 100 | 2238 | 11 | 通过 |
| 200 | 2244 | 11 | 通过 |
| 300 | 2244 | 11 | 通过 |
| 1000 | 2244 | 11 | 通过 |

不是把全部标题塞入 24 个固定槽位：先满足目录预算，因此该样例实际只容纳 11 个。用户当前原话不裁剪；未展示对象仍保留，目录告知检索入口。

## P2 独立验收

| 项目 | 修改 | 验收证据 |
|---|---|---|
| 单图/双图职责 | `analyze_image` 只看明确 imageIds；`compare_images` 接收 sourceImageId/resultImageId；materials 由 Agent 选择。不再自动遍历父图、来源链或同次上传资料。 | 结果图的父图/来源缺失不阻塞单图 OCR；明确比较时缺失来源会被拦住；不会把同次上传另一商品资料自动消费。 |
| 观察预算 | 读取选定真实资料后，按正文与图片预留计算观察输入预算；超限在 provider I/O 前返回错误。Agent 可显式指定资料 offset/limit，返回出处、版本、总长度和分页位置。 | 12 万字符保存资料不能绕过参数限制直接进入观察；明确 80 字符节选可执行并保留 `stored_excerpt` 身份。 |
| 原稿修订 | `save_document({parentMessageId, content})` 一次原子存档原稿并保存真实 parentId 修订；已有 asset 仍用 parentId，原文已完整在上下文时不强制重读。 | 一次持久保存，原文准确、版本为 v2；保存失败两份文稿一并回滚，重放不重复。旧 sourceMessageId 原样存档仍兼容。 |
| 批准后提交 | `execute_approved({proposalId,approvalId})` 恢复已保存参数，复用原有授权、模式、摘要、取消、预算和回执检查。`read_approval` 可分页读取身份或读取具体方案。HTTP 批准消息也只带 ID。 | 不重抄参数，禁止额外参数；模式变化和摘要变化仍失效；重复请求返回同一回执。原来携带参数的媒体调用保持兼容。 |
| 存储 | Node 内置 SQLite 事务替代每次全量 JSON 覆写。records 为只追加行，traces 独立保存完整请求/响应并由 traceId/记录 ID 关联；assets 为稳定行，invocations/approvals 按变化写入。 | 300 条历史、大段 Trace 和大段资产下，追加一条短消息仅写入不足 1000 字节的有效载荷；Trace 不进入重新加载的常规 records。原始 Trace 可按 ID 读取、完整导出。 |
| 恢复与权限 | 每个 owner/session 独立存储，事务 FULL synchronous；原文/资产/批准不可改写，存储版本防止过期快照覆盖回执。 | 原始 JSON 无损迁移且留存；旧快照更新失败；付费提交前已持久 inflight，未知结果重启后不重复调用供应商。 |
| 依赖清理 | 新方法加载不再调用旧 loadCatalog/skillContract；countBody 抽到纯函数文件，旧模块重新导出同一函数；删除未使用 executeBatch 与重复 projectGroup.input 投影。 | 旧合同回归保留；独立批量方案仍可同轮调用，具体模型执行顺序仍由原 loop 控制。 |

SQLite 是存储实现，不新增业务状态。当前内存 session 结构仍为 records/assets/invocations/approvals。记录不可变序列化缓存、资产正文缓存与增量 SQL 写入避免反复复制大块 Trace 和原稿；恢复会话时仍需读取该会话常规历史和资产，未声称无限历史内存占用恒定。

## 真实模型与媒体的验证范围

本轮真实模型调用 0，真实媒体提交 0。最终检查是离线程序验收与历史参数重放，不能证明真实模型对每种说法均选择正确。

真实评测新增开关（本轮没有执行）：

- `--real`：必须已有 `CHORIFY_CONTEXT_REAL_MODEL_AUTHORIZED=1`、明确 `CHORIFY_CONTEXT_MODEL_MAX_CALLS` 和与配置一致的 `CHORIFY_CONTEXT_EXPECTED_MODEL`。
- `--vision`：额外要求 `CHORIFY_CONTEXT_VISION_AUTHORIZED=1`；图片观察计入同一全局模型调用预算，报告实际观察调用数。
- `--media-live`：额外要求 `CHORIFY_CONTEXT_REAL_MEDIA_AUTHORIZED=1` 与正数 `CHORIFY_CONTEXT_MEDIA_MAX_CALLS`。这是授权执行所选冻结语料中明确的批准动作；仍先形成实际参数提案再批准，不凭普通聊天文字越过门禁。没有该标志时媒体为 simulation。
- 输入素材必须配置固定文件哈希与 HTTPS 映射。原入口对远端字节的独立校验尚未实现，报告保留此限制。

真实图片结果质量、真实供应商重启行为和业务完成率仍未验证；本轮的供应商模拟测试验证持久化与幂等，不替代真实图片验收。观察 token 预算使用保守文本估算与图片预留，不是精确视觉计费。

## 测试与兼容性

```powershell
node --test --test-reporter=tap tests/context-agent-*.test.mjs
node --test --test-reporter=tap tests/*.test.mjs
node scripts/check.mjs
node evals/context-agent-memory-replay.mjs '<旧共享Trace目录>' evaluations/2026-09-16-context-agent-simplification/replay
```

结果：新路径 104/104，全仓 855/855，0 失败、0 skip。新增 14 项，P1 六项、P2 八项；它们分别检查方法/目录/装配与工具/存储边界。日志见 `context-tests.log`、`full-tests.log`、`syntax-check.log`。

23 条旧会话的 57 个工具参数仍通过 wire Schema；五份请求输入重建与历史读取对比在 `replay/`。这不是新模型输出，也不说明旧语义错误已自动修复。

旧 23 条语料及业务 expected 未改。既有测试中只更新了本轮明确改变的接口预期：SQLite 文件格式、只读记录的测试构造、批准 ID 投影、显式双图比较、显式资料选择、直接方法文件，以及删除 batch helper 后改用实际 execute。没有删除或 skip 失败用例，也没有把“不确定”改成“验收成功”。

运行要求 Node >=22.13（使用内置 node:sqlite，无新增 npm 依赖）；实际验证环境 Node 24.19.0。package 与 lockfile 同步。

## 迁移、导出和回滚

1. 当前只修改本地代码与测试，未启动生产服务，未迁移真实会话，未推送或部署。
2. 新服务首次读取旧会话时，从 owner 目录的 `<session>.json` 导入 `<session>.sqlite`；旧 JSON 留作迁移前备份，不被覆盖。新对话不再反复重写 JSON。
3. 完整 Trace 位于 SQLite 的 traces 表，常规 records 只保留关联信息。`read_history` 精确读取 Trace 记录时按 ID 加载原文；正常历史检索不会扫描完整 Trace。
4. 回退前停止服务并备份数据目录。对于新产生或继续修改过的会话，先导出最新完整旧格式，不能直接退回过时的迁移备份：

```powershell
node evals/context-agent-export.mjs '<数据目录>' '<owner>' '<session-id>' '<全新导出文件.json>'
```

导出包含原始消息、完整请求/响应 Trace、资产、回执及批准。工具禁止覆盖已有输出。停止服务后，再将导出文件放到旧版对应 owner 会话路径，使用基线 `a82bf5f` 的独立 checkout 回退；SQLite 与原始备份继续保留。

5. 代码 diff 见 `implementation.patch`。发布应整体部署方法、工具、上下文、存储与入口，P1/P2 是验收划分，不是两个可以任意拆开的运行版本。没有全新会话需要保留时，可在单独 checkout 直接运行基线，不删除现工作区数据。
