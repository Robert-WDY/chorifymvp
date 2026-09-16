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
  return async ({ images, question, materials = [] }, signal = new AbortController().signal, ctx = {}) => {
    const messages = [
      { role: 'system', content: '只观察实际收到的图片并回答给定问题。区分可见内容、用户提供资料、未知项和创作假设；不要把文字资料当作视觉发现，不推测不可见容量、功效、价格或活动承诺。stored_original是已保存资料原文，保留其未知项；agentAnnotation是模型附注，不可覆盖原文或作为核验凭据。agent_supplied表示模型传入的资料，可能来自用户原话但未绑定文件；不要自动升级为已核验事实。说明看不清或不能确认的部分。' },
      { role: 'user', content: [
        { type: 'input_text', text: JSON.stringify({ question, images: images.map(({ id, version }) => ({ id, version })), materials }) },
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
