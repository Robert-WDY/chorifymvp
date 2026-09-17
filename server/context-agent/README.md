# Chorify 上下文 Agent

这是独立的新入口。旧 `server/index.mjs`、compiled 执行器、旧会话和回归保持原样。新入口默认不调用真实模型，媒体默认 simulation。

## 启动

在仓库根目录执行 `npm run start:context`，浏览器打开 `http://127.0.0.1:3212`。旧版仍通过 `npm start` 启动，默认端口 3210。两者不互相回退。

当前要求 Node >=22.13。新记录默认保存在 `data/context-agent/<owner-hash>/<session-id>.sqlite`，该目录被 Git 忽略。已有 JSON 在首次读取时迁移并保留原文件；完整 Trace 独立存储、按需读取，可导出完整会话。可以用 `CONTEXT_AGENT_DATA_DIR` 指定其他独立目录。当前 HTTP 是仅绑定本机的单用户开发入口，不是多租户公开部署服务；底层存取接口检查服务端 owner 身份。

真实模型需先取得授权、核对既有 `.env` 中的模型与额度，再显式设置：

```powershell
$env:CONTEXT_AGENT_ALLOW_MODEL = '1'
$env:CONTEXT_AGENT_MAX_MODEL_CALLS = '16'
npm run start:context
```

这只是启用说明，本轮没有执行这些授权设置。原模型 API 配置由 `createBrain` 读取，不另存一份凭据。`CONTEXT_AGENT_MAX_MODEL_CALLS` 是每轮请求上限，主循环及视觉观察共同计数；它不是货币费用估算。重复真实评测另有跨用例共享总预算。

只有确认当前模型支持真实图像输入后，才可设置 `CONTEXT_AGENT_VISION_ENABLED=1`。这会注册实际图片观察通道；默认未注册时模型只能读取图片身份，不能声称看过图片。

真实媒体还需要显式 `CONTEXT_AGENT_ALLOW_MEDIA=1` 和正整数 `CONTEXT_AGENT_MAX_MEDIA_CALLS`；供应商配置存在时才注册对应能力。即使开启真实媒体，仍须在页面批准已展示的具体参数。首版没有自动后台推进；已有视频通过 `read_media_result` 查询。没有结果或无查询能力时保持未知，不自动重提。

## 模块职责

| 文件 | 输入与输出 | 负责范围 |
| --- | --- | --- |
| `loop.mjs` | 用户原话、会话记录 → 原生模型消息和调用 → 真实工具结果 | 循环协议、运行上限、取消、请求重放和完整 Trace；不解释需求或编译业务图 |
| `context.mjs` | 原始记录、资产目录、真实工具批准 → 当前模型视图 | 按估算 token 预算保留完整消息/工具组、附件标识和必要回读指针；不改持久原文 |
| `history.mjs` | 服务端 owner、会话 ID、原始记录 → 文件持久化/检索 | 原子写、角色顺序、原文检索分页、历史不可覆盖和会话隔离 |
| `tools.mjs` | 单次工具参数 → 文件、测量、观察或媒体回执 | 真实动作和可操作错误，校验实际素材类型；不安排业务步骤 |
| `io-guard.mjs` | 当前身份、精确方案和批准、调用身份 → 可执行范围 | 参数授权、额度、重复提交和提交未知保护 |
| `providers.mjs` | 已获准实际参数或真实图片输入 → 供应商结果 | 复用直接 ArkMedia 与图像模型接入，不创建旧任务对象 |
| `prompt.md` | 用户要求和工具反馈 | 一个主 Agent 的行为边界；没有旧需求合同/节点编排指令 |
| `http.mjs`、`index.mjs`、`web/` | 新建对话、文字资料/图片 URL、具体批准、取消 | 独立聊天入口，展示真实文件及来源；不启动旧引擎 |

会话只保存 `records`、`assets`、`invocations`、`approvals`：实际消息/调用记录、不可变产物、提交回执与工具批准。`completed/error/cancelled/budget_exceeded` 仅表示一次模型运行怎样结束，不表示用户所有业务要求已经满足。

## 工具与历史

基础工具包括 `search_history`、`read_history`、`list_assets`、`read_asset`、`read_skill`、`save_document`、`measure_text`、`read_approval`、`execute_approved`。媒体按配置提供 `generate_image`、`edit_image`、`generate_video`、`read_media_result`，观察按能力提供 `analyze_image` 和显式双图 `compare_images`。服务与评测共用工具装配。

简单聊天创作、改稿可直接回复并保留原始对话，不强制存稿或重读当前完整原文。需要独立文稿、版本管理或修改已有资产时保存；聊天稿以 `parentMessageId` 和新正文一次保存原稿及修订。Skill 直接读取 `methods/v1` 专业正文，不使用旧节点执行协议。详见 [统一修复记录](../../FIXES.md)。

编辑关系来自真实 `edit_image.imageId` / `save_document.parentId`，新文件记录父 ID 和版本；派生文件使用 `sourceIds`。图片生成的 `referenceImages` 是本会话图片 ID，创意文档可另用 `sourceIds`。原稿、未知项和原图不会因为上游文字存在而被自动替代。

模型同时提出的独立调用在当前循环中有界顺序执行，全部结果回到同一次后续模型输入；不构建依赖图。后续依赖必须在收到结果后的模型轮次提出。未使用的工具批处理接口已移除；主循环没有启用并行付费提交。

媒体首次调用保存提案，返回 `proposalId`。页面可一次选择批准多项，服务器保存参数摘要和 `approvalId`。批准后使用 `execute_approved` 传两个 ID，由工具恢复并核验已保存参数；无需模型重抄。原参数式提交仍保持兼容并核对精确参数。聊天中“已经批准”、Skill 或摘要均无法创建授权。相同方案换调用 ID 不再提交；用户明确再生成时可以准备一个新方案。

`analyze_image` 只观察明确指定的图片和资料，不自动扩展父图或同次附件。材料若含 `sourceId`，工具读取实际文字原文、版本和来源；可显式选择片段，超出观察预算会在外部调用前拒绝。模型写的内容及 `verified` 等标签仅保存在 `agentAnnotation`，不能覆盖原文。保持验收需用 `compare_images` 明确选择原图和成品。观察结果仍需主 Agent 判断，不能声称消除了模型事实错误。

近期历史按完整工具组裁剪；长工具结果可在投影中明确截取，原文仍可分页读取。用户原话、助手正文和工具参数不被切断。已裁掉的 Skill 有原文回读指针。没有每轮摘要模型、笔记解析器或跨会话语义检索。

## 验证与回滚

`npm run test:context` 运行独立离线测试。`npm run eval:context` 核对固定语料并报告真实语义测试未运行，不调用模型。

初版结果见 `evaluations/2026-09-16-context-agent/README.md`，当前结果及 SQLite 完整导出、回滚要求见 [最新验收](../../evaluations/2026-09-17-context-agent-loop-alignment/README.md)。停止此入口后可使用旧 compiled 入口；新会话不得直接交给旧引擎运行，旧节点状态也不自动导入新路径。若回退到旧 JSON 版 context-agent，需要先导出最新会话，不能只使用过时的迁移备份。

当前文件存储和进程内锁只保证单个本地服务进程的调用保护。没有分布式提交保证；供应商不支持幂等或缺少查询回执时，只能保留结果未知并阻止自动重提。
