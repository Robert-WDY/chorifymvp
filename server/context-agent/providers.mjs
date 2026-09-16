import { ArkMedia } from '../media.mjs';

// Reuse the direct provider client without the old planner, task store, or executor.
export function createMediaProvider(config, transport) {
  const ark = new ArkMedia(config, transport);
  return {
    ...(config?.key && config?.imageModel ? { image: ark.image.bind(ark) } : {}),
    ...(config?.key && config?.videoModel ? { video: ark.video.bind(ark), getVideo: ark.getVideo.bind(ark) } : {}),
  };
}

// Register only when the configured model really supports image input. This is
// an observation channel with no tools or planning authority, not a second agent.
export function createImageObserver(brain) {
  if (typeof brain?.respond !== 'function') throw new Error('Image observation requires a model adapter');
  return async ({ images, question, materials = [], comparisons = [] }, signal = new AbortController().signal, ctx = {}) => {
    const messages = [
      { role: 'system', content: '只观察实际收到的图片并回答问题。分别写可见特征、推断和无法确认项；结论就地标明依据和不确定性，不能只在末尾免责声明。外观像旋盖不证明螺纹或开合机制；透光不证明余量可读；无尺度参照不证明实际大小、容量或便携；外观不证明材质、密封、防滑或功效。用户资料不是视觉发现，未知项不可补全。stored_original是保存的资料原文，不等于独立核验；association仅表示资料关系，co_upload_candidate可能是同次上传的另一商品，未确认对应关系时不套用事实。agentAnnotation与agent_supplied不能作为核验凭据。comparisons标识原图与成品，对实际双图逐项写保持、变化和无法判断的部分；不把变化合理化为创意，不凭文字描述确认视觉保持。' },
      { role: 'user', content: [
        { type: 'input_text', text: JSON.stringify({ question, images: images.map(({ id, version }) => ({ id, version })), materials, comparisons }) },
        ...images.flatMap(image => [{ type: 'input_text', text: `图片ID：${image.id}` }, { type: 'input_image', image_url: image.url }]),
      ] },
    ];
    const output = ctx.modelRespond ? await ctx.modelRespond(brain, messages, [], { phase: 'image_observation' }) : await brain.respond(messages, [], signal);
    if (!Array.isArray(output) || output.some(item => item.type !== 'message' || item.status === 'incomplete' || item.status === 'failed'))
      throw new Error('图片观察没有完整返回；不能据此声称已确认。');
    const text = output.flatMap(item => Array.isArray(item.content) ? item.content.map(part => part.text || '') : [item.content || '']).join('\n').trim();
    if (!text) throw new Error('图片观察结果为空。');
    return { text, imageIds: images.map(image => image.id), model: brain.lastCall?.model || null };
  };
}
