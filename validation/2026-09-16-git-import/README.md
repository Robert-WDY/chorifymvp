# Git 导入验证 · 2026-09-16

验证对象为独立 Git 工作副本，不是原运行目录。没有复制 `.env`，没有调用真实模型或媒体，没有重启服务。

| 检查 | 结果 | 证据 |
|---|---|---|
| 首次全量回归 | 723/726，3 项因忽略的本地 data fixture 缺失失败 | `full-tests.log` |
| 将 3 份必要原始模型输出提取到 tests/fixtures 后重跑 | 726/726，0 failed、0 skipped | `full-tests-final.log` |
| 独立性与语法检查 | 见 `check-final.log` | 当前仓库 server/dist/skills/scripts/tests/evals |
| 归档错误离线定位 | 正常退出，复现原有问题；不表示业务已修复 | `diagnosis-replay.log` |
| 导出的真实测试器预检查 | baselineDrift=[]，没有配置密钥，没有发出模型请求 | `real-runner-preflight.log` |
| 导入完整性 | server/dist/skills 字节一致；22 条 trace 实际 input/output 与原记录一致；query/expected 字节一致 | `import-integrity.json` |

测试实际命令：

```sh
node --test 'tests/*.test.mjs'
node scripts/check.mjs
node evaluations/2026-09-16-language-variants/diagnose.mjs
# CHORIFY_EVAL_OUT 指向新的临时输出目录，仅执行预检查：
node evaluations/2026-09-16-language-variants/run.mjs --preflight
```

本机使用 Node 运行时及 Python 3.14，PYTHON_BIN 指向本机解释器。依赖通过 bundled pnpm 安装（`install --ignore-scripts --lockfile=false --registry=https://registry.npmjs.org`），保留原 npm package-lock；本轮没有将 `npm ci` 冒充为已运行命令。安装目录不提交。

变更仅包括测试 fixture 路径、发布文档、Git 忽略规则及便携的证据复测脚本。原测试断言和业务 expected 未更改，没有 skip，也没有删除失败案例。第一次失败日志一并保留。

离线全绿与真实模型结果分别报告：历史真实复测的 22 条仍保留 9 条未满足自动化预期的案例及额外内容风险，详见 `evaluations/`。
