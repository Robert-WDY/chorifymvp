# Chorify MVP

独立运行的创作助手，包含请求理解、需求合同、来源与版本绑定、Skill、文字生成、媒体方案确认、执行与 trace。此仓库导入的是实际 compiled Chorify MVP，包含截至 2026-09-16 的依赖选择修复；不是占位骨架。

当前业务入口为 `server/index.mjs` → `Agent` → compiled runtime。模型解释用户需求、生成文字或媒体计划，程序负责依赖、对象版本、状态、审批和提交。已有 ReAct 代码及旧日期报告作为历史资料保留。

## 快速启动

需要 Node.js 22+（建议当前 LTS）及 npm。历史 Python Skill 测试还需要 Python 3，可通过 `PYTHON_BIN` 指定解释器；默认执行链不依赖打包的 Python 运行时。

```sh
npm ci
cp .env.example .env
# 编辑 .env，配置自己的模型与媒体凭据
npm start
```

Windows PowerShell 首次创建配置使用 `Copy-Item .env.example .env`。已有 `.env` 时不要覆盖。

默认界面：`http://127.0.0.1:3210`。主模型示例为 `deepseek-flash`；媒体使用火山方舟。图片、视频需先保存方案，经用户批准后才能提交。真实模型和媒体调用会消耗账户额度。

默认 `BUSINESS_ACTION_MODE=core`；`.env.example` 的 `RESULT_ACCEPTANCE=delivery_only` 只验证交付存在，**不等于事实和内容质量全部通过**。`strict` 是另一个验收策略；不能用切换策略代替修复已知合同问题。

## 离线测试

```sh
npm test
npm run check
node --test tests/future-source-binding.test.mjs
```

离线回归使用本地替身，不调用真实模型或媒体。发布验证记录见 [validation/2026-09-16-git-import](validation/2026-09-16-git-import/README.md)。3 个原本依赖本地 `data/` 的历史回归已改为读取提交的最小 fixture，模型原始输出与断言不变。

## 已提交的真实测试与 trace

- [测试入口与复现说明](evaluations/README.md)
- [22 条不同说法与口吻的完整报告](evaluations/2026-09-16-language-variants/不同说法与口吻复测报告.md)
- [机器检查汇总](evaluations/2026-09-16-language-variants/evidence-summary.json)
- [人工内容审查](evaluations/2026-09-16-language-variants/manual-review.json)

这组测试包含 22 个独立空会话、51 次真实语言模型调用，使用构造的自然语言变体；没有提交图片或视频生成。每个案例保存完整脱敏 state/trace、实际模型输入输出、合同、来源绑定、时间及产物。失败和修复轮次原样保留。13/22 满足自动化通路与硬约束断言，不是内容质量通过率。

真实模型重跑需另外配置凭据及新输出目录，详见测试说明。没有把任何账号密钥、`.env`、生产用户会话、旧媒体文件、依赖目录或完整历史运行数据上传。

## 当前已知问题

1. 原话证据可能跨段拼接，局部修复仍可能重复错误值。
2. 顺序调用完整传入上游正文后，下游仍可能把待确认内容写成事实。
3. `delivery_only` 不检查正文最低字数等内容要求。
4. “先准备方案、批准后生成”有时只产出普通文字，未保留可批准的媒体计划。
5. 缺失旧来源的等待项可能先被依赖校验归为 `BLOCKED`。
6. 独立文字节点当前仍逐项串行执行。

这些是真实复测发现，尚未在本次 Git 导入中修复。发布工作只整理仓库、脱敏证据和修复测试材料路径，不改变产品执行逻辑。

## 目录

| 路径 | 内容 |
|---|---|
| `server/` | 编译式执行链、合同、模型适配、来源、验收与媒体门禁 |
| `dist/` | 本地界面与调试界面静态资源 |
| `skills/` | Skill 正文、合同、参考资料与受控脚本 |
| `tests/` | 离线回归及最小历史模型输出 fixture |
| `evals/`、`scripts/` | 评测及辅助脚本；部分旧脚本需要独立外部数据包 |
| `evaluations/` | 本次公开的构造案例、实际模型结果与脱敏 trace |
| `validation/` | Git 导入后的实际离线验证结果 |

[IMPORT-MANIFEST.json](IMPORT-MANIFEST.json) 记录导入指纹和发布调整；[原始 README](README-HISTORICAL-20260916.md) 与旧日期报告是历史记录，不代表当前端到端验收结论。Skill 完整性及部分 trace 依赖字节哈希，仓库关闭自动换行转换。
