import { readSkill } from '../catalog.mjs';

// Model-view adaptation only. The compiled runtime and the archived methods stay intact.
const descriptions = {
  'actor-realism-v2': '优化已有文字中的人物表演、动作、情绪和连续性；不授予媒体工具能力。',
  'asset-lock-generator-lite-v2': '人物、场景、商品多视角参考的设计方法；数量服从用户需求，实际生成取决于当前工具和批准。',
  'creative-cover-copy-v2': '基于实际读取的资料创作文案、标题和封面方案；媒体分析与生成取决于当前工具。',
  'creative-prompt-rewrite': '保留用户指定的剧情、镜头和产品边界，优化视频生成提示词文字。',
  'cinematic-shot-designer-zh-v5': '用户明确需要整版多宫格故事板时使用的镜头设计方法；不替代普通文字脚本。',
  'cinematic-style-optimizer-v2': '优化影调、色彩、光线和电影风格，保留已有内容与参数。',
  'direction-designer-zh-v1': '按用户要求的数量创作方向，推荐从这些方向中选择，不增加备选数量。',
  'image-prompt-gallery-director-v2': '按需检索图片案例，撰写图片生成或编辑提示词；读取案例不等于生成图片。',
  'marketing-brief-zh-v1': '需要简报时整理营销目标、受众、已知卖点与未知项，不强制作为创作前置步骤。',
  'product-understanding-zh-v1': '整理已读取商品资料与观察的证据、推断和未知项；不替用户确认未知事实。',
  'storyboard-one-shot-zh': '从用户要求或选定方向编写完整文字分镜，不要求先生成媒体。',
  'storyboard-one-shot-zh-v2': '从用户要求或选定方向编写完整文字分镜，不要求先生成媒体。',
  'video-decomposition-zh-v1': '视频分析方法资料；需实际视频观察能力才能分析原视频，目录存在不代表已接通。',
  'video-prompt-safety-zh-v1': '审查视频提示词文字并说明具体问题，不代表已生成或观看视频。',
  'video-script-zh-v1': '按用户时长、格式和选定内容写完整视频文字脚本，不生成媒体。',
};
export const projectSkills = skills => skills.map(({ slug, name, description }) => ({ slug, name, description: descriptions[slug] ?? description }));

const boundary = `# 使用边界\n这是专业方法资料。用户当前数量、对象、选定方向、修改和保持要求优先。你根据记忆、用户需求和实际工具结果自主规划，没有预设阶段、任务合同或输出业务Schema。方法示例不增加交付数量、工具权限或批准；读取方法不算交付。事实、观察、推断和创意设定分别保留身份。\n\n`;
const methods = {
  'direction-designer-zh-v1': `# 创意方向设计\n按用户要求的总数量写方向。每个方向写清切入角度、场景、表达机制和开场；差异应体现在创意内容。推荐从已给方向中选，不追加备选。未知商品性能不得作为事实前提；虚构场景明确是创意。已有选定方向直接消费其原文，只有用户要求时才修改方向。交付完整正文并保存文稿，不输出内部节点、结构字段或虚构ID。`,
  'marketing-brief-zh-v1': `# 营销简报\n仅在用户需要或当前创作确实需要整理时使用。基于原文整理目标、受众、核心表达、依据、风格和限制。区分事实、推断与未知。缺少普通偏好时合理设计；未知性能不补成卖点，不要求无关的前置文档。按用户范围交付并保存正文。`,
  'product-understanding-zh-v1': `# 产品理解\n读取用户资料；有相关图片且需要观察时带实际图片和相关文字资料观察。分别记录用户提供事实、可见特征、推断、未知项。图片中的大小感不是实际尺寸或便携性，外观不能证明容量、开盖结构、材质和功能。不得把资料缺失解释成用户要求失败。只整理用户所需内容，不擅自增加时长、数量或生产步骤。`,
  'video-decomposition-zh-v1': `# 视频拆解\n先核对当前工具是否能真实读取视频。没有该能力时说明限制；可以分析用户提供的逐镜文字或已取得的观察，但明确证据范围，不声称观看原视频。有真实观察时按时间轴分析结构、镜头、声音、钩子与可复用表达，结论绑定实际证据，未知项保留。`,
};
export async function readAgentSkill(catalog, slug, reference, offset = 0) {
  if (reference) return readSkill(catalog, slug, reference, offset);
  const first = await readSkill(catalog, slug, undefined, 0);
  let content = methods[slug];
  if (!content) {
    content = first.content;
    for (let next = first.nextOffset; next !== null;) {
      const page = await readSkill(catalog, slug, undefined, next);
      content += page.content; next = page.nextOffset;
    }
    if (content.startsWith('# 当前阶段边界\n')) {
      const body = content.indexOf('\n# ', 1);
      if (body !== -1) content = content.slice(body + 1);
    }
  }
  content = boundary + content;
  return { ...first, content: content.slice(offset, offset + 14000), nextOffset: offset + 14000 < content.length ? offset + 14000 : null };
}
