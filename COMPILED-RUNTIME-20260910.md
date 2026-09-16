# 可验证任务执行协议

默认 HTTP 应用使用编译运行时。语义入口由豆包理解用户需求，不对 Query 做关键词路由。

## 六个对象

| 对象 | 持久字段 / 合同 | 责任 |
|---|---|---|
| Goal | tasks、semantic、safety、assumptions | 保留结果、约束与缺口 |
| Task | items、status、executionPlan、approval、transitions | 进度、依赖、用户决定 |
| Artifact | purpose、sourceExecutionId、parentId、version、verification | 方案与成品区分、来源和修订 |
| Skill Contract | 输入输出 Schema、workflow、allowedTools、validation | 强制生成合同方案 |
| Tool Contract | 参数 Schema、前置条件、批次槽位、回执 | 受限执行与副作用证据 |
| State Machine | 持久状态与转换日志，reconcileTask 完成判定 | 不接受模型宣称完成 |

## 执行图

每个 Goal 交付项编译为节点，包含 itemId、dependsOn、kind、skillId、tool、output、count。图结构和原始 Goal 分别计算 hash。依赖必须指向前序节点。

媒体节点必须运行对应 Skill，由豆包根据结构化 Goal、真实素材、前序产物和反馈输出 concept、preservedConstraints、safety、items。items 直接使用实际工具的参数 Schema，模型不能自由命名工具。

每次编译进一步专门化 Schema：items 的最小、最大数量等于剩余成品数，视频 duration 和 ratio 使用本任务常量。一个 item 对应完整成品；分镜时间段写入同一个 prompt。旧专业资料放入输入的 methodReferences，不能获得系统指令优先级。

系统校验数量、引用、参数、服务状态与计划语义后保存方案 Artifact 和批次。节点记录 batchId、argsHash、skillArtifactId、revision，旧方案保存在 history。提交前核对图、批次和 Skill 产物，只执行对应批次槽位的精确参数。

这是按依赖逐步编译：完整交付图先保存，前序产物完成后才编译后续具体参数。

## Skill 的提供

- generate_image / edit_image → image_creation_skill → generate_image
- generate_video → video_creation_skill → generate_video

图片 Skill 读取图片提示词、封面文案资料；视频 Skill 读取脚本、分镜、安全方法。原资料仅作为方法，不能覆盖 Goal。输入输出做 Schema 验证，方案另经模型验收，合同输出通过后才允许提交。

模型没有执行工具权限。素材检索、提交、轮询、状态和 Artifact 登记由系统调度。文字节点使用受约束的模型输出和验证器，不注册第三个公开 Skill。

## 确认与多轮

只在用户要求时确认，具体参数保存后进入 WAIT_CONFIRM，确认绑定当前批次 hash。确认后不重新调用 Skill 改写参数。

新版入口必须输出 approval 和 continuation。缺目标时仍保留确认义务。补充回答被识别为 clarify 后，以相同 Task ID 修订完整目标并继承原确认义务。历史帮助理解，任务存储负责真实状态。

确认场景增加独立的 Goal 合同核验调用，检查用户数量是否被扩张、是否凭空产生方案图、尚无目标时是否错误交付说明文字、补充时是否保留原任务。发现不一致后让豆包重新理解一次；仍失败则阻塞，不按关键词修正目标。

continuation 选择续接、补充、修订或批准时，Task ID 必须与当前持久快照逐字一致。漏字或自造 ID 触发结构修复，不能退化为新建任务。

修改旧产物创建新 Task，通过真实素材引用生成 Artifact 新版本，不能从聊天措辞创造素材 ID。

## 验证与恢复

- 类型、数量、内容验证都通过才允许生产任务 COMPLETED。
- 无法观察：保留 URL 和 unverified 标记，重试验证，不重新生成。
- 内容明确失败：保留失败版本，将反馈交给 Skill，最多一轮额外媒体修复。
- 文字失败：保留失败正文，反馈修复一次；字数提供程序计数，减少模型心算错误。
- 验收 JSON 无效时重试一次，不默认成功。中文“字数”默认排除标点和空格，明确要求总字符数时才计入。
- 已知提交拒绝可在预算内重试；未知提交阻塞，重启不重提。
- 已有视频回执只查询其 ID，查询超时不等于生成失败。
- 后台完成后仍有后续节点或待核验产物，有限次数恢复保存的任务。
- 模拟媒体使用 SIMULATED，不计真实生成或视觉通过。

## 评测

1000 条集合为 **40 个场景族 × 25 个产品变体**，并非 1000 种独立工作流。覆盖生成、批量、比例、文字、编辑、缺素材、审核、攻击、范围外能力、多轮确认、补充后确认、版本和故障注入。每条独立调用真实豆包，不复用其他 Query 的模型结果。

| 层级 | 证据 | 边界 |
|---|---|---|
| 理解 | Goal 的媒介、数量、动作、安全处置 | JSON 有效不等于意图准确 |
| 规划 | 任务图、依赖、合同产物、批次 hash | 缺材料时应停在理解阶段 |
| 执行 | 参数、调用记录、回执、防重 | 大规模使用模拟媒体 |
| 状态 | 多轮快照、确认前无提交、Task ID、版本 | 不覆盖分布式竞态 |
| 产物 | 真实文字、模拟媒体登记、单独真实媒体 | 模拟媒体没有视觉成绩 |
| 恢复 | 提交拒绝、未知响应、轮询超时；单元重启与质量失败 | 不代表全部上游异常 |

意图、Skill 和验收使用同一豆包模型的不同调用，存在相关性偏差。自动通过不能代替人评。

## 范围与限制

通用视频编辑、音频、联网及独立媒体分析明确阻塞，扩展适配器保留但不进入新运行时。原专业资料内部读取，未删除用户资源。

对象存储、上传、永久 URL、数据库事务和跨进程协调未实现。本版是单机单服务进程。旧 ReAct 测试作为兼容对照，不能计作新协议独有覆盖。
