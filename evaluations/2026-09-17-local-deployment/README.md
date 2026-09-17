# 2026-09-17 本机独立部署

产品基线：`2b99fa84b10ee978f5be0cf483aca7ab0f84ba70`，分支 `feat/context-agent-20260916`。本轮只增加部署启动器、配置模板、说明与验证材料，未更改 Agent 核心及工具业务逻辑。用户授权本机部署并继续使用现有 API 账号。

## 实际部署

- 代码目录：`C:/Users/asus/Desktop/codex-workspace/chorifymvp-git`。
- 启动链：本仓库 `start-context-local.cmd` → `scripts/context-local.ps1` → `scripts/context-local.mjs` → `server/context-agent/index.mjs`。
- 仅监听 `127.0.0.1:3217`，前端同源请求；端口不同，浏览器 localStorage 与其他实例分开。
- 配置：本仓库 `.env.local`，供应商字段经用户同意一次性复制，后续启动不读取原目录。启动前清除继承的模型、Agent、端口和数据路径设置，再载入自己的配置。
- 数据：本仓库 `data/isolated-local`；日志及进程信息：`data/local-service`。配置与数据真实路径必须留在当前仓库。仓库与依赖目录检查为实体目录。
- 主模型：`deepseek-flash`，reasoning `none`，每轮最多16次模型调用及16步。摘要与主模型共用现有计数机制。
- 真实媒体关闭（simulation），视觉关闭，供应商文字流与并行协议开关关闭；没有将模拟结果认作真实图片。真实媒体需要另行启用并逐方案批准，视觉需先确认供应商支持。
- 账号及供应商额度仍共享；本轮没有迁移其他 Chorify 的会话、数据或后台进程。没有配置开机自启，重启电脑后需手动启动。

## 验证与证据

1. `node --check scripts/context-local.mjs` 与 PowerShell Parser 检查通过；仓库 `npm run check` 的413文件检查通过，见 [syntax.log](syntax.log)。注入3212、其他数据目录及关闭模型的继承环境后，启动器仍按本地配置使用3217、仓库内目录和已启用文字模型，见[环境隔离验证](environment-isolation.json)。本轮未改产品逻辑，未重跑全量950项回归，也不把旧结果当本轮结果。
2. 实际运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/context-local.ps1 -Action Start`，再分别运行 `Status`、`Stop`、`Start`、重复 `Start`。进程命令行指向本仓库，监听PID一致，重复启动不新建进程。见 [进程证据](process-evidence.json)和[启动日志](lifecycle.log)。停止仅针对经过路径、可执行文件、PID及创建时间核对的本实例。
3. `node evaluations/2026-09-17-local-deployment/verify.mjs --live-text`：三个静态文件与当前 checkout SHA-256 一致；新会话最初为空；旧 `/api/sessions` 返回404；无令牌写入及其他本地端口 Origin 返回403。见 [HTTP证据](http-evidence.json)。
4. 上述命令实际发起一次文字调用：用户要求仅回复“本地独立实例正常”，真实返回完全一致。1次主模型、0次工具、0次摘要/视觉/媒体；供应商报告6238输入token、4输出token，共6242，费用未返回。见 [公开事件](text-events.json)、[完整模型输入响应及持久化Trace](text-trace.json)。这仅证明本机文字链路可用，不证明复杂语义、选材、视觉或媒体质量已验收。
5. 停止并重新启动后运行 `node evaluations/2026-09-17-local-deployment/verify.mjs --recover`：同一会话消息与资产完全一致，见 [恢复证据](restart-evidence.json)。原始数据库保留在独立数据目录，没有纳入Git。

验证脚本默认仅本地HTTP，不调用模型；`--live-text` 会新建会话并消耗模型额度，重跑须确认范围和预算。已有证据应归档后再重跑，不能覆盖历史证据后宣称是本次结果。

## 初始问题及验证范围

启动初稿在 PATH 出现两份 Node 时将两个路径拼接成命令，实际启动失败；已改为按 PATH 选择首个可执行文件并实际启动成功。一次 PowerShell Parser 检查因外层双引号插值失败，改为当前 PowerShell 内直接解析成功。测试时把后台启动输出通过嵌套 PowerShell 接入 `Tee-Object`，子进程继承句柄导致采集流程等待；终止已核实的测试采集进程后，改用独立调用完成验证，服务未受影响。日常入口不使用此管道方式。

未验证Windows系统重启后的自动恢复（未配置自启）、长时间运行、真实图片/视频、双图观察与复杂多轮语义。本次没有操作其他 Chorify 服务，也没有重新开放公网端口。

## 回滚与日常操作

双击 `start-context-local.cmd` 启动；`scripts/context-local.ps1 -Action Status` 查看，`-Action Stop` 停止，需在 PowerShell 以脚本方式执行。端口占用则拒绝启动，不替换占用者。日志每次启动另建文件。

回滚本轮部署前，先用专用脚本停止；再对本轮提交执行 `git revert`。本轮未改产品核心，不需要回退产品修复。保留 `.env.local`、`data/isolated-local` 和日志；不删除会话及历史版本。若更新业务代码，需用本实例 Stop/Start 重新载入。
