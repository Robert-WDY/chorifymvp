# 编译运行时：1000 条闭环评测

固定版本原始通过 **991/1000（99.1%）**。这是真实豆包 + 模拟媒体的自动协议评测，不能作为真实媒体成功率或开放世界准确率。独立真实媒体验证 **2/2**。

## 运行信息

- 开始：2026-09-10T09:08:23.889Z
- 结束：2026-09-10T09:21:20.216Z
- 耗时：12.94 分钟
- 模型：doubao-seed-2-1-turbo-260628，并发 32，实际模型调用 4121 次。
- 40 个场景族 × 25 个产品变体；1000 个独立会话，部分含多轮输入，不复用其他样例结果。
- 1000 条完整 trace 和期望隔离已检查；运行期间服务端与评测代码 hash 保持不变。
- 服务端与评测源码联合 SHA-256：9e1bf4bd7ad0e97d399711fbb29585514ecdb093a612d70e890687670820b6d5

## 分层检查

| 检查 | 通过 / 总数 | 含义 |
|---|---:|---|
| 结构化入口 | 1000/1000 | 仅格式和入口调用成功，不等于语义准确 |
| 媒体目标 | 624/625 | 媒介、数量无遗漏或额外媒体；仅有明确媒体标签的样例 |
| 任务规划 | 896/900 | 任务图完整性与媒体 Skill 合同证据 |
| 模型权限 | 4121/4121 | 每次模型调用均未获得执行工具 |
| 提交参数 | 1021/1021 | 所有媒体提交符合实际工具参数 Schema |
| 状态约束 | 1000/1000 | COMPLETED 必须有通过验收的真实产物，确认必须有保存参数 |
| 多轮确认 | 48/50 | 确认前不生成、缺信息后的义务和身份保留 |
| 版本修订 | 25/25 | 新产物存在父版本及版本号 |
| 故障恢复 | 75/75 | 已知拒绝、未知提交和查询超时注入的预期结果 |

产物记录：301 份经模型验收的文字版本，971 个模拟媒体版本。模拟媒体没有真实像素/视频，不做视觉正确率统计。相同模型分别负责理解和验收，仍可能共同漏错。

## 按场景分类

| 场景 | 通过 / 总数 |
|---|---:|
| image-single | 25/25 |
| image-three | 25/25 |
| image-size | 25/25 |
| image-portrait | 25/25 |
| image-exact-text | 25/25 |
| image-panel | 25/25 |
| image-english | 25/25 |
| image-colloquial | 25/25 |
| video-single | 25/25 |
| video-three | 25/25 |
| video-ten | 25/25 |
| video-portrait | 25/25 |
| video-reference | 25/25 |
| video-english | 25/25 |
| edit-background | 25/25 |
| edit-remove-text | 25/25 |
| edit-style | 25/25 |
| missing-image | 25/25 |
| missing-video | 25/25 |
| rewrite | 25/25 |
| prompt-only | 25/25 |
| script-only | 25/25 |
| marketing-default | 25/25 |
| review | 25/25 |
| complex-text | 23/25 |
| attack-secret | 25/25 |
| attack-review | 25/25 |
| attack-tool | 25/25 |
| unsupported-video-edit | 25/25 |
| unsupported-audio | 25/25 |
| unsupported-duration | 25/25 |
| copy-image | 25/25 |
| script-video | 21/25 |
| confirmation | 25/25 |
| clarify-confirm | 22/25 |
| revision | 25/25 |
| failure-known | 25/25 |
| failure-unknown | 25/25 |
| failure-poll | 25/25 |
| independent | 25/25 |

## 全部失败样例

### Q0073 · script-video

1. 先写保温水壶的5秒分镜，再按分镜生成一条5秒16:9视频。

状态：blocked。失败项：state、video、skillContract。

原因：[{"instancePath":"/items/2/duration","schemaPath":"#/properties/items/items/properties/duration/minimum","keyword":"minimum","params":{"comparison":">=","limit":2},"message":"must be >= 2"}]

[Q0073](data/compiled-full-1000-v1/runs/Q0073.json)

### Q0233 · script-video

1. 先写运动鞋的5秒分镜，再按分镜生成一条5秒16:9视频。

状态：blocked。失败项：state、video、skillContract。

原因：方案数量未覆盖剩余交付

[Q0233](data/compiled-full-1000-v1/runs/Q0233.json)

### Q0385 · complex-text

1. 为无线耳机写三个广告标题，分别温柔、幽默、科技风，每个不超过12字，不用生成媒体。

状态：blocked。失败项：state、text。

原因：Expected ':' after property name in JSON at position 15 (line 2 column 1)

[Q0385](data/compiled-full-1000-v1/runs/Q0385.json)

### Q0433 · script-video

1. 先写陶瓷花瓶的5秒分镜，再按分镜生成一条5秒16:9视频。

状态：blocked。失败项：state、video、skillContract。

原因：方案数量未覆盖剩余交付

[Q0433](data/compiled-full-1000-v1/runs/Q0433.json)

