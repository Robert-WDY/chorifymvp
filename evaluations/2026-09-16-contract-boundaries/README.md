# Chorify 三阶段合同边界修复与验收

实际项目：`chorifymvp-git`，来自原始 compiled Chorify MVP；基线 `1fdaf6a09508e6dd056d5a63cdd1a729a4a7602a`。分支 `fix/contract-boundaries-20260916`。没有修改原运行目录或部署线上服务。

## 阶段结果

| 阶段 | 独立代码提交 | 离线回归 | 检查 | 证据 |
|---|---|---:|---:|---|
| 1 合同、证据、方案与等待 | `f93d1bd` | 735/735 | 316 文件 | [说明](stage1.md)、[日志](stage1-tests.log)、[diff](diffs/stage1.diff) |
| 2 硬要求验收 | `987b85e` | 743/743 | 318 文件 | [说明](stage2.md)、[日志](stage2-tests.log)、[diff](diffs/stage2.diff) |
| 3 事实身份与实际正文 | `eacfedd` | 751/751 | 320 文件 | [说明](stage3.md)、[日志](stage3-tests.log)、[diff](diffs/stage3.diff) |

所有阶段 skipped=0。阶段三含 7 个事实边界测试及 1 个最终渲染守卫测试；此前已通过的测试继续运行。原始 22 条真实模型 Trace、query、expected 和失败结果未覆盖。

**证据分层：**当前 Schema 校验与离线模拟执行通过；历史真实输出已用于离线反例。新真实模型调用 0，实际图片/视频提交 0，未执行 CLEAR。不能将以上数字称为真实理解或内容质量通过率。

## 模块职责及实际输入输出

| 模块 | 看见什么 / 输入 | 可以写什么 / 输出 | 负责的边界 |
|---|---|---|---|
| intent + request-input | 本轮原话、有效来源目录、当前 wire Schema、错误字段及精确候选 | 未接受的操作候选；仅指定字段的证据补丁 | 原话确实可定位，不能用历史原话授权新操作；不宣布执行完成 |
| stage-contract + planning-boundary | 已表达的交付、局部缺口、依赖、方法与规格 | 现有 activation 与合法合同；拒绝结构冲突 | 区分等待用户、等待已规划前置；不能让等待掩盖无效依赖 |
| goal-compiler / 已有审批 | 合同、真实来源/版本和已有参数 | 持久媒体方案与 planHash | 等待批准后只执行该方案；本轮未重建批准系统 |
| text-stage / Skill | 当前节点、精确选定内容、必要事实身份、原稿与反馈 | 当前候选正文/结构、来源与方法回执 | 不重选方向或镜头、不重写其他成果；候选不是已交付 |
| hard-requirements / compiled-runtime | 实际渲染正文、保存的规格、实际供应商元数据 | 程序计数/比较、带输出 hash 的验收记录 | failed 与 not_evaluated 区分，两者都不能冒充满足硬要求 |
| fact-boundary / model-context / sources | 用户事实、假设、未知项及直接来源正文/版本 | 只读身份投影；持久元数据及模型视图内去重指针 | 身份随内容传递；用户提供不升级为独立核实；指针对应正文仍在请求中 |
| Verifier | 下游实际正文、原资料、事实边界；strict 还含完整内容要求 | 限定范围的 passed/failed/uncertain 回执 | ID正确或全文已传入不等于事实正确；免责声明不能抵消承诺 |
| task-contract / final-response | 实际产物、版本、验收 hash 与账本 | 完成状态读模型、实际成果的回答投影 | 工具成功不冒充完成；缺原稿时不声称已有成果 |

## 旧 Prompt 与新条款对照

| 原规则/行为 | 现在的规则与配套实现 |
|---|---|
| 原话引用提示较泛；失败重复返回拼接引文 | 明确连续引用与独立 spans；提供可定位候选，补丁不能改变正确的选择和操作 |
| 提示“先方案确认后生成”，但 text + approval 会被静默转换 | prompt-only 与可执行 image/video 方案分开；文字审阅显式 scope；不新增多余 Brief/脚本；媒体审批义务不被默默抹除 |
| 缺来源虽有 after_user_input，后续前置检查仍认作漏生产 | 先查结构/方法/规格/依赖，再尊重等待；没有声明等待的漏生产依然是错误 |
| 字数放在生成要求里；存在正文即可完成 | 当前 Schema 保存 bodyLength；body 与标题分别渲染，程序计数并阻止不满足要求的候选完成 |
| 生成提示要求“别编造”，delivery_only 没检查实际内容 | 事实身份进入生成和持久来源；已有验证器检查下游实际业务承诺，失败局部重试；不进行每轮总语义审查 |

