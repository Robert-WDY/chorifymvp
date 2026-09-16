# 创作助手

独立运行的媒体创作 MVP。默认配置使用 DeepSeek V4.1 Flash 理解自然语言、规划、文字及图片验收，系统编译任务图、保存参数、执行和恢复。图片/视频生成仍连接火山方舟；视频内容验收保留豆包，因为当前 DeepSeek Responses 接口没有适配视频输入。

默认入口为 **Compiled Runtime**，执行阶段不向大模型开放可执行工具。系统调度三个业务工具：`find_material`、`generate_image`、`generate_video`。图片编辑通过 referenceImages 完成。

## 启动

需要 Node.js 22+。保留已有 .env，首次使用才从 .env.example 复制配置。

```powershell
npm install
npm start
```

打开 http://127.0.0.1:3210 。服务仅监听本机。

| 变量 | 用途 |
|---|---|
| DOUBAO_API_KEY | 方舟密钥，只在服务端读取 |
| DOUBAO_BASE_URL | 默认 https://ark.cn-beijing.volces.com |
| DOUBAO_CHAT_MODEL | 豆包理解、规划和验收模型 |
| DOUBAO_IMAGE_MODEL | 图片生成模型或推理接入点 |
| DOUBAO_VIDEO_MODEL | 视频生成模型或推理接入点 |
| PORT | 默认 3210 |

主模型通过 `LLM_PROVIDER=deepseek` 或 `doubao` 切换。DeepSeek 配置为 `DEEPSEEK_BASE_URL=https://api.deepseek.com`、`DEEPSEEK_MODEL=deepseek-flash` 和 `DEEPSEEK_API_KEY`。本轮默认 `DEEPSEEK_REASONING_EFFORT=none`，与旧模型关闭思考的设置对比；可配置 low/high/max，但本轮评测未测这些模式。不要把 DeepSeek 的密钥或地址填进 DOUBAO 媒体配置。

`npm run eval:intent`、`npm run eval:production`、`npm run eval:production500` 及 `evals/compiled-eval.mjs` 使用相同主模型配置。旧 ReAct 和历史专用复测脚本仍保留豆包入口，不能将其输出误认为 DeepSeek 结果。

媒体生成使用账户额度。新协议必须通过验证才能完成，AGENT_VERIFY 应保持默认开启。

## 当前范围

- 两个强制媒体 Skill：image_creation_skill 和 video_creation_skill，有输入输出合同、工具权限、流程和校验。
- 图片生成、参考图编辑、文字生成视频、首帧图生成视频、批量生成。
- 文字回答、提示词改写、营销文案、分镜及给定文字风险审核，由受约束的文字节点处理。
- 缺素材澄清、具体方案确认、多轮补充、已有产物修订、验收失败后的有限修复。
- 通用视频编辑、音频、实时联网和独立媒体分析不在本版执行范围，保存目标并明确阻塞。

原有 15 份专业资料和扩展适配器保留，用于内部方法资料及历史回归，不作为本版模型可自由调用的能力。Python 脚本不属于默认链路；历史脚本测试需要 Python。

## 执行协议

```text
Query → 豆包语义目标 → 能力选择 → Goal Compiler
  → 持久任务图 → 强制 Skill → Schema / 前置条件 / 方案验收
  → 保存参数 → 按用户要求等待确认
  → 系统提交与查询 → Artifact → 内容验收
  → 完成 / 等待 / 缺信息 / 修复 / 阻塞
```

系统对模型选出的结构化能力做合同映射，不按 Query 关键词匹配。Skill 必须产生符合合同的方案，不能以“已加载”代替执行。模型不能设置完成状态。

媒体提交前记录执行，收到回执后再检查产物。同一批次续跑复用参数和回执；提交结果未知时禁止自动重提。参数与 Skill 证据、执行图及确认 hash 绑定。

COMPLETED 要求类型、数量和内容验证通过。无法观察的媒体保持未验证，继续操作只重试验证；明确验收失败才允许有限媒体修复，保留父版本及失败原因。模拟媒体使用 SIMULATED 状态，不作为真实完成。

任务状态、执行、用户确认和 Artifact 保存在 data/<sessionId>.json，使用单进程原子写入。尚未采用数据库或分布式锁，媒体仍使用上游 URL，未接永久对象存储。

## 验证与评测

```powershell
npm test
npm run check
# 24 个状态与业务场景 + 4 个变体；真实豆包，模拟媒体。
npm run eval:production -- my-production-run 4
# 原始完整 500 条，不去重；真实豆包，模拟媒体。
npm run eval:production500 -- my-full-run 16
# 40 个场景族，每族 25 个产品变体；真实豆包，模拟媒体，32 路并发。
node --env-file-if-exists=.env evals/compiled-eval.mjs my-run 25 32
# 实际生成 1 张图和 1 条视频，会使用媒体额度。
node --env-file-if-exists=.env evals/task-loop-regression.mjs my-real-run --real-media
```

每次使用新目录，保存 Query、期望、模型输入输出、执行记录、快照和 Artifact。期望标签不进入模型。历史 200 条评测继续保留，不能与六层闭环成绩直接比较。

生产场景测试包含确认、草稿修复、版本编辑、超时注入及进程重启。当前单批可执行最多 20 件媒体；更大的原始目标会保留并明确阻断。多条文案可放在一份正文中，正文验收覆盖数量后以 `unitCount` 记录，避免把文案条数误当成文件数。测试入口及数据修订见 [场景评测说明](evals/production24/README.md)。

架构详情见 [编译执行协议](COMPILED-RUNTIME-20260910.md)。旧 ReAct 回归使用 server/agent-loop.mjs；默认应用和新评测使用 server/agent.mjs。

## 文件与接口

| 文件 | 职责 |
|---|---|
| server/goal-compiler.mjs | 任务图、强制 Skill、方案编译及完整性校验 |
| server/compiled-runtime.mjs | 系统调度、恢复及节点执行 |
| server/media-skill-contracts.mjs | 两个媒体 Skill 合同及三个业务工具 |
| server/task-state.mjs | 唯一状态、转换日志、版本与完成条件 |
| server/execution-engine.mjs | 前置条件、批次、持久提交及查询 |
| server/session-store.mjs | 原子写入、重启保护 |
| server/verification.mjs | 计划、文字及实际图片/视频验收 |
| dist/ | 无需构建的浏览器界面 |

GET /api/config 返回脱敏配置；POST /api/chat 接受 {message,sessionId?} 并流式返回事件；GET /api/session/:id 恢复任务；POST /api/task/continue 接受 {sessionId,taskId,planHash?}；POST /api/cancel 停止后续步骤。POST 需要 X-MVP-Token。

## 2026-09-11 审查修复

文字与媒体规划通过 `server/sources.mjs` 解析会话内的源素材；文字改稿和审核接收源正文及完整 spec，exactTexts 由程序检查。图片编辑审核发送原图和结果图，要求结构化对照证据；看不清、源图缺失或格式不完整时保持未验证。明确图片尺寸和比例另做元数据检查。

默认编译运行时将未知提交限制在原任务的媒体提交，独立文字及新的独立任务可以继续；原提交仍禁止自动重发。后台可恢复已经收到成品、尚未完成验收的任务，保留重试预算并尊重暂停状态。任务快照返回 `actions`，前后端共用继续/确认信息。

修复内容、离线验证和剩余边界见 [修复说明](FIXES-20260911.md)。本次没有重新运行付费模型/媒体评测，历史 E2E 和审查文件保留其当时结论。