### Q0635 · clarify-confirm

1. 先出方案，我确认后再生成。
2. 我要一张眼镜盒海报，无文字。
3. 确认，执行当前方案。

状态：needs_input。失败项：state。

原因：请确认已展示的具体方案

[Q0635](data/compiled-full-1000-v1/runs/Q0635.json)

### Q0715 · clarify-confirm

1. 先出方案，我确认后再生成。
2. 我要一张蓝牙音箱海报，无文字。
3. 确认，执行当前方案。

状态：simulated。失败项：clarifyConfirm。

原因：需结合状态快照检查

[Q0715](data/compiled-full-1000-v1/runs/Q0715.json)

### Q0755 · clarify-confirm

1. 先出方案，我确认后再生成。
2. 我要一张木制餐盘海报，无文字。
3. 确认，执行当前方案。

状态：simulated。失败项：clarifyConfirm。

原因：需结合状态快照检查

[Q0755](data/compiled-full-1000-v1/runs/Q0755.json)

### Q0793 · script-video

1. 先写围巾的5秒分镜，再按分镜生成一条5秒16:9视频。

状态：blocked。失败项：state、video、skillContract。

原因：[{"instancePath":"/items/2/duration","schemaPath":"#/properties/items/items/properties/duration/minimum","keyword":"minimum","params":{"comparison":">=","limit":2},"message":"must be >= 2"}]

[Q0793](data/compiled-full-1000-v1/runs/Q0793.json)

### Q0825 · complex-text

1. 为洗发水写三个广告标题，分别温柔、幽默、科技风，每个不超过12字，不用生成媒体。

状态：blocked。失败项：state、text。

原因：验收器未返回有效结构

[Q0825](data/compiled-full-1000-v1/runs/Q0825.json)

## 独立真实媒体验证

- real-image：completed，5 次模型调用，29.1 秒。[真实 trace](data/task-loop-compiled-real-v1/real-image.json)。
- real-video：completed，5 次模型调用，58.9 秒。[真实 trace](data/task-loop-compiled-real-v1/real-video.json)。

## 方法限制

原始 passed 聚合检查状态、预期产物数量、必要依赖、确认和版本，不逐字人工评审所有正文；也不能证明所有图像主体、文字或视频镜头正确。场景族复用结构，只替换产品，泛化证据弱于 1000 个独立真实用户需求。先前 200 条意图数据的标签和检查层级不同，分数不可直接比较。

预评测 pilot-v1 原始结果 38/40，未被覆盖。其攻击样例同时出现广告目的与窃密动作，正式集改为明确纯窃密目标；字数验收增加程序计数及一次文字修复。正式集启动前完成这些调整，正式运行中不改实现。

## 原因分析与修复后验证

全量运行后共有9条失败：

1. **4条视频规划失败**：旧分镜资料的逐镜输出影响新Skill，把1条最终视频拆成多个items。修复为每任务专用Schema，items数量精确等于成品数，duration/ratio使用任务常量；所有镜头在同一个视频prompt表达。旧方法作为用户层参考数据提供，不再拼入系统指令。
2. **3条确认场景失败**：一条把方案和成品识别成2张图，两条在没有目标时先完成说明任务。增加确认Goal合同核验和一次语义修正。后续复测又发现Task ID少一个字符，已增加精确ID校验与结构修复，禁止默默新建任务。
3. **2条验收结构失败**：验收器返回损坏JSON或不符合Schema。增加一次格式重试，仍不能默认通过。一次复测暴露12字加空格被判13字，已明确中文计数默认排除排版空格及标点。

| 独立复测 | 结果 | 新发现与处理 |
|---|---:|---|
| failures-v2 | 8/9 | 字数口径问题 |
| failures-v3 | 8/9 | Task ID复制截断 |
| failures-v4 | 9/9 | 同一9条原始Query，新会话重新完整执行，66次模型调用 |

以上没有覆盖或重算原始991/1000。最终实现尚未再次全量跑1000条，不能称为全量100%。[最新复测结果](data/compiled-failures-v4/results.json)与[独立校验](data/compiled-failures-v4/verification.json)均保留。最新复测目录code/保存了当次服务端与评测源码。

**测试113/113通过**，包括旧协议回归、编译协议、HTTP端到端、强制Skill、具体参数确认、篡改拦截、验收阻塞、修复版本、重启未知提交、精确任务引用和中文字数边界；独立性及语法检查通过122个文件。

真实媒体：初版1张图片与1条视频均通过，修复版又生成1条视频并通过实际内容验收。[修复版真实视频trace](data/task-loop-compiled-real-v3/real-video.json)。共1次图片、2次视频成功，不代表复杂多镜头视觉质量已经全面验证。真实媒体脚本的旧submissionCount字段只记录模拟适配器，真实执行数量应查看state.taskStore.executions，不应将其中的0当成没有调用工具。

本地浏览器已验证2个Skill/3个工具显示，以及文字Query → Goal → 执行图 → 正文Artifact → 内容验收的交付。单机持久化与上游临时URL限制仍然存在。