[A：Prompt 与 Skill 文字 diff](diffs/A-prompts-and-skills.diff)；[B：上下文、合同和验收 diff](diffs/B-runtime-and-validation.diff)；[C：离线测试 diff](diffs/C-offline-tests.diff)。A/B 是最终实现的职责视图，包含互相依赖的新字段，不应单独上线；需要逐阶段回滚/验收时使用上表三个独立提交。

## 实际模型请求投影对照

完整对照：[input-projection-comparison.json](input-projection-comparison.json)。Before 来自历史真实请求，After 来自当前运行代码发给离线模型替身的实际请求，不是文字设计稿，也不是新真实模型 A/B。

| 环节 | Before | After |
|---|---|---|
| 第一次理解 | 合法 JSON 仍可能拼接不存在的引文 | 原请求仍完整；规则区分原话与解释，不增加总审查 |
| 理解失败后的局部修复 | 只有错误和锁定草稿，可重复错误值 | 相同锁定草稿 + 出错字段 + 精确候选及位置；只修 evidence，不改选择依赖 |
| 文字生成与修复 | 自由正文含短文和标题；验收只看存在 | typed bodyLength + body/title 结构；60 字候选失败，90 字候选通过；失败 hash 与修复版本各自保存 |
| Brief → 文案 | 原 Brief 完整传入，仍将预约未知改成承诺 | 直接来源/版本 + 身份投影；同一请求去掉重复身份正文，原资料保留；事实检查看到实际文案并可拒绝 |

可重放材料：[证据修复 Trace](stage1-evidence-trace.json)、[硬要求 Trace](stage2-completion-trace.json)、[事实链路 Trace](stage3-facts-trace.json)。所有新 Trace 明确标记 `offline_fixture_not_real_model`；模拟裁决不是独立内容质量证明。

## 实际运行命令

在仓库根目录，以当前 Windows Node 运行时执行：

```powershell
$node = 'C:/Users/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$env:PYTHON_BIN = 'C:/Users/asus/Desktop/洞墟科技/洞墟科技/项目/mvp/AGENT-MVP-COMPLETE-20260911/project/Python/pythoncore-3.14-64/python.exe'
& $node --test 'tests/*.test.mjs'
& $node scripts/check.mjs
& $node evaluations/2026-09-16-contract-boundaries/export-offline-traces.mjs
```

普通环境可使用 `node` 和本机 Python。日志按阶段保留；实际业务 expected 未更改。少量旧流程测试的模拟媒体回执补上其模拟尺寸/时长，摘要式脚本补上实际镜头；原始缺证据输出继续作为负例测试。部分纯来源/HTTP测试显式补上模拟事实验收响应，不宣称这些 mock 证明事实判断能力。

## 副作用、未验证项与未扩大的工作

- 边界收紧后，一些原来“有文件就完成”的任务会保留为未完成，要求补证据或修复；这是避免假完成的可见变化。
- 有事实或派生资料的 delivery_only 文字候选增加限定范围的事实检查，存在延迟、成本和误拒绝风险；strict 复用已有检查。本轮没有真实额度消耗。
- 正文字数默认排除标点、空格和 Markdown；标题不参与。英文词数没有专用合同。正文/标题专用结构与镜头混合版式目前未实现完整渲染验收，不能把隐藏元数据算作已交付。
- 历史 case 17 的完整媒体意图误译为普通文字且 approval=false，仍需真实模型复测：提示词已改，但结构校验无法独立证明语义理解正确。case 15/16 不再静默清除 approval；修正后的媒体合同离线可保存并停在门禁。
- 真实模型对字数、事实边界和媒体意图的稳定性，真实视觉质量，以及实际成本尚未验证。原 22 条历史通过率不变。
- 并行调度、批准粒度、后台恢复、方向/镜头选择系统未重建。原运行目录未激活本分支；这不是线上发布。

## 回滚

工作区保持干净后按后进先出回滚代码提交：

```sh
git revert eacfedd
git revert 987b85e
git revert f93d1bd
```

可只回滚第三阶段以保留前两阶段。提交内的新测试和记录跟随提交；本地持久原文、历史 Trace、授权和版本没有被迁移或删除。部署前应在副本上按相同 Node/Python 运行回归，并另行核对真实模型授权和预算。
