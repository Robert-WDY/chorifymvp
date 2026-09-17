// Regenerate the human-readable catalog from the executable cases; no model calls.
import {writeFile} from 'node:fs/promises';
import {acceptanceCases,acceptanceCategories} from './context-agent-acceptance-cases.mjs';

const rounds=acceptanceCases.reduce((n,c)=>n+c.turns.length,0);
let md=`# 七类测试集目录\n\n当前扩展集 **${acceptanceCases.length}组${rounds}轮**。每组从独立空会话开始，多轮组在组内延续同一会话。历史冻结23条保持原样。六个验收主题作为交叉标签保留。\n\n本文件由 \`node evals/context-agent-acceptance-index.mjs\` 从可执行案例生成。\n\n| 类别 | 筛选ID | 组数 | 轮数 |\n| -- | -- | -- | -- |\n`;
for(const [id,name]of Object.entries(acceptanceCategories)){
 const cases=acceptanceCases.filter(c=>c.category===id);
 md+=`| ${name} | ${id} | ${cases.length} | ${cases.reduce((n,c)=>n+c.turns.length,0)} |\n`;
}
md+=`
## 分类与执行边界

- 新对话图片生成检查首次query的方案准备；未批准不能提交。确认后的生成闭环属于多轮。
- 分析图片的解释文字不单独算文案创作；明确要求文案加配图才归入混合任务。
- missingInputs是**故意不给输入的负向案例**，照常执行，正确澄清或有依据的部分交付可以通过，不以“没有生成结果”直接判失败。不能为跑通而自动补图、补原稿或伪造历史。
- blockedReason表示**评测设施缺少必要能力**，保持not_run，与故意缺图的案例不同。
- Skill案例核对真实read_skill及下一次模型输入，之后由GPT/Codex判断是否实际应用方法；工具名出现、HTTP200、completed都不代表业务通过。selection=explicit表示用户点名，inferred表示需自主选择。验收字段不传入用户query。
- 文字“和谐化”使用当前视频提示词检查Skill；既检查风险内容的实质替换，也检查正常内容不被过度修改。所有案例不生成视频。
- 多轮遇到waiting_user时仅发送案例预写的下一条用户原话，不合成回答或批准；若没有下一轮，则记录实际澄清后结束，等待语义评审。
- 长记忆中间18轮仍为合成压力材料，须验证纠正实际离开近期窗口，不能当作自然用户分布样本。

## 按类别执行

预览不调用模型：

\`\`\`powershell
node evals/context-agent-multiturn.mjs --acceptance --categories=new_text
node evals/context-agent-multiturn.mjs --acceptance --cases=AC_MISSING_IMAGE,AC_SAFETY_BICYCLE
\`\`\`

授权的真实文字评测另加 \`--run --env=C:\\path\\to\\local.env --budget=120\`。建议按类别或案例分批，总预算不足时后续案例会标not_run。当前媒体始终simulation，真实图片场景的素材声明尚未接入附件输入。
`;
for(const [id,name]of Object.entries(acceptanceCategories)){
 md+=`\n## ${name}\n`;
 for(const c of acceptanceCases.filter(c=>c.category===id)){
  md+=`\n### ${c.id}（${c.theme}）\n\n`;
  c.turns.forEach((t,i)=>{md+=`${i+1}. ${c.id==='AC_MEMORY'&&i>=2&&i<20?'合成长上下文版式压力材料（完整输入见案例源码）。':t.user}\n`;});
  md+=`\n验收：${c.expected}\n`;
  if(c.skill)md+=`\nSkill：${c.skill.slug}（${c.skill.selection==='explicit'?'用户点名':'自主选择'}）。\n`;
  if(c.missingInputs)md+=`\n故意缺少：${c.missingInputs.join('、')}。这是可执行负向案例，不自动补齐。\n`;
  if(c.blockedReason)md+=`\n执行限制：${c.blockedReason}\n`;
  if(c.fixtures?.length)md+=`\n素材需求：${c.fixtures.join('、')}（未接入当前runner）。\n`;
 }
}
await writeFile(new URL('../evaluations/2026-09-17-acceptance-extension/CATEGORIES.md',import.meta.url),md);
console.log(JSON.stringify({cases:acceptanceCases.length,rounds,skills:acceptanceCases.filter(c=>c.skill).length,negative:acceptanceCases.filter(c=>c.missingInputs).length,blocked:acceptanceCases.filter(c=>c.blockedReason).length}));
