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

默认 `BUSINESS_ACTION_MODE=core`。当前 compiled 路径在 `RESULT_ACCEPTANCE=delivery_only` 下仍检查可计算的硬要求，并对有事实或派生文字资料的候选调用现有验证器做限定范围的业务事实核对；后者会增加模型用量。**这不等于全部内容质量或实际画面通过**。`strict` 沿用完整文字/媒体验收，不另加一次事实审查。具体检查及未验证项见[三阶段修复验收](evaluations/2026-09-16-contract-boundaries/README.md)。

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

## 修复进度与当前限制

1. 证据局部修复、缺来源等待、可批准媒体方案已补充合同边界及离线回归；错误语义仍可能需要模型纠正，引用有效不证明理解正确。
2. 下游正文的事实边界拒绝会阻止完成；真实模型的误报和漏报尚未复测。
3. 正文字数、镜头数/时长与媒体元数据参与完成判断；未取得必要证据时保留未核验，不伪称通过。英文词数、部分混合正文/镜头版式尚不支持确定性验收。
4. 模型将媒体要求整体误写为普通文字且不声明批准时，仍可能漏掉媒体义务；本轮改善了提示词表达，尚无新真实模型成功证据。
5. 独立文字节点仍逐项串行执行，本轮未改并行调度。

原 22 条真实复测保持历史原样。三个独立修复阶段分别通过 735、743、751 项离线回归，均无 skip；不是新的真实模型通过率。原始运行目录和线上服务未切换到本分支。

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
