# 完整 500 条评测结果（2026-09-10）

已执行原包 **500/500 条**，没有去重或抽样。实际调用模型的记录 500 条，完整 trace 500 份，原始 Query 保留 500 条。诊断断言通过 **492/500（98.4%）**。

本次使用真实豆包 doubao-seed-2-1-turbo-260628，16 路并发，模型调用 1368 次，用时 12.24 分钟。媒体提供方是模拟器，**真实图片/视频生成数为 0**，不把诊断通过率称为生产完成率或完整意图准确率。

## 任务结果必须分开看

| 结果类别 | 条数 |
|---|---:|
| missing_fixture_or_input | 233 |
| flow_completed | 211 |
| failed | 8 |
| awaiting_confirmation | 23 |
| capability_gap_handled | 25 |

flow_completed：文字或模拟媒体交付通过断言；missing_fixture_or_input：缺素材或历史，正确澄清但没有完成任务；awaiting_confirmation：方案待用户确认，未提交媒体；capability_gap_handled：保留目标但当前能力不支持；failed：至少一项诊断断言未通过。

最终状态为 completed/simulated 的记录有 213 条，其中是否完全符合逐项断言需结合上表。留存通过验收的文字 Artifact 162 份、模拟图片 16 个、模拟视频 63 个，另外有 1 个被拒绝版本。模拟媒体仅证明回执、参数和状态闭环。

## 原包六层覆盖

| 原始层级 | 原始条数 | 已执行 | 断言通过 |
|---|---:|---:|---:|
| L1_understanding | 100 | 100 | 98 |
| L2_planning | 100 | 100 | 97 |
| L3_execution | 100 | 100 | 99 |
| L4_state | 80 | 80 | 80 |
| L5_artifact | 60 | 60 | 58 |
| L6_recovery | 60 | 60 | 60 |

## 按原始 Query 查看

| Query | 次数 | 通过 | 未通过 |
|---|---:|---:|---:|
| 帮我做一个适合TikTok投放的产品视频 | 25 | 23 | 2 |
| 分析这个爆款视频为什么有效 | 25 | 25 | 0 |
| 把刚才的视频改得更年轻 | 25 | 25 | 0 |
| 做一个品牌新品发布视频 | 25 | 25 | 0 |
| 我要推广一个新品精华到巴西市场 | 25 | 25 | 0 |
| 用我的产品素材做一个短视频广告 | 25 | 24 | 1 |
| 先给营销方案确认后再生成视频 | 25 | 23 | 2 |
| 没有素材但是想测试广告方向 | 25 | 25 | 0 |
| 生成15秒9:16护肤广告视频 | 25 | 25 | 0 |
| 用产品图生成真人使用场景 | 25 | 24 | 1 |
| 把视频中的背景替换掉 | 25 | 25 | 0 |
| 生成10个不同Hook版本 | 25 | 25 | 0 |
| 继续刚才没有完成的视频 | 20 | 20 | 0 |
| 把第二版改成更高级一点 | 20 | 20 | 0 |
| 确认刚才的方案 | 20 | 20 | 0 |
| 重新生成第3条 | 20 | 20 | 0 |
| 我要最终可以投放的视频 | 15 | 14 | 1 |
| 生成5个广告素材 | 15 | 15 | 0 |
| 输出完整营销方案 | 15 | 14 | 1 |
| 优化成品质量 | 15 | 15 | 0 |
| 视频生成失败了怎么办 | 15 | 15 | 0 |
| 刚才任务中断继续 | 15 | 15 | 0 |
| 素材不存在怎么办 | 15 | 15 | 0 |
| 用户改成生成图片 | 15 | 15 | 0 |

## 未通过记录

同一记录可能同时触发多个断言，下面的原因数量不能直接相加：state 8；video 3；noMedia 2；missing 2；waitConfirm 2；understanding 1；text 1。

| ID | Query | 状态 | 未通过断言 | 原因 |
|---|---|---|---|---|
| L1_understanding-001 | 帮我做一个适合TikTok投放的产品视频 | blocked | state、video | 计划验收未通过：视频比例为16:9横屏，不满足TikTok竖屏投放的常规适配要求，与prompt中明确的竖屏拍摄要求不一致，参数自洽性存在问题 |
| L1_understanding-053 | 帮我做一个适合TikTok投放的产品视频 | blocked | state、video | 当前单次视频支持2至12秒整数时长，不能擅自改变目标时长 |
| L2_planning-022 | 用我的产品素材做一个短视频广告 | simulated | state、noMedia、missing |  |
| L2_planning-023 | 先给营销方案确认后再生成视频 | blocked | state、waitConfirm | [{"instancePath":"/items/0/ratio","schemaPath":"#/properties/items/items/properties/ratio/const","keyword":"const","params":{"allowedValue":"16:9"},"message":"must be equal to constant"}] |
| L2_planning-035 | 先给营销方案确认后再生成视频 | failed | understanding、state、waitConfirm | Goal合同核验未通过：用户明确要求先给营销方案确认后再生成视频，其中营销方案交付后需用户确认方可推进后续视频生成，属于用户明确要求的确认义务，approval.required应设为true，当前semantic将其设为false不符合要求。 |
| L3_execution-066 | 用产品图生成真人使用场景 | simulated | state、noMedia、missing |  |
| L5_artifact-035 | 输出完整营销方案 | blocked | state、text | 验收器未返回有效结构 |
| L5_artifact-049 | 我要最终可以投放的视频 | blocked | state、video | 当前单次视频支持2至12秒整数时长，不能擅自改变目标时长 |

