import Ajv from 'ajv';
import { readAgentSkill } from './skills.mjs';
import { countBody } from '../hard-requirements.mjs';
import { publicMediaUrl } from '../media.mjs';
import { searchHistory, readHistory } from './history.mjs';
import { GuardError, assertOwner, assetFor, withSessionLock, fingerprint, newId, now, persist,
  assertNotCancelled, assertMediaBudget, createProposal, approvedProposal, approveProposals } from './io-guard.mjs';
export { approveProposals };

const string = (maxLength = 100000) => ({ type: 'string', minLength: 1, maxLength });
const id = string(200), ids = { type: 'array', items: id, uniqueItems: true, maxItems: 20 };
const offset = { type: 'integer', minimum: 0 }, limit = { type: 'integer', minimum: 1, maximum: 20000 };
const size = { type: 'string', pattern: '^(1K|2K|4K|[1-9][0-9]{2,4}x[1-9][0-9]{2,4})$' };
const approvalFields = { proposalId: id, approvalId: id };
const schema = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const tool = (name, description, properties, required = []) => ({ type: 'function', name, description,
  parameters: schema(properties, required), strict: false });
const mediaNames = new Set(['generate_image', 'edit_image', 'generate_video']);
const safeError = (error, submitted = false) => ({ ok: false, error: { code: error.code || 'tool_error', message: error.message || '工具未能完成；请检查输入。' }, submitted });
const stripApproval = args => Object.fromEntries(Object.entries(args).filter(([key]) => !['proposalId', 'approvalId'].includes(key)));
const immutableAsset = asset => Object.freeze({ ...asset, sourceIds: Object.freeze([...(asset.sourceIds || [])]) });
const clone = value => structuredClone(value);

