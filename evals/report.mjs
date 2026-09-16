import {readFile,writeFile} from 'node:fs/promises';
const read=async name=>JSON.parse(await readFile(new URL('../data/'+name,import.meta.url),'utf8'));
const r=await read('intent-eval-v3.json'),b=await read('intent-eval-v2.json'),h=await read('http-goal-check.json'),repair=await read('intent-eval-repair.json');
const regression=r.results.filter(x=>x.split!=='challenge'),challenge=r.results.filter(x=>x.split==='challenge');
const scores=list=>`${list.filter(x=>x.passed).length}/${list.length}（${(100*list.filter(x=>x.passed).length/list.length).toFixed(1)}%）`;
const times=r.results.map(x=>x.durationMs).sort((a,b)=>a-b);
const outputFor=op=>['generate_image','edit_image'].includes(op)?'image':['generate_video','edit_video','lipsync','slice_video','upscale_video','replicate_video','merge_videos'].includes(op)?'video':['voiceover','clone_voice'].includes(op)?'audio':'text';
const outputCorrect=r.results.filter(x=>x.goal?.tasks.every(t=>t.output===outputFor(t.operation))).length;
const professional=r.results.filter(x=>x.goal?.tasks.some(t=>['rewrite','marketing_script','storyboard','review_content'].includes(t.operation)));
const skillsPresent=professional.filter(x=>x.goal.skills.length).length;
const md=`# 豆包任务目标识别：修复与实测报告

本次先落实轻量必经步骤，没有加入严格创意质量评分或每次都要求确认。

## 已实现

1. 每轮先用真实豆包独立识别结构化目标，记录操作、输出类型/数量、依赖、素材引用、假设、缺失信息与安全处置；本阶段不提供执行工具。
2. 专业文字任务自动实际加载模型选中的 Skill；漏选时使用已登记的通用对应方法。普通问答和单纯媒体生成不强制加载 Skill，不强制跑 Python 脚本。
3. 付费媒体操作必须符合本轮已记录的任务范围，并先记录行动计划。只要提示词不能悄悄变成生成视频。
4. 完成前只做基础检查：目标媒体类型/数量必须有真实工具返回；缺结果最多反馈模型修正两次，仍缺则不标 completed、不输出虚构成功。文字按 runId 保存。没有强制美学、事实或逐镜评分。
5. 缺必需输入和拒绝执行在工具前结束；普通创作允许明确默认假设。入口失败不继续执行媒体。
6. 原始 query 在格式重试中保持不变，格式反馈使用 system 消息，不能被当作新用户任务。此问题由本次实测发现并修复。

## 数据与方法

- 130 条人工构建用例，含中文、英文、混输、错别字、多轮指代、图片、视频、二次编辑、审核、危险攻击、文字改写、组合流程、异步状态等。
- 模型：${r.model}。真实 API；仅意图评测不执行任何媒体、脚本或搜索工具。
- 前100条：20条dev、80条首次留出；查看结果修订规则后全部视为回归。另30条 challenge 在最终提示规则冻结后首次运行，未按挑战输出继续改提示规则。
- 严格匹配：操作集合、澄清、安全均匹配；有标注时还检查数量、引用、依赖。不是凭模型自评，也不把没有报错当成功。
- 额外统计输出类型、Skill选择覆盖；它们不混入原有严格匹配总分，避免事后改分。

## 成绩

| 指标 | 结果 |
|---|---:|
| 首次100条全量原始评分 | ${scores(b.results)} |
| 修订后前100条回归 | ${scores(regression)} |
| 新增30条 challenge 首次 | ${scores(challenge)} |
| 最近完整130条严格匹配 | ${scores(r.results)} |
| JSON结构有效（含最多一次重试） | ${r.results.filter(x=>x.checks.schema).length}/130 |
| 操作集合匹配 | ${r.results.filter(x=>x.checks.operations).length}/130 |
| 澄清决策匹配 | ${r.results.filter(x=>x.checks.clarification).length}/130 |
| 安全处置匹配 | ${r.results.filter(x=>x.checks.safety).length}/130 |
| 输出类型与识别出的操作一致 | ${outputCorrect}/130 |
| 识别为专业文字时建议至少一个Skill | ${skillsPresent}/${professional.length} |
| 识别耗时中位数 / P95 | ${(times[Math.floor(times.length*.5)]/1000).toFixed(2)}s / ${(times[Math.ceil(times.length*.95)-1]/1000).toFixed(2)}s |

注意：首次100条中 I078 的“海报标题”原标为图片，后修正为文字标题；按当前标签回算首次为84/100，原始报告仍保留83/100，不能把这1条标签修订当作模型提升。更早dev中的 I032 缺原始提示词，应追问，标签也已修正。严格分数对合理歧义保守计失败。

## 分类明细

| 类别 | 严格通过 |
|---|---:|
${Object.entries(r.summary.categories).map(([k,v])=>`| ${k} | ${v.passed}/${v.total} |`).join('\n')}

## 全部未匹配样例

| ID | 用户query | 期望操作 | 实际操作 | 未匹配字段 |
|---|---|---|---|---|
${r.results.filter(x=>!x.passed).map(x=>`| ${x.id} | ${x.query.replaceAll('|','／')} | ${x.expected.operations.join(', ')||'澄清/拒绝'} | ${x.goal?.tasks.map(t=>t.operation).join(', ')||'空'} | ${Object.entries(x.checks).filter(([,v])=>!v).map(([k])=>k).join(', ')} |`).join('\n')}

失败解释：
- I004/I078 首次涉及 JSON 修复反馈被误当目标，已修复重试机制并增加确定性测试；专项真实复测为 ${scores(repair.results)}，I004已通过，I078仍在标题/图片/改写的解释边界，不隐藏失败。
- I009 的表达可被理解为说明海报文字而非明确要求生成；I096 把澄清包装成 answer，实际仍会追问，属于严格标签差异。
- I035/I057/I089/I117 多问了内容或素材细节。I089“加字幕”未提供字幕正文，追问有一定合理性，当前标签采用自动转写默认策略，结果保守保留失败；产品也尚无专用字幕执行器。
- I067 把看图归入 answer；I118 把实际视频切片理解成文字拆解；I121/I127 把安全审核理解成一般问答。都是应继续改进的任务边界。
- 安全处置匹配只说明这些样例的入口分类，不证明防攻击能力在所有情形下完备。

## 真正执行链路验收

网页 HTTP + 真实豆包 + 本地Skill：${h.passed?'通过':'未全部通过'}，会话 ${h.sessionId}。

${h.reports.map((x,i)=>`${i+1}. ${x.query} → ${x.status}；工具：${x.tools.map(t=>t.name+(t.automatic?'（入口自动加载）':'')).join(' → ')||'无工具执行'}。`).join('\n')}

本地回归62项通过，含入口无执行工具、格式修复保留query、专业Skill不可跳过、禁止越出媒体范围、没有成品不可标成功、拒绝/澄清前不执行等。

## 可复现证据与边界

- evals/intent-cases.json：全部query、上下文和人工预期。
- data/intent-eval-baseline.json、intent-eval-v2.json、intent-eval-v3.json：各次原始结果、完整结构化目标、耗时、错误与hash。
- data/intent-eval-repair.json：格式重试修复后的专项复测；不与v3拼接伪造一个新全量成绩。
- data/http-goal-check.json：实际HTTP执行记录。

最近完整130条成绩针对v3；其后仅修改了格式重试协议，已做专项复测及单元回归，没有把它声称为另一次130条全量运行。所有分数均为合成用例单次采样，非真实线上分布，不保证重复运行完全一致。目标识别准确不等于媒体服务已配置、生成质量已验收；扩展服务凭据不足仍会如实阻塞。
`;
await writeFile(new URL('../INTENT-EVALUATION-20260910.md',import.meta.url),md);
console.log(JSON.stringify({total:scores(r.results),regression:scores(regression),challenge:scores(challenge),outputCorrect,skillsPresent,professional:professional.length,medianMs:times[65],p95Ms:times[123],http:h.passed}));
