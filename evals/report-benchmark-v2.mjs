import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../data/benchmark-v2-200/',import.meta.url);
const report=JSON.parse(await readFile(new URL('results.json',root),'utf8'));
const {metadata,results}=report;
const diagnostics=JSON.parse(await readFile(new URL('diagnostics.json',root),'utf8'));
if(diagnostics.stats.finished!==200)throw new Error('Refresh complete diagnostics first');
const reviewNotes=await readFile(new URL('benchmark-v2-review-notes.md',import.meta.url),'utf8');
const recovery=JSON.parse(await readFile(new URL('recovery-diagnostic.json',root),'utf8'));
if(results.length!==200)throw new Error('Full report requires all 200 runs');
const count=(list,fn)=>list.filter(fn).length;
const fraction=(n,d)=>`${n}/${d}（${d?(100*n/d).toFixed(1):'0.0'}%）`;
const metric=(list,fn)=>fraction(count(list,fn),list.length);
const statusCounts=Object.fromEntries([...new Set(results.map(r=>r.status))].map(s=>[s,count(results,r=>r.status===s)]));
const byCategory=Object.fromEntries(Object.keys(metadata.audit.categoryCounts).map(k=>[k,results.filter(r=>r.category===k)]));
const groups=new Map();for(const r of results){const key=JSON.stringify([r.query,r.history]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
const signature=r=>JSON.stringify({ops:[...new Set(r.actualOps)].sort(),counts:r.goal?.tasks.map(t=>[t.operation,t.count]),clarify:r.goal?.needsClarification,safety:r.goal?.safety.disposition,dependency:r.raw.dependency,schema:r.raw.schema});
const repeated=[...groups.values()].filter(g=>g.length>1);
const unstable=repeated.filter(g=>new Set(g.map(signature)).size>1);
const timings=results.map(r=>r.durationMs).sort((a,b)=>a-b);
const eligibleReadOnly=results.filter(r=>r.forbiddenGeneration!==null);
const mediaCounts=results.filter(r=>r.mediaCountCheck);
const categoryNames={intent:'咨询与规划',image_creation:'图片生成',image_edit:'图片编辑',video_creation:'视频生成',video_analysis:'视频分析',material:'素材检索',workflow:'多任务流程',multi_turn:'多轮恢复',boundary:'工具边界',safety:'安全'};
const esc=t=>String(t??'').replaceAll('|','／').replaceAll('\n',' ');
const link=r=>`[${r.id}](data/benchmark-v2-200/runs/${r.id}.json)`;
const summary={total:200,rawPassed:count(results,r=>r.rawPassed),compatiblePassed:count(results,r=>r.compatiblePassed),schema:count(results,r=>r.raw.schema),operationExact:count(results,r=>r.raw.operations),clarification:count(results,r=>r.raw.clarification),dependency:count(results,r=>r.raw.dependency),statuses:statusCounts,
 toolRuns:count(results,r=>r.called.length>0),toolErrorRuns:count(results,r=>r.hasToolError),answers:count(results,r=>r.answerReturned),modelCalls:results.reduce((n,r)=>n+r.modelCallCount,0),
 simulatedImages:results.reduce((n,r)=>n+r.artifacts.images,0),simulatedVideos:results.reduce((n,r)=>n+r.artifacts.videos,0),textCommitRuns:count(results,r=>r.artifacts.textCommits>0),
 adviceGeneration:count(eligibleReadOnly,r=>r.forbiddenGeneration),adviceCases:eligibleReadOnly.length,mediaCountPass:count(mediaCounts,r=>r.mediaCountCheck.passed),mediaCountCases:mediaCounts.length,
 repeatedGroups:repeated.length,unstableGroups:unstable.length,medianMs:timings[Math.floor(timings.length/2)],p95Ms:timings[Math.ceil(timings.length*.95)-1]};
summary.batchVideoRecovery=recovery.rows.filter(r=>r.mediaCountBefore?.count===10).map(r=>({id:r.id,submitted:r.submittedVideoTasks,before:r.mediaCountBefore.actual,after:r.mediaCountAfter.actual,statusBefore:r.statusBefore,statusAfter:r.statusAfter}));
summary.mediaGoalTypeAndCount=count(mediaCounts,r=>r.goal?.tasks.filter(t=>t.output===(r.mediaCountCheck.kind==='images'?'image':'video')).reduce((n,t)=>n+t.count,0)===r.mediaCountCheck.count&&r.actualOps.includes(r.mediaCountCheck.kind==='images'?'generate_image':'generate_video'));
summary.skillKinds=Object.keys(diagnostics.stats.skillCalls).length;
await writeFile(new URL('summary.json',root),JSON.stringify(summary,null,2));
const detail=`# 200条逐项结果

原名严格分与名称兼容分含义见主报告。所有媒体为模拟产物，completed是Agent状态而非人工质量认证。

| ID | 类别 | 原始query | 原名严格 | 名称兼容 | 状态 | 实际目标操作 | 追问/错误 | 调用工具 |
|---|---|---|---|---|---|---|---|---|
${results.map(r=>`| ${link(r)} | ${categoryNames[r.category]} | ${esc(r.query)} | ${r.rawPassed?'通过':'未通过'} | ${r.compatiblePassed?'通过':'未通过'} | ${r.status} | ${r.actualOps.join(', ')||'空'} | ${esc(r.goal?.missingInputs.join('；')||r.intakeError?.error||r.runnerError)} | ${[...new Set(r.called)].join(', ')||'无'} |`).join('\n')}
`;
await writeFile(new URL('../BENCHMARK-V2-200-DETAILS.md',import.meta.url),detail);
const md=`# 外部200条Agent Loop评测结果

## 结论与评分边界

**当前Agent已具备单次生成与基础串行创作的调用闭环；批量调度、恢复状态、模糊需求的媒介选择和交付验收仍有明确缺口。** 本次用真实豆包评测决策，媒体服务模拟，不能据此认定真实图片或视频质量合格。

| 直接可判断的项目 | 本次观察 |
|---|---|
| 60条纯生成请求的目标类型与数量 | ${summary.mediaGoalTypeAndCount}/60识别匹配 |
| 图片生成 | 30/30在主循环返回要求数量的模拟图片 |
| 单视频生成 | 25/25在主循环查询成功并返回模拟视频地址 |
| 10视频批量生成 | 0/5在主循环交齐；后台查询补充诊断有3/5能收齐，但状态仍未修复 |
| 图片编辑 | 20/20识别edit_image，因无原图而追问；未验证真实编辑 |
| Skill与脚本 | 82条实际加载，覆盖${summary.skillKinds}/15种Skill，1次登记脚本成功执行 |
| 最终答复 | 200/200返回，包含澄清、拒绝、上限和错误信息 |

全部200条已逐条调用真实豆包完成本次主循环测试，不用去重结果代替重复样例。原名严格匹配 ${fraction(summary.rawPassed,200)}，名称兼容后的操作覆盖、澄清与依赖同时匹配 ${fraction(summary.compatiblePassed,200)}。这些是本包标签的一致率，不能直接称为用户任务完成率。

Agent最终标为completed ${statusCounts.completed||0}条；有模拟图片 ${count(results,r=>r.artifacts.images>0)}条、有模拟视频成品 ${count(results,r=>r.artifacts.videos>0)}条。completed只代表系统结束状态，文字非空和工具返回也不能证明完整理解了用户需求。

生产Agent代码与提示词保持冻结：${Object.values(metadata.unchanged).every(Boolean)?'运行前后hash全部一致':'存在hash变化，需查看metadata'}。没有用本次题目修改生产路由，也没有把期望标签发送给模型。

## 数据本身的限制

- 200条记录只有 ${metadata.audit.uniqueQueries} 个不同query；query+history+expected去重为 ${metadata.audit.uniqueInputAndLabels} 种。素材检索的同一句话重复15次，重复不是15种需求。
- 5组同输入视频分析请求有互相不同的操作标签。例如“这个视频讲什么？”同时被标read_video和analyze_video；无法以一个稳定策略同时满足两种原名标签。
- 图片编辑仅提供“已有图片”，多轮恢复仅提供“上一轮已有结果”；没有真实地址、任务ID、上一版正文或方案。视频分析20条没有待分析视频。缺这些信息时追问是合理行为，原包却统一标无需澄清。
- U146/U151/U156/U161/U166要求“先做脚本，再做视频”，标签却要求generate_image。U148等“同时”请求统一标dependency=true；U149等“我确认后再生成”也把生图写进当前任务标签。
- 边界和安全样例也有原材料缺失，不能把“未执行危险请求”“还需输入”“功能不支持”都当成相同意图。

原标签保留，不删除有争议样例，不事后改分。以上问题说明此包适合发现行为问题，暂不适合用单一总分比较Agent优劣。

## 执行环境与评分方法

模型：${metadata.model}；并发${metadata.concurrency}个用例；每个用例${metadata.maxAgentSteps}轮执行上限，截止${metadata.caseDeadlineMs/1000}秒。模型调用总计 ${summary.modelCalls} 次，单用例总耗时中位数 ${(summary.medianMs/1000).toFixed(2)}秒、P95 ${(summary.p95Ms/1000).toFixed(2)}秒，包含完整执行循环与服务等待。

真实执行豆包、Skill加载、已登记脚本、规划与会话工具。基础生图/视频服务模拟返回benchmark.invalid地址；视频仍须走创建和查询循环。输入素材不补造，虚构引用报错。扩展媒体和联网搜索未启用，因此不能把本次得分外推为这些外部服务的成功率。此次没有调用真实媒体生成API。

主评分边界是Agent.run返回时的状态，不包含HTTP服务器的后台任务监控、浏览器展示及后续用户轮次。观察到待查询任务后，另外使用原始状态副本运行真实refreshTasks函数，沿用同一模拟服务的完成语义，单列补充诊断；不修改原始trace和分数，不再请求豆包或提交新媒体。这项诊断也不等于已在真实HTTP环境验证恢复。

原名严格评分：结构有效、目标operation集合完全相同、澄清与依赖两个布尔标签都一致。expected.intent的标签体系与当前Agent不一致，未伪造其直接分类分数。

名称兼容评分另列：propose_image_batch对应generate_image目标或实际同名方案调用；视频同理。find_material必须实际调用；history_reference/读取历史方案必须实际读取交付或检索历史；clarification必须进入澄清。要求预期操作全部覆盖，允许辅助Skill和计划调用，仍比较澄清和依赖。此映射只用于评测，不改变Agent决策；兼容分也不是人工语义判定。

## 分类结果

| 类别 | 条数 | 原名严格匹配 | 名称兼容匹配 | completed状态 | 有工具成功返回 | 发生工具错误 |
|---|---:|---:|---:|---:|---:|---:|
${Object.entries(byCategory).map(([k,rows])=>`| ${categoryNames[k]} | ${rows.length} | ${metric(rows,r=>r.rawPassed)} | ${metric(rows,r=>r.compatiblePassed)} | ${count(rows,r=>r.status==='completed')} | ${count(rows,r=>r.called.length>0)} | ${count(rows,r=>r.hasToolError)} |`).join('\n')}

## 可观察行为

| 指标 | 结果 |
|---|---:|
| 入口结构有效 | ${fraction(summary.schema,200)} |
| 仅操作集合原名匹配（不含澄清、依赖） | ${fraction(summary.operationExact,200)} |
| 澄清与原标签一致 | ${fraction(summary.clarification,200)} |
| 依赖与原标签一致 | ${fraction(summary.dependency,200)} |
| 有最终答复（包括澄清、拒绝和错误） | ${fraction(summary.answers,200)} |
| 发生至少一次成功工具调用 | ${fraction(summary.toolRuns,200)} |
| 保存了文字交付 | ${summary.textCommitRuns}条 |
| 模拟图片 / 模拟视频成品 | ${summary.simulatedImages} / ${summary.simulatedVideos}个 |
| 60条纯生图/视频请求，模拟产物件数满足query | ${fraction(summary.mediaCountPass,summary.mediaCountCases)} |
| 咨询或明确先确认的35条，发生了媒体生成 | ${summary.adviceGeneration}/${summary.adviceCases} |
| 重复输入组出现不同结构化决策 | ${summary.unstableGroups}/${summary.repeatedGroups}组 |

状态分布：${Object.entries(statusCounts).map(([k,v])=>k+' '+v).join('；')}。

实际加载Skill的用例 ${diagnostics.stats.skillRuns} 条；真实登记脚本成功执行 ${diagnostics.stats.toolCalls.run_skill_script||0} 次。各Skill加载次数：${Object.entries(diagnostics.stats.skillCalls).map(([k,v])=>k+' '+v).join('；')}。加载只证明内容进入上下文，不能证明每项方法都被落实。

| 模型阶段 | 调用次数（含重试） | 单次中位数 | 单次P95 |
|---|---:|---:|---:|
${Object.entries(diagnostics.stats.phaseTimes).map(([k,v])=>`| ${k} | ${v.calls} | ${(v.medianMs/1000).toFixed(2)}秒 | ${(v.p95Ms/1000).toFixed(2)}秒 |`).join('\n')}

生成数量按原query中的一张、三张、十条等预先标注核对，不用模型自己声明的目标数量当正确答案。未通过只说明未交付要求数量，可能因为追问、超时、循环上限或错误；具体见trace。

咨询/先确认中发生模拟生成的用例：${eligibleReadOnly.filter(r=>r.forbiddenGeneration).map(link).join('、')||'无'}。这是需要逐条复核的越界执行信号。

回复出现工具未返回URL的用例：${results.filter(r=>r.unsupportedAnswerURLs.length).map(link).join('、')||'无'}。此项仅为复核线索，帮助链接不能直接算伪造成品。

## 重复输入稳定性

| Query | 次数 | 决策种数 | 原名通过 | 名称兼容通过 |
|---|---:|---:|---:|---:|
${unstable.map(g=>`| ${esc(g[0].query)} | ${g.length} | ${new Set(g.map(signature)).size} | ${count(g,r=>r.rawPassed)} | ${count(g,r=>r.compatiblePassed)} |`).join('\n')}

“决策”由目标操作/数量、澄清、安全处置、依赖和结构有效性组成，不以正文措辞变化判不稳定。重复样例顺序、并发负载和模型采样均可能影响结果，未用重复调用挑最高分。

${reviewNotes}

## 补充诊断：后台查询可以恢复多少批量视频

以下为5条“10个不同方向广告视频”的主循环结果与状态副本经过后台查询后的比较。视频地址仍全部为模拟地址。

| ID | 已提交任务 | 主循环已查询成品 | 补充查询后成品 | 主循环状态 → 查询后状态 |
|---|---:|---:|---:|---|
${summary.batchVideoRecovery.map(r=>`| ${r.id} | ${r.submitted} | ${r.before}/10 | ${r.after}/10 | ${r.statusBefore} → ${r.statusAfter} |`).join('\n')}

因此，不能将“主循环没有查询到成品”一概解释为媒体服务没有生成：后台查询能收回已提交任务；没提交的缺口则不会自动补齐。现有monitor只会把waiting转为completed/failed，不能自动修正limited或failed状态，也不会恢复剩余创作步骤。需要让完整交付数量、任务状态与面向用户的最终结论一致。完整记录见data/benchmark-v2-200/recovery-diagnostic.json。

## 全部记录与复现

- [200条逐项结果](BENCHMARK-V2-200-DETAILS.md)：原query、识别操作、澄清原因、工具调用和逐条完整trace链接。
- data/benchmark-v2-200/source.json：原始200条，未修改。
- data/benchmark-v2-200/metadata.json：数据、代码hash、完整提示词和测试配置。
- data/benchmark-v2-200/results.json、summary.json：机器可读汇总。
- data/benchmark-v2-200/runs/Uxxx.json：完整会话、模型输出、工具参数/结果、最终回答。模型输入采用前缀长度+增量记录，可依次重建，避免重复保存相同上下文。
- evals/BENCHMARK-V2-PROTOCOL.md：运行前冻结的方法。

运行器为evals/run-benchmark-v2.mjs；读取项目相邻benchmark-agent-loop-v2-200中的原JSON，要求输出目录尚不存在，避免覆盖首次记录。已验证压缩包中的JSON与JSONL内容一致。评分器4项测试通过，项目语法及独立性检查通过。

200条分数均已从trace重新计算，与results.json一致；源文件hash一致，冻结代码未变，1154次模型调用输入均可重建。校验结果见data/benchmark-v2-200/verification.json。补充脚本与原主循环运行器分开，重跑报告不会调用模型或媒体服务。

本报告不把语义匹配、工具调用成功、completed状态和真实成品质量混为一谈。没有真实素材与远端媒体执行，就不能声称200条端到端实物交付验收通过。
`;
await writeFile(new URL('../BENCHMARK-V2-200-REPORT.md',import.meta.url),md);
console.log(JSON.stringify(summary));
