# 3217实际服务评测（2026-09-17）

受测地址http://127.0.0.1:3217，开始时工作树8cf9a77，服务PID41680。真实deepseek-flash，图片模拟、视觉关闭。

- 42组计划：34组81轮实际完成，8组真实视觉场景未运行。
- 201次模型调用（主Agent186、摘要15），完整运行时请求/响应配对。
- Codex逐案例语义审阅：3组满足核心要求、16组核心完成但有缺陷、15组未满足。HTTP200不是业务通过。
- 3次图片模拟提交，真实图片及视频均0次。两组预定故障注入通过HTTP无法实施，恢复条件未覆盖。
- 主要问题：事实推断变成卖点、额外交付、原稿正文/修改范围、工具参数错误及能力说明矛盾。产品行为未在本轮修复。

完整报告和trace为本地工件（未将重复的大量完整输入上传Git）：

- [评测报告](../../evaluation-runs/http-3217-20260917/评测报告.md)
- [完整trace ZIP](../../evaluation-runs/http-3217-20260917-full-trace.zip)
- 本目录保留脱离原始大文件也可阅读的semantic-review.json和trace-audit.json；review中的recordId指向完整包里各例session.json。

复现：先运行`node evals/context-agent-http-acceptance.mjs`预检，再显式加`--run --out=evaluation-runs/一个新目录`执行，之后用`node evals/context-agent-http-audit.mjs 输出目录`检查证据。始终针对实际HTTP服务，不启动替代Agent；只读取本次新会话的存储以导出全trace。实际正文与证据判读由Codex完成，audit只做完整性检查。

本轮适配验证：真实HTTP运行81轮全部完成；node语法及独立性检查416文件通过；ZIP逐文件SHA256和压缩完整性验证通过。未重启、重配或部署服务。
