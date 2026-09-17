# 单 Agent 核心循环对齐验收（2026-09-17）

当前目录：`C:/Users/asus/Desktop/codex-workspace/chorifymvp-git`，分支 `feat/context-agent-20260916`。HEAD 为 `a82bf5f27b0ce780089b42954541fd241f7a0b5e`，当前修改尚未提交、推送或部署。

用户本轮说明明确以 a82bf5f 为评审对象。先前已完成的本地简化仍保留，本轮没有重新实现这些修改。

| 说明中的差距 | 当前本地处理 | 本轮动作 |
| --- | --- | --- |
| 默认注入全部资产和批准参数 | 有预算的近期目录，list_assets / read_approval 按需读取 | 核对并回归 |
| Skill 残留旧节点和渲染协议 | 直接读取独立 methods/v1 正文和参考资料 | 核对并回归 |
| 观察工具自动补父图、来源链、同次资料 | 只观察 Agent 明确选择的图片和 materials；compare_images 显式双图 | 核对并回归 |
| 聊天稿需先存档再另存修订 | parentMessageId + content 一次原子保存 | 核对并回归 |
| 批准后模型重抄参数 | execute_approved 按两个 ID 恢复并核验已批准参数 | 核对并回归 |
| 所有创作都必须先保存 | 简单聊天可直接回复；独立文稿、版本管理、已有资产修订才保存 | 本轮补充 |

## 本轮变更及职责

`prompt.md` 替换原有保存规则，`tools.mjs` 同步 save_document 工具说明，没有更改 Schema 或执行逻辑。新增 `context-agent-chat-boundary.test.mjs` 两项离线集成测试。

- 简单聊天创作或改稿：原稿完整存在当前上下文时直接使用，允许直接交付，实际对话由系统持久化。未来可能继续修改本身不构成必须创建文稿资产的理由。
- 需要独立文稿或版本管理：调用 save_document；聊天稿用 parentMessageId，一次保存原稿和修订。已有文稿资产修改仍用 parentId，不以聊天回复冒充已保存版本。
- 原稿缺失或不完整：按需检索、读取，不凭摘要重建。Skill 与历史读取不成为所有请求的前置步骤。

同一个 Agent 继续负责理解、计划、选择工具、判断真实结果及回答。工具负责准确执行、保存与权限保护。主循环 `loop.mjs` 和 `io-guard.mjs` 与 HEAD 一致。媒体仍须先准备具体方案、用户批准后提交；本轮无真实模型或媒体调用。

代价：聊天稿不会自动获得独立资产 ID 和 parentId。聊天承接依赖真实消息历史，需要资产版本时再明确保存。程序没有新增语义分类器来强制这项选择；真实模型是否稳定选择正确路径仍需另行授权测试。

## 模型视图前后对照

`model-input-before-after.json` 使用同一份合成原始对话，通过实际 buildContext 和当前工具注册表构造。before 为本轮修改前的本地状态，after 为本轮修改后，均非真实供应商请求。

旧条款：交付可继续修改的文案、方向、脚本、提示词时先 save_document。

新条款：简单聊天直接交付；需要独立文稿、版本管理或已有资产修订时保存。工具说明同步，没有同时保留冲突的旧要求。

原稿、用户修改要求、历史消息均保留。估算输入为 4976 → 5088 tokens；这是职责说明的调整，不宣称提示词长度下降。减少的是允许模型省去机械保存步骤的路径；真实调用轮数变化未测。

## 离线验收

实际环境 Node 24.19.0；运行要求仍为 Node >=22.13。

```powershell
node --test --test-reporter=tap tests/context-agent-chat-boundary.test.mjs
node --test --test-reporter=tap tests/context-agent-*.test.mjs
node --test --test-reporter=tap tests/*.test.mjs
node scripts/check.mjs
git diff --check
```

| 验收 | 实际结果 |
| --- | --- |
| 新增聊天/版本边界集成 | 2/2 |
| Context Agent 全路径 | 106/106，0 fail，0 skipped |
| 全仓离线回归 | 857/857，0 fail，0 skipped |
| 独立性与语法检查 | 380 个文件通过 |
| diff 空白检查 | 通过 |
| 本轮增量补丁 reverse check | 通过 |

日志见本目录 `context-tests.log`、`full-tests.log`、`syntax-check.log`。

新增测试用脚本化 Agent 决策驱动真实主循环、上下文、Schema 校验、工具和 SQLite：

1. 聊天创作后重新加载会话，完整原稿进入下一次实际模型输入；直接回复只需一次决策、零工具调用，原文与修改稿继续持久化，没有自动创建资产。
2. 聊天原稿升级为文稿修订只用一次工具调用；再次加载后修改已有资产也只用一次保存，真实父子关系为 v1 → v2 → v3，原稿和旧版本完整保留。

这些结果证明程序路径可用，不证明真实模型会正确理解所有用户说法或保持全部卖点。未运行新真实模型 A/B、真实图像观察或媒体生成；不将历史 23 条 Trace 的结果计作本轮复测。现有业务 expected、用例和媒体门禁未放宽。

## Diff 与回滚

`alignment.patch` 只含本轮三个文件的增量。前一批本地改动及测试证据保留在 `../2026-09-16-context-agent-simplification/`；其 implementation.patch 为前一阶段快照。校验其 manifest 后，只有本轮修改的 prompt.md 和 tools.mjs 哈希变化，其余原有文件匹配。

重建当前代码：在独立 checkout 的 a82bf5f 上先应用前一阶段 implementation.patch，再应用本轮 alignment.patch。不要覆盖当前未提交工作区。

仅回退本轮：先用 `git apply --reverse --check evaluations/2026-09-17-context-agent-loop-alignment/alignment.patch` 检查，再反向应用本轮补丁。保留前一阶段的 SQLite、观察、Skill、批准执行等修改。

若要完整回到 a82bf5f，使用独立 checkout；涉及已经运行的新 SQLite 会话时，必须先停止服务并按前一阶段 README 导出最新会话，保留完整 Trace、资产和批准。不能直接用过时 JSON 替换最新数据。本轮没有迁移或改写真实会话。
