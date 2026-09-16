import { endpoint } from './adapters.mjs';
export class ProviderError extends Error {
  constructor(message, uncertain = false) { super(message); this.uncertain = uncertain; }
}
export function publicMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('素材 URL 格式无效'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ProviderError('素材必须是公网 HTTPS URL');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost') || host.includes(':') || /^[\d.]+$/.test(host)) throw new ProviderError('素材地址不能使用本机或 IP 地址');
  return url.href;
}
// Direct Ark HTTP client. No business-platform gateway or database.
export class ArkMedia {
  constructor(config, transport = fetch) { this.config = config; this.fetch = transport; }
  async request(path, body, signal, method = 'POST') {
    if (!this.config.key) throw new ProviderError('未配置 DOUBAO_API_KEY');
    signal.throwIfAborted();
    let response;
    try {
      response = await this.fetch(endpoint(this.config.baseUrl, path), {
        method, redirect: 'error', headers: { Authorization: `Bearer ${this.config.key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      });
    } catch(error) { if(error instanceof ProviderError&&!error.uncertain)throw error;throw new ProviderError('生成服务连接中断，提交结果未知', method === 'POST'); }
    let data;
    try { data = await response.json(); }
    catch { throw new ProviderError('生成服务响应无法解析', method === 'POST'); }
    if (!response.ok || data.error) {
      const message = data.error?.code === 'AccountOverdueError' ? '豆包账户欠费，请补足额度后重试' : `生成服务拒绝请求（HTTP ${response.status}），请检查模型权限和参数`;
      throw new ProviderError(message, method === 'POST' && response.status >= 500);
    }
    return data;
  }
  async image(args, signal) {
    if (!this.config.imageModel) throw new ProviderError('未配置 DOUBAO_IMAGE_MODEL');
    const references = (args.referenceImages || []).map(publicMediaUrl);
    const data = await this.request('/api/v3/images/generations', {
      model: this.config.imageModel, prompt: args.prompt, size: args.size || '2K',
      response_format: 'url', stream: false, watermark: false, sequential_image_generation: 'disabled',
      ...(references.length ? { image: references } : {}),
    }, signal);
    let images;
    try {images = (data.data || []).filter(x => typeof x.url === 'string').map(x => ({ url: publicMediaUrl(x.url), size: x.size }));}
    catch {throw new ProviderError('图片接口返回无效成品地址，不能安全重提',true);}
    if (!images.length) throw new ProviderError('图片接口没有返回成品，不能认定生成成功', true);
    return { status: 'succeeded', images };
  }
  async video(args, signal) {
    if (!this.config.videoModel) throw new ProviderError('未配置 DOUBAO_VIDEO_MODEL');
    const content = [{ type: 'text', text: args.prompt }];
    if (args.firstFrameUrl) content.push({ type: 'image_url', image_url: { url: publicMediaUrl(args.firstFrameUrl) }, role: 'first_frame' });
    const data = await this.request('/api/v3/contents/generations/tasks', {
      model: this.config.videoModel, content, duration: args.duration || 5,
      ratio: args.ratio || '16:9', resolution: args.resolution || '720p', watermark: false,
    }, signal);
    if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.id)) throw new ProviderError('视频接口未返回有效任务 ID，提交结果未知', true);
    return { taskId: data.id, status: 'queued' };
  }
  async getVideo(taskId, signal) {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new ProviderError('任务 ID 无效');
    const data = await this.request(`/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, null, signal, 'GET');
    if (!['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(data.status)) throw new ProviderError('视频任务返回未知状态');
    const result = { taskId, status: data.status };
    if (data.status === 'succeeded') {
      if (!data.content?.video_url) throw new ProviderError('任务标记成功但缺少视频 URL');
      result.videoUrl = publicMediaUrl(data.content.video_url);
      result.metadata = Object.fromEntries(['duration','ratio','resolution','framespersecond'].filter(key=>data[key]!==undefined).map(key=>[key,data[key]]));
    }
    if (['failed', 'expired', 'cancelled'].includes(data.status)) result.isError = true;
    return result;
  }
}