详细语义目标、最后回复、错误和上下文见 [失败明细](data/production500-v1/failures.json)。这些记录保留在本次结果中，没有以另一次成功重跑替换。

## 工具与状态检查

| 检查 | 通过／检查数 |
|---|---:|
| understanding | 499/500 |
| state | 492/500 |
| modelToolIsolation | 500/500 |
| video | 62/65 |
| noFakeMedia | 500/500 |
| noFalseCompletion | 500/500 |
| simulationLabel | 500/500 |
| noMedia | 403/405 |
| missing | 233/235 |
| skillContract | 79/79 |
| parameters | 79/79 |
| text | 119/120 |
| waitConfirm | 23/25 |
| duration | 25/25 |
| units | 15/15 |
| image | 15/15 |

模型获直接工具权限的调用：0/1368。实际工具由执行器调用，记录频次为：commit_text_deliverable 163；find_material 131；run_skill 102；generate_video 63；get_video_task 63；generate_image 16。模型请求报错记录 0 次，结构修复重试仍计入总调用。

understanding 只表示成功形成任务且无入口错误；noFakeMedia 检查登记的媒体 Artifact 有供应商回执来源；noFalseCompletion 检查完成状态具有足量已验收 Artifact。这些不是所有语义、正文事实或视觉质量的人工金标准。

## 已核对的原因与修复方向

- **P0 required_source_downgraded**（L2_planning-022、L3_execution-066）：用户要求使用自己的产品素材或产品图，但源素材缺失被降为偏好，Agent改为生成概念作品。执行回执真实于模拟器，但交付目标已改变。 建议：由模型输出显式输入绑定和引用来源，执行器验证必需素材是否存在。区分从零创作与必须基于用户素材的任务，不能用通用样稿策略覆盖后者。
- **P1 inferred_duration_promoted_to_requirement**（L1_understanding-053、L5_artifact-049）：用户未指定时长，模型却将默认30秒写进spec.durationSeconds，执行器据此正确阻断了一个原本可以执行的任务。 建议：在结构化参数中记录来源和证据，区分用户硬约束与可调整默认值。默认值由能力配置统一确定，而不是把创意建议当硬约束。
- **P1 ratio_default_conflicts_with_plan**（L1_understanding-001、L2_planning-023）：竖屏目标或提示词与执行合同默认16:9冲突，导致Schema或计划验收失败。 建议：先统一有效参数，再供Skill与验收器读取同一份约束。由模型判断隐含平台需求，不能在提示词和Schema各自补默认值。
- **P1 approval_auditor_contradiction**（L2_planning-035）：第一轮需求理解保留了正确确认义务；校验器误解其为方案交付前审批而要求改false，下一轮又因false拒绝目标。 建议：明确approval的作用阶段为媒体提交，给校验器提供与执行器一致的合同。语义核验应检查用户确认来源，不应重新解释字段含义。
- **P1 verifier_returns_schema_instead_of_verdict**（L5_artifact-035）：正文已由模型生成，但验收器两次输出Schema对象而不是passed/issues/uncertain实例。校验正确阻断完成状态，不过正文尚未写入Artifact，最终没有可交付草稿。 建议：给验收器明确的返回实例示例并区分Schema和结果；先持久化未验收的文字草稿，再验证。格式失败只重试验收，不丢弃正文或默认通过。

本轮先完成冻结版本的全量测量，上述失败没有中途修改代码或用成功重跑替换。建议优先修复素材绑定，其次统一参数来源和确认合同；这些是语义合同与状态约束，不是增加 Query 关键词匹配。

## 数据与结论的限制

- 原包 500 条只有 24 种 Query、168 种 Query 与上下文组合。500 条均运行，但不能等同 500 种独立需求。
- 原包记录全为单轮，缺少关联的真实素材、已有任务状态、审批记录和故障脚本。标成 L4/L6 不代表实际测试了多轮或重启恢复；本次没有虚构这些输入。之前 24 场景里的状态 Fixture 和故障注入不计入这 500 条。
- 原 expected.goal 固定为同一标签、golden trace 为通用文字、评分程序未实现。原标签已保留；本次报告的是明确说明的可执行诊断断言，不是伪造官方分数。
- 业务上下文按原文作为用户资料提供，当前 Query 的明确要求优先。没有为了适配能力改成 5 秒、补上素材或自动确认。
- 文本内部数量及质量沿用语义验证器；离线断言没有用正则替代完整正文评审。真实媒体质量、外部服务可靠性和线上成功率仍需另外实测。

## 复现与完整性

运行命令：`node --env-file-if-exists=.env evals/production500/run.mjs new-run 16`。原包 SHA-256：`5E1335FBD030D1B7092072B2CE38232A7A46511E047AE7DDC971AA925E01882E`。

代码快照 SHA-256：`ced4b83fe12308de5b22538f415a5b596941881b0f828bdf2c7a2efdfdcf0301`；运行前后代码一致：true。缺失结果 ID：0；额外结果 ID：0。

- [完整性核对](data/production500-v1/coverage-proof.json)
- [500 条逐项结果](data/production500-v1/results.json)
- [汇总](data/production500-v1/summary.json)
- [原始记录](data/production500-v1/code/evals/production500/source-cases.json)
- 每条目录中的 trace.json 保存模型输入输出、状态、Skill/工具调用、回执和产物；code 目录保存本轮服务及评测代码。
