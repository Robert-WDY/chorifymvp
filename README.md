# Chorify MVP

Chorify MVP 是持续升级的同一个本地产品。当前使用已修复的单 Agent 处理会话记忆、工具选择、结果判断及回答，保留文字修订、素材和版本、媒体方案确认等能力。旧 compiled 代码与评测作为历史保留，日常不再选择两套运行版本。

## 统一启动与历史（2026-09-17）

当前唯一日常入口是本仓库的 Chorify MVP，地址 **http://127.0.0.1:3217**。在 Windows 双击 `start-mvp.cmd` 或运行 `npm start`。旧 `start-context-local.cmd`、`npm run start:context` 是同一服务的兼容入口；不会创建第二个实例。旧 `server/index.mjs` compiled 实现仅保留作历史代码与回归参考，不再作为日常启动选项。

模型继续使用已修复的上下文 Agent。配置统一为本仓库私有 `.env.local`，会话沿用 `data/isolated-local`（目录名保留，避免再次搬动现有数据），日志为 `data/local-service`。共享现有API账号额度，不在运行时读取其他项目目录。

页面的“历史对话”支持搜索、分页、切换原会话及导出完整记录。原MVP默认数据目录和manual-fixed-server已一次性导入，共59份旧会话；本仓库另有2份早期空会话也已导入，当前会话继续保留。旧原始Trace、任务、批准和回执存档于 `data/legacy-archive`，不进入Git。旧批准不会转成新执行授权；旧媒体链接保留但未逐一验证远端仍可用。

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/context-local.ps1 -Action Status` 查看；将Action改为Stop可停止。电脑重启后需手动启动，没有开机自启。首次在新机器使用时安装Node >=22.13并运行npm ci，再从 `scripts/context-local.env.example` 创建 `.env.local` 填写凭据；已有配置不覆盖。

当前真实文字开启，真实媒体与视觉关闭，媒体仍为模拟模式。历史合并不代表真实图片或旧未完成任务自动恢复执行。验收及回滚见[统一版本报告](evaluations/2026-09-17-unified-mvp/README.md)。

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

## 旧 compiled 阶段的修复记录（历史，非当前运行状态）

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

## 上下文 Agent 与长期工作规范

本分支另有独立的 [上下文 Agent 入口](server/context-agent/README.md)，使用 `npm run start:context` 启动。上文 `npm start` 和 compiled 说明仍对应旧入口。新版要求 Node >=22.13；当前简化与离线验收见 [2026-09-17 验收报告](evaluations/2026-09-17-context-agent-loop-alignment/README.md)。

[AGENTS.md](AGENTS.md) 是项目长期工作规范入口，补充且保留以上约定与历史报告。每轮修复必须填写四列“修复总结表”，追加到 [统一修复记录 FIXES.md](FIXES.md)，并在最终回复展示；不能只列修改文件或测试总数。

2026-09-17能力整合：新增“查看详细历史与执行过程”，可按需查看现有记录与旧存档详情；视觉适配支持独立供应商配置，但账户预检403后按用户选择保持关闭，继续模拟验收。详见[本轮证据与未验收范围](evaluations/2026-09-17-capability-integration/README.md)。

## Debug 中间过程

访问 http://127.0.0.1:3217/debug ，或点击聊天页顶部“Debug 中间过程”查看当前会话。支持轮次时间线、Agent/摘要/视觉调用统计、提示词分块、模型输出、系统执行规则、工具输入输出及来源回读。页面只读取现有Trace，不启动模型或工具；模型适配器输入与供应商HTTP报文有区别。验证范围见[Debug报告](evaluations/2026-09-17-debug-page/README.md)。

Debug现已按问题与处理链组织：先看错误和待核查信号，再看上下文、Agent决策、系统处理、工具、反馈和回复。点击问题可核对下一次实际输入是否包含失败反馈；来源用原话与资料名显示，内部标识收进原始证据。详见[重新设计与证据](evaluations/2026-09-17-debug-journey/README.md)。