export function createTools({ catalog = { skills: [] }, media, observeImages, mode = 'simulation', readConcurrency = 4 } = {}) {
  if (!['simulation', 'live'].includes(mode)) throw new Error('Unknown media mode');
  const definitions = [
    tool('read_asset', '读取本会话准确素材原文或文件元数据。图片URL不是视觉观察；长文用nextOffset继续读取。', { id, offset, limit }, ['id']),
    tool('search_history', '检索本会话原话及原始工具证据，排除检索回声和调试Trace；准确记录ID仍可定位任何原记录。', { query: string(2000), limit: { type: 'integer', minimum: 1, maximum: 50 }, before: string(80), after: string(80) }, ['query']),
    tool('read_history', '按ID读取原记录及去除检索回声、调试Trace的前后文；按offset/limit分页，原文不变。', { messageId: id, surroundingRange: { type: 'integer', minimum: 0, maximum: 20 }, offset, limit }, ['messageId']),
    tool('read_skill', '按需读取专业方法和参考原文；不创建任务、不自动安排流程。', { slug: string(100), reference: string(400), offset }, ['slug']),
    tool('save_document', '保存交付正文为不可变文稿。新稿传content；修改传content和原稿parentId。原稿只在聊天时先传sourceMessageId原样存档（无需重抄正文），取得asset.id后再保存带parentId的修订。普通答疑无需保存。', { content: string(500000), title: string(500), parentId: id, sourceMessageId: id, sourceIds: ids }),
    tool('measure_text', '按现有统一口径测量传入正文，不含未传入的标题或说明；不替代内容判断。', { text: { type: 'string', maxLength: 500000 }, unit: { enum: ['characters', 'non_punctuation_characters'] } }, ['text', 'unit']),
  ];
  definitions.find(def => def.name === 'save_document').parameters.anyOf = [{ required: ['content'] }, { required: ['sourceMessageId'] }];
  if (typeof observeImages === 'function') definitions.push(tool('analyze_image', '真实观察图片。保持验收须传原图和成品imageIds；已绑定父版本的成品自动补入原图。自动读取明确关联的文字资料；额外资料用materials.sourceId（仅文字ID）。不确定结构、实际大小或功能不可当事实。', {
    imageIds: { ...ids, minItems: 1 }, question: string(12000), materials: { type: 'array', maxItems: 30, items: schema({ content: string(100000), sourceId: { ...id, description: '文字资料ID；工具会读取该真实原文，content/status仅作为模型附注。' },
      status: { enum: ['user_provided', 'verified', 'unknown', 'assumption', 'creative_hypothesis'] } }, ['content']) },
  }, ['imageIds', 'question']));
  if (mode === 'simulation' || typeof media?.image === 'function') {
    definitions.push(tool('generate_image', '每次仅准备一张图片的具体参数并请求批准；只有重复完全相同参数且带服务端proposalId/approvalId才提交。referenceImages必须是本会话图片ID。', {
      prompt: string(16000), size, referenceImages: ids, sourceIds: ids, ...approvalFields,
    }, ['prompt', 'size']));
    definitions.push(tool('edit_image', '编辑一张准确原图，自动记录父版本。首次调用准备方案；用户批准后重复原参数并带proposalId/approvalId才提交。', {
      imageId: id, instruction: string(16000), size, sourceIds: ids, ...approvalFields,
    }, ['imageId', 'instruction']));
  }
  if (mode === 'simulation' || typeof media?.video === 'function') definitions.push(tool('generate_video', '准备一段视频的具体参数；取得对应方案批准后才提交。处理中返回可查询回执，不自动建立后台业务任务。', {
    prompt: string(16000), duration: { type: 'integer', minimum: 1, maximum: 20 }, ratio: { enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
    resolution: { enum: ['480p', '720p', '1080p'] }, firstFrameId: id, sourceIds: ids, ...approvalFields,
  }, ['prompt', 'duration', 'ratio', 'resolution']));
  definitions.push(tool('read_media_result', '查询本会话已提交调用的receiptId；不会再次生成。没有供应商查询能力时如实返回unknown。', { receiptId: id }, ['receiptId']));
  if (mode === 'simulation') for (const definition of definitions.filter(def => mediaNames.has(def.name))) definition.description = '当前仅模拟，不会生成真实媒体。' + definition.description;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validators = new Map(definitions.map(def => [def.name, ajv.compile(def.parameters)]));

  function normalizedMedia(name, args, state) {
    const out = clone(stripApproval(args));
    if (name === 'edit_image') out.size ||= assetFor(state, out.imageId, 'image').size || '2K';
    for (const sourceId of out.sourceIds || []) assetFor(state, sourceId);
    const imageIds = name === 'edit_image' ? [out.imageId] : name === 'generate_video' ? (out.firstFrameId ? [out.firstFrameId] : []) : (out.referenceImages || []);
    for (const imageId of imageIds) {
      const asset = assetFor(state, imageId, 'image');
      if (mode === 'live') {
        if (asset.simulated || !asset.url) throw new GuardError('real_image_required', `素材 ${imageId} 不是实际图片，不能作为真实生成参考。`);
        publicMediaUrl(asset.url);
      }
    }
    return out;
  }
  function sourcesFor(name, args) {
    return [...new Set([...(args.sourceIds || []), ...(args.referenceImages || []), ...(args.imageId ? [args.imageId] : []), ...(args.firstFrameId ? [args.firstFrameId] : [])])];
  }
  function mediaAssets(state, invocation, result) {
    if (invocation.assetIds?.length) return invocation.assetIds.map(id => state.assets[id]);
    const { name, args } = invocation;
    const parent = name === 'edit_image' ? assetFor(state, args.imageId, 'image') : null;
    const files = result.simulated ? [{ type: name === 'generate_video' ? 'video' : 'image', simulated: true }]
      : name === 'generate_video' ? (result.videoUrl ? [{ type: 'video', url: publicMediaUrl(result.videoUrl), metadata: result.metadata }] : [])
        : (result.images || []).map(image => ({ type: 'image', url: publicMediaUrl(image.url), ...(image.size ? { size: image.size } : {}) }));
    if (files.length !== 1) throw Object.assign(new Error('供应商未返回恰好一份实际媒体文件；提交结果需要核对，不能自动重提。'), { uncertain: true });
    const assets = files.map(file => immutableAsset({ id: newId(file.type === 'image' ? 'img' : 'vid'), ...file,
      ownerId: state.ownerId, version: parent ? parent.version + 1 : 1, ...(parent ? { parentId: parent.id } : {}),
      sourceIds: sourcesFor(name, args), createdAt: now(), receiptId: invocation.receiptId,
      ...(name !== 'generate_video' ? { requestedSize: args.size } : { requestedDuration: args.duration, requestedRatio: args.ratio, requestedResolution: args.resolution }),
    }));
    for (const asset of assets) state.assets[asset.id] = asset;
    invocation.assetIds = assets.map(asset => asset.id);
    return assets;
  }
  function receiptResult(state, invocation) {
    if (invocation.result) return clone(invocation.result);
    return { ok: true, status: invocation.status === 'inflight' ? 'unknown' : invocation.status, submitted: invocation.status === 'inflight' ? 'unknown' : true,
      receiptId: invocation.receiptId, providerReceiptId: invocation.providerReceiptId || null, simulated: invocation.mode === 'simulation',
      message: '已有提交记录；不会再次提交。需要查询原回执或核对供应商结果。' };
  }
  async function executeMedia(name, args, ctx) {
    const { state, save, signal, turnId, callId } = ctx;
    return withSessionLock(state, async () => {
      assertNotCancelled(signal);
      const normalized = normalizedMedia(name, args, state);
      if (!args.proposalId && !args.approvalId) {
        const proposal = createProposal(state, { name, args: normalized, mode, callId, turnId });
        await persist(state, save);
        return { ok: true, status: 'approval_required', submitted: false, proposalId: proposal.proposalId, turnId: proposal.turnId, name, args: clone(proposal.args), simulated: mode === 'simulation',
          message: '具体方案已保存，尚未生成。请向用户展示同组全部方案；收到服务端批准后才可提交。' };
      }
      const proposal = approvedProposal(state, { ...args, name, args: normalized, mode });
      const receiptId = `receipt_${fingerprint([state.id, state.ownerId, proposal.proposalId]).slice(0, 32)}`;
      if (state.invocations[receiptId]) return receiptResult(state, state.invocations[receiptId]);
      assertMediaBudget(state, turnId, ctx.maxMediaCalls ?? 0);
      // Save before network I/O. A crash from this point must never automatically resubmit.
      const invocation = { kind: 'media', receiptId, proposalId: proposal.proposalId, approvalId: args.approvalId, sessionId: state.id, ownerId: state.ownerId,
        name, args: normalized, mode, callId, turnId, status: 'inflight', attempted: true, createdAt: now() };
      state.invocations[receiptId] = invocation;
      try { await persist(state, save); } catch (error) { delete state.invocations[receiptId]; throw error; }
      if (signal?.aborted) {
        invocation.status = 'cancelled'; invocation.attempted = false;
        invocation.result = safeError(new GuardError('cancelled', '用户已取消，未提交媒体请求。'));
        invocation.result.receiptId = receiptId;
        await persist(state, save); return clone(invocation.result);
      }
      let result;
      try {
        if (mode === 'simulation') result = { status: 'succeeded', simulated: true };
        else if (name === 'generate_video') result = await media.video({ prompt: normalized.prompt, duration: normalized.duration,
          ratio: normalized.ratio, resolution: normalized.resolution,
          ...(normalized.firstFrameId ? { firstFrameUrl: assetFor(state, normalized.firstFrameId, 'image').url } : {}) }, signal || new AbortController().signal);
        else result = await media.image({ prompt: name === 'edit_image' ? normalized.instruction : normalized.prompt, size: normalized.size,
          referenceImages: (name === 'edit_image' ? [normalized.imageId] : normalized.referenceImages || []).map(id => assetFor(state, id, 'image').url),
        }, signal || new AbortController().signal);
        invocation.providerResult = clone(result);
        if (!result || !['succeeded', 'queued', 'running', 'failed', 'cancelled', 'expired'].includes(result.status))
          throw Object.assign(new Error('供应商响应状态不明确；禁止自动重复提交。'), { uncertain: true });
        invocation.status = result.status;
        invocation.providerReceiptId = result.taskId || result.receiptId || null;
        if (result.status !== 'succeeded' && !invocation.providerReceiptId && !['failed', 'cancelled', 'expired'].includes(result.status))
          throw Object.assign(new Error('供应商未返回可查询回执；提交结果未知。'), { uncertain: true });
        invocation.result = { ok: !['failed', 'cancelled', 'expired'].includes(result.status), status: result.status, submitted: true,
          receiptId, providerReceiptId: invocation.providerReceiptId, simulated: mode === 'simulation',
          ...(result.status === 'succeeded' ? { assets: mediaAssets(state, invocation, result) } : {}),
          ...(result.status === 'failed' ? { error: { code: 'provider_failed', message: '供应商已接收但处理失败；可查询原回执，不能将其当作已交付。' } } : {}),
        };
      } catch (error) {
        if (typeof error.receiptId === 'string' && error.receiptId) invocation.providerReceiptId ||= error.receiptId;
        const knownRejected = error.uncertain === false || error.submitted === false;
        invocation.status = knownRejected ? 'rejected' : 'unknown';
        invocation.result = { ...safeError(error, knownRejected ? false : 'unknown'), status: invocation.status, receiptId,
          providerReceiptId: invocation.providerReceiptId || null, simulated: mode === 'simulation',
          retryable: false, message: knownRejected ? '原调用已记录为未提交；请根据错误修正方案并重新批准。' : '提交结果未知；仅可查询或人工核对，不会自动重提。' };
      }
      invocation.updatedAt = now();
      try { await persist(state, save); } catch {
        // The durable inflight record still prevents duplicate submission after restart.
        return { ok: false, status: 'unknown', submitted: invocation.result.submitted === false ? false : 'unknown', receiptId,
          error: { code: 'result_persistence_failed', message: '提交记录已保存，但结果保存失败；请查询原回执，不要重复生成。' } };
      }
      return clone(invocation.result);
    });
  }
  async function queryMedia(args, ctx) {
    return withSessionLock(ctx.state, async () => {
      const invocation = ctx.state.invocations[args.receiptId];
      if (!invocation || invocation.kind !== 'media' || invocation.ownerId !== ctx.state.ownerId || invocation.sessionId !== ctx.state.id)
        throw new GuardError('receipt_not_found', '回执不在当前会话范围；请先检索原始工具结果。');
      if (['succeeded', 'failed', 'expired', 'cancelled', 'rejected'].includes(invocation.status)) return receiptResult(ctx.state, invocation);
      const query = invocation.name === 'generate_video' ? media?.getVideo : media?.getImage;
      if (!invocation.providerReceiptId || typeof query !== 'function') return { ...receiptResult(ctx.state, invocation), status: 'unknown',
        message: '没有可用的供应商查询接口或回执；目前无法确认结果，不会重复提交。' };
      assertNotCancelled(ctx.signal);
      try {
        const result = await query.call(media, invocation.providerReceiptId, ctx.signal || new AbortController().signal);
        invocation.queries ||= [];
        invocation.queries.push({ at: now(), result: clone(result) });
        if (!result || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(result.status)) throw new Error('查询返回未知状态');
        const assets = result.status === 'succeeded' ? mediaAssets(ctx.state, invocation, result) : undefined;
        invocation.status = result.status;
        invocation.result = { ok: !['failed', 'cancelled', 'expired'].includes(result.status), status: result.status, submitted: true,
          receiptId: invocation.receiptId, providerReceiptId: invocation.providerReceiptId, simulated: false, ...(assets ? { assets } : {}) };
        invocation.updatedAt = now(); await persist(ctx.state, ctx.save);
        return clone(invocation.result);
      } catch (error) {
        return { ...safeError(error, true), status: 'unknown', receiptId: invocation.receiptId, providerReceiptId: invocation.providerReceiptId,
          message: '查询失败，不代表原提交失败；不会重新生成。' };
      }
    });
  }
  async function execute(name, args, ctx) {
    try {
      assertOwner(ctx?.state, ctx?.ownerId);
      const { state } = ctx;
      state.assets ||= {}; state.invocations ||= {}; state.approvals ||= {};
      const validate = validators.get(name);
      if (!validate) throw new GuardError('unknown_tool', `工具 ${name} 不可用；请使用实际注册的工具。`);
      if (!validate(args)) throw new GuardError('invalid_arguments', ajv.errorsText(validate.errors, { separator: '; ' }));
      assertNotCancelled(ctx.signal);
      if (mediaNames.has(name)) return await executeMedia(name, args, ctx);
      if (name === 'read_media_result') return await queryMedia(args, ctx);
      if (name === 'read_asset') {
        const asset = assetFor(state, args.id), start = args.offset || 0, width = args.limit || 12000;
        const content = typeof asset.content === 'string' ? asset.content : null;
        return { ok: true, asset: { ...clone(asset), ...(content !== null ? { content: content.slice(start, start + width) } : {}) },
          offset: start, totalLength: content?.length || 0, nextOffset: content !== null && start + width < content.length ? start + width : null,
          ...(asset.type === 'image' ? { observed: false, note: '这里只读取了图片身份和地址，未进行视觉观察。' } : {}) };
      }
      if (name === 'search_history') return { ok: true, ...searchHistory(state, args) };
      if (name === 'read_history') return { ok: true, ...readHistory(state, { limit: 12000, ...args }) };
      if (name === 'read_skill') {
        const result = await readAgentSkill(catalog, args.slug, args.reference, args.offset || 0);
        const { slug, reference, content, nextOffset, references, resources } = result;
        return { ok: true, slug, reference, content, nextOffset, references, resources,
          note: '这是专业方法原文，不是业务任务或事实证据。用户数量与保留要求优先；读取本身不是交付。' };
      }
      if (name === 'measure_text') return { ok: true, count: countBody(args.text, args.unit), unit: args.unit,
        scope: 'exact_supplied_body', convention: '去除Markdown的*、`、#；non_punctuation_characters另排除标点、空白和分隔符。' };
      if (name === 'analyze_image') {
        const imageIds = new Set(args.imageIds), comparisons = [];
        for (const id of args.imageIds) {
          const result = assetFor(state, id, 'image');
          if (result.parentId) {
            assetFor(state, result.parentId, 'image');
            imageIds.add(result.parentId);
            comparisons.push({ sourceId: result.parentId, resultId: id });
          }
        }
        const images = [...imageIds].map(id => {
          const asset = assetFor(state, id, 'image');
          if (asset.simulated || !asset.url) throw new GuardError('real_image_required', `图片 ${id} 是模拟产物或缺少实际文件，不能声称观察。`);
          return { id, url: publicMediaUrl(asset.url), version: asset.version };
        });
        const requestedMaterials = [...(args.materials || [])];
        const related = new Set(), coUploaded = new Set(), visited = new Set();
        const collect = id => {
          if (visited.has(id)) return;
          visited.add(id);
          const asset = assetFor(state, id);
          if (asset.type === 'text') related.add(id);
          else {
            for (const sourceId of asset.sourceIds || []) collect(sourceId);
            if (asset.parentId) collect(asset.parentId);
          }
        };
        for (const id of imageIds) collect(id);
        for (const record of state.records) if (record.kind === 'message' && record.role === 'user' && record.attachments?.some(a => visited.has(a.id))) {
          for (const attachment of record.attachments) if (state.assets[attachment.id]?.type === 'text' && !related.has(attachment.id)) coUploaded.add(attachment.id);
        }
        for (const sourceId of new Set([...related, ...coUploaded])) if (!requestedMaterials.some(m => m.sourceId === sourceId)) requestedMaterials.push({ sourceId, content: related.has(sourceId) ? '图片来源链中的文字原文；身份不升级为已核验事实。' : '同次上传的候选资料，可能描述其他商品；先核对对应对象，不能自动套用到当前图片。' });
        const materials = requestedMaterials.map(material => {
          if (!material.sourceId) return { content: material.content, origin: 'agent_supplied',
            ...(material.status ? { agentAnnotation: { status: material.status } } : {}) };
          const source = assetFor(state, material.sourceId);
          if (source.type !== 'text') throw new GuardError('asset_type_mismatch', 'materials.sourceId仅接受文字资料。图片请放入imageIds；保持验收须同时保留原图和成品，不要用文字描述替换原图后重试。');
          if (typeof source.content !== 'string') throw new GuardError('source_content_missing', `资料 ${source.id} 没有可读取原文。`);
          return { sourceId: source.id, content: source.content, version: source.version, origin: source.origin || 'stored_asset', provenance: 'stored_original',
            association: related.has(source.id) ? 'source_lineage' : coUploaded.has(source.id) ? 'co_upload_candidate' : 'agent_selected',
            agentAnnotation: { content: material.content, ...(material.status ? { status: material.status } : {}) } };
        });
        const observation = await observeImages({ images, question: args.question, materials, comparisons }, ctx.signal, ctx);
        if (!observation) throw new GuardError('empty_observation', '观察工具未返回内容；不能声称已经确认图片。');
        return { ok: true, imageIds: [...imageIds], question: args.question, materials: clone(materials), comparisons, observation,
          note: '已传入证据不代表验收通过。Agent须根据观察判断差异与用户保持要求；未知、推断和资料身份不可升级为事实。' };
      }
      if (name === 'save_document') return await withSessionLock(state, async () => {
        if (!ctx.callId || !ctx.turnId) throw new GuardError('call_identity_required', '保存正文需要调用和轮次身份。');
        const key = `document_${fingerprint([state.id, ctx.turnId, ctx.callId]).slice(0, 32)}`, digest = fingerprint(args);
        if (state.invocations[key]) {
          if (state.invocations[key].digest !== digest) throw new GuardError('call_identity_conflict', '同一次保存调用不能更换正文。');
          return { ok: true, asset: clone(state.assets[state.invocations[key].assetId]) };
        }
        let content = args.content;
        if (args.sourceMessageId) {
          if (args.parentId) throw new GuardError('invalid_arguments', '聊天原稿存档不同时指定parentId；先取得原稿asset.id，再另存修订。');
          const original = state.records.find(record => record.id === args.sourceMessageId && record.kind === 'message');
          if (!original) throw new GuardError('HISTORY_NOT_FOUND', '当前会话不存在这条原始消息。');
          if (typeof original.content === 'string') content = original.content;
          else if (Array.isArray(original.content) && original.content.every(part => ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string')) content = original.content.map(part => part.text).join('\n');
          else throw new GuardError('text_original_required', '原消息不是完整文字，请读取并选择实际文字原稿。');
          if (!content.trim()) throw new GuardError('text_original_required', '不能保存空白原稿。');
          if (args.content !== undefined && args.content !== content) throw new GuardError('original_content_mismatch', 'sourceMessageId存档必须与原文一致；修改请另存带parentId的修订。');
        }
        const parent = args.parentId ? assetFor(state, args.parentId, 'text') : null;
        const sourceIds = [...new Set([...(args.sourceIds || []), ...(parent ? [parent.id] : [])])];
        for (const id of sourceIds) assetFor(state, id);
        const existing = args.sourceMessageId && Object.values(state.assets).find(asset => asset.sourceMessageId === args.sourceMessageId && asset.origin === 'history_original');
        if (existing) {
          state.invocations[key] = { kind: 'document', assetId: existing.id, digest, turnId: ctx.turnId, callId: ctx.callId, createdAt: now() };
          try { await persist(state, ctx.save); } catch (error) { delete state.invocations[key]; throw error; }
          return { ok: true, asset: clone(existing), reused: true };
        }
        const asset = immutableAsset({ id: newId('doc'), type: 'text', content, title: args.title || '', ownerId: state.ownerId, origin: args.sourceMessageId ? 'history_original' : 'agent_output',
          ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId } : {}),
          version: parent ? parent.version + 1 : 1, ...(parent ? { parentId: parent.id } : {}), sourceIds, createdAt: now() });
        state.assets[asset.id] = asset; state.invocations[key] = { kind: 'document', assetId: asset.id, digest, turnId: ctx.turnId, callId: ctx.callId, createdAt: now() };
        try { await persist(state, ctx.save); } catch (error) { delete state.assets[asset.id]; delete state.invocations[key]; throw error; }
        return { ok: true, asset: clone(asset) };
      });
      throw new GuardError('unknown_tool', '工具没有实现。');
    } catch (error) { return safeError(error, error.submitted ?? false); }
  }
  async function executeBatch(calls, ctx) {
    // Preserve result order while limiting independent reads. Mutations remain locked per session.
    const results = new Array(calls.length); let next = 0;
    const workers = Math.max(1, Math.min(8, readConcurrency, calls.length));
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) { const index = next++; if (index >= calls.length) return;
        const call = calls[index]; results[index] = await execute(call.name, call.args ?? call.arguments, { ...ctx, callId: call.callId || call.call_id || call.id }); }
    }));
    return results;
  }
  return { definitions, execute, executeBatch };
}
