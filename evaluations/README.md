# 测试与证据

## 最新：2026-09-17 多轮真实模型

[完整复盘与逐轮结论](2026-09-17-multiturn-real/README.md)：8 个主会话、2 个诊断会话，48 个实际执行轮，88 次真实文本模型调用。媒体为模拟，未调用真实视觉。归档完整输入、响应、工具回执、持久状态和摘要；自然表达失败与显式工具提示对照分开，未把运行 completed 当业务成功。本轮未修改产品代码。可离线运行 `node evaluations/2026-09-17-multiturn-real/verify.mjs` 核对证据。

`2026-09-16-language-variants/` 保存 22 个独立空会话的真实模型测试：20 个主案例加 2 个媒体直接生成对照，共 51 次 deepseek-flash 调用。所有 query 为构造的自然语言变体，不是生产用户记录。没有真实媒体提交。

- [复测报告](2026-09-16-language-variants/不同说法与口吻复测报告.md)
- [主案例与固定 expected](2026-09-16-language-variants/cases.json)
- [补充对照](2026-09-16-language-variants/media-controls/cases.json)
- [机器检查汇总](2026-09-16-language-variants/evidence-summary.json)
- [人工内容审查](2026-09-16-language-variants/manual-review.json)
- [离线定位结果](2026-09-16-language-variants/offline-diagnosis.json)

每个案例目录包含 `state.json`（完整脱敏 trace 与合同）、`model-inputs.json`（每次模型实际输入/输出）、`result.json`、`checks.json`、`final.md`，有文字成果时另有 `artifact-N.md`。失败及修复轮次均保留。

自动检查 13/22 满足预期、9/22 未满足；这不是内容质量通过率。两个顺序调用案例虽然完整传递上游正文，仍将未知项写成事实。首轮 Schema 22/22 通过也不代表业务验收通过。

本次发布只对证据副本中的本机绝对路径做归一化，没有改 query、expected、模型回答和失败结论。原始 hash 仍用于说明当时版本；`source-baseline.json` 是本次导入代码的可重跑基线。主测试和对照都不允许覆盖归档目录。

## 离线复核（不调用模型）

在项目根先安装依赖，再运行：

```sh
node --test tests/future-source-binding.test.mjs
node evaluations/2026-09-16-language-variants/diagnose.mjs
```

`diagnose.mjs` 复现并断言已知错误的原因，不代表对应业务缺陷已修复。`analyze.mjs` 可重新计算归档检查，但会重写派生的检查文件；不要把它当作真实模型重跑。

## 真实模型重跑（需要额度）

确认本机 `.env` 中模型、凭据及预算后，在 PowerShell 中明确指定一个新的空输出目录：

```powershell
$env:CHORIFY_EVAL_OUT = Join-Path $PWD 'evaluation-runs/new-language-variants'
node evaluations/2026-09-16-language-variants/run.mjs --preflight
node evaluations/2026-09-16-language-variants/run.mjs
```

主运行上限 80 次模型调用、单案例 8 次，媒体提交被禁止。不要自动运行付费重测；不得把上一轮某张图片的批准当成新一轮批准。

仓库根的旧日期报告和 `evals/` 属于历史资料；部分历史脚本需要未随仓库发布的外部测试包。当前提交的离线可运行性以 `validation/2026-09-16-git-import/` 的实际结果为准。
