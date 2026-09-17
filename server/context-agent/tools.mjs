import Ajv from 'ajv';
import { readAgentSkill } from './skills.mjs';
import {approveAndExecute,proposalDisplay,unavailableProposal} from './confirmation.mjs';
import { estimateTokens } from './context.mjs';
import { countBody } from '../text-measure.mjs';
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
const stripApproval = args => Object.fromEntries(Object.entries(args).filter(([key]) => !['proposalId', 'approvalId','replacesProposalId'].includes(key)));
const immutableAsset = asset => Object.freeze({ ...asset, sourceIds: Object.freeze([...(asset.sourceIds || [])]) });
const clone = value => structuredClone(value);

export function createTools({ catalog = { skills: [] }, media, observeImages, mode = 'simulation', observationTokenBudget = 16000 } = {}) {
  if (!['simulation', 'live'].includes(mode)) throw new Error('Unknown media mode');
  if (!Number.isInteger(observationTokenBudget) || observationTokenBudget < 1) throw new Error('Invalid observation budget');
  const materials = { type: 'array', maxItems: 20, items: schema({ content: string(100000), sourceId: id, status: { enum: ['user_provided','verified','unknown','assumption','creative_hypothesis'] }, offset, limit }, []) };
  materials.items.anyOf = [{ required: ['content'] }, { required: ['sourceId'] }];
  const definitions = [
    tool('list_assets', '分页检索当前会话资产目录；不读取正文。query可按名称或准确ID查找历史资产。', { query: { type: 'string', maxLength: 500 }, type: { enum: ['text','image','video'] }, offset, limit: { type:'integer',minimum:1,maximum:50 } }),
    tool('read_approval', '分页读取本会话真实批准记录；指定proposalId可读取保存的完整参数，指定approvalId可查看该批准下的方案。', { approvalId:id, proposalId:id, offset, limit:{type:'integer',minimum:1,maximum:20} }),
    tool('confirm_media', '仅根据本轮真实用户明确授权选择已展示的方案ID，一次确认并提交。否定、引用、仅选创意、附带修改或候选不明确时不要调用；不得默认批准全部。', {proposalIds:{...ids,minItems:1}}, ['proposalIds']),
    tool('execute_approved', '提交已批准的具体媒体调用；服务端恢复保存参数并检查用户、会话、模式、摘要和幂等。无需重抄参数，不允许新增参数。', { proposalId:id, approvalId:id }, ['proposalId','approvalId']),
    tool('read_asset', '读取本会话准确素材原文或文件元数据。图片URL不是视觉观察；长文用nextOffset继续读取。', { id, offset, limit }, ['id']),
    tool('search_history', '检索本会话原话及原始工具证据，排除检索回声和调试Trace；准确记录ID仍可定位任何原记录。', { query: {type:'string',maxLength:2000}, cursor:offset, order:{enum:['oldest','latest']}, maxChars:{type:'integer',minimum:2000,maximum:50000}, limit: { type: 'integer', minimum: 1, maximum: 50 }, before: string(80), after: string(80) }),
    tool('read_history', '按ID读取原记录及去除检索回声、调试Trace的前后文；按offset/limit分页，原文不变。', { messageId: id, surroundingRange: { type: 'integer', minimum: 0, maximum: 20 }, offset, limit, maxChars:{type:'integer',minimum:2000,maximum:50000} }, ['messageId']),
    tool('read_skill', '按需读取专业方法和参考原文；不创建任务、不自动安排流程。', { slug: string(100), reference: string(400), offset }, ['slug']),
    tool('save_document', '需要独立文稿、版本管理或修改已有文稿资产时保存准确正文。简单聊天创作和改稿可直接回复，由对话历史保存。新稿传content；已有资产修订传content和原稿parentId。聊天稿需要保存修订时传parentMessageId和新content，一次原子保存原稿及修订；sourceMessageId仅原样存档。', { content: string(500000), title: string(500), parentId: id, sourceMessageId: id, parentMessageId: id, sourceIds: ids }),
    tool('measure_text', '按现有统一口径测量传入正文，不含未传入的标题或说明；不替代内容判断。', { text: { type: 'string', maxLength: 500000 }, unit: { enum: ['characters', 'non_punctuation_characters'] } }, ['text', 'unit']),
  ];
  definitions.find(def => def.name === 'save_document').parameters.anyOf = [{ required: ['content'] }, { required: ['sourceMessageId'] }];
  if (typeof observeImages === 'function') {
    definitions.push(tool('analyze_image', '仅观察明确选择的imageIds与materials，不自动加父图或其他资料。比较保持请用compare_images。大段资料请显式指定offset/limit。', { imageIds: { ...ids, minItems: 1 }, question: string(12000), materials }, ['imageIds','question']));
    definitions.push(tool('compare_images', '比较明确指定的真实原图与成品，逐项报告差异和无法判断项，不自行扩展来源。', { sourceImageId:id, resultImageId:id, question:string(12000), materials }, ['sourceImageId','resultImageId','question']));
  }
  if (mode === 'simulation' || typeof media?.image === 'function') {
    definitions.push(tool('generate_image', '每次仅准备一张图片的具体参数并请求批准；文字确认用confirm_media，已有批准恢复用execute_approved。referenceImages必须是本会话图片ID。', {
      prompt: string(16000), size, referenceImages: ids, sourceIds: ids, replacesProposalId:id,
    }, ['prompt', 'size']));
    definitions.push(tool('edit_image', '编辑一张准确原图，自动记录父版本。首次调用准备方案；文字确认用confirm_media，已有批准恢复用execute_approved。', {
      imageId: id, instruction: string(16000), size, sourceIds: ids, replacesProposalId:id,
    }, ['imageId', 'instruction']));
  }
  if (mode === 'simulation' || typeof media?.video === 'function') definitions.push(tool('generate_video', '准备一段视频的具体参数；取得对应方案批准后才提交。处理中返回可查询回执，不自动建立后台业务任务。', {
    prompt: string(16000), duration: { type: 'integer', minimum: 1, maximum: 20 }, ratio: { enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
    resolution: { enum: ['480p', '720p', '1080p'] }, firstFrameId: id, sourceIds: ids, replacesProposalId:id,
  }, ['prompt', 'duration', 'ratio', 'resolution']));
  definitions.push(tool('read_media_result', '查询本会话已提交调用的receiptId；不会再次生成。没有供应商查询能力时如实返回unknown。', { receiptId: id }, ['receiptId']));
  if (mode === 'simulation') for (const definition of definitions.filter(def => mediaNames.has(def.name))) definition.description = '当前仅模拟，不会生成真实媒体。' + definition.description;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const publicValidators = new Map(definitions.map(def => [def.name, ajv.compile(def.parameters)]));
  const validators = new Map(definitions.map(def => [def.name, ajv.compile(mediaNames.has(def.name)?{...def.parameters,properties:{...def.parameters.properties,...approvalFields}}:def.parameters)]));

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
        const proposal = createProposal(state, { name, args: normalized, mode, callId, turnId,executionIdentity:media?.executionIdentity||null,sourceBindings:Object.fromEntries(sourcesFor(name,normalized).map(id=>[id,sourceIdentity(assetFor(state,id))])),replacesProposalId:args.replacesProposalId });
        await persist(state, save);
        return { ok: true, status: 'approval_required', submitted: false, proposalId: proposal.proposalId, turnId: proposal.turnId, name, args: clone(proposal.args), simulated: mode === 'simulation',
          message: '具体方案已保存，尚未生成。请向用户展示同组全部方案；收到服务端批准后才可提交。' };
      }
      validateFrozen(args.proposalId,state);
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
  function sourceIdentity(asset){return fingerprint({id:asset.id,type:asset.type,version:asset.version,content:asset.content,identity:asset.sha256||asset.contentHash||asset.url||null,simulated:asset.simulated||false});}
  function validateFrozen(id,state){
    const proposal=state.approvals[id];
    if(!proposal||proposal.kind!=='proposal'||proposal.ownerId!==state.ownerId||proposal.sessionId!==state.id||!validators.has(proposal.name))throw new GuardError('approval_required','没有可执行方案');
    if(unavailableProposal(state,id))throw new GuardError('proposal_withdrawn','方案已撤回或被替代');
    if(proposal.mode!==mode||fingerprint(proposal.executionIdentity||null)!==fingerprint(media?.executionIdentity||null))throw new GuardError('approval_parameters_changed','模式或模型配置变化，需要重新展示方案');
    for(const [id,binding]of Object.entries(proposal.sourceBindings||{}))if(sourceIdentity(assetFor(state,id))!==binding)throw new GuardError('approval_parameters_changed','参考素材内容或版本已变化，需要新方案');
    if(proposal.digest!==fingerprint({name:proposal.name,args:proposal.args,mode}))throw new GuardError('approval_parameters_changed','保存参数已变化');
    return proposal;
  }
  async function executeFrozen(args,ctx){const p=validateFrozen(args.proposalId,ctx.state);return executeMedia(p.name,{...clone(p.args),...args},ctx);}
  const confirm=(args,ctx)=>approveAndExecute(args,ctx,{executeFrozen,validateFrozen});
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
      const validate = (ctx.fromModel?publicValidators:validators).get(name);
      if (!validate) throw new GuardError('unknown_tool', `工具 ${name} 不可用；请使用实际注册的工具。`);
      if (!validate(args)) throw new GuardError('invalid_arguments', ajv.errorsText(validate.errors, { separator: '; ' }));
      assertNotCancelled(ctx.signal);
      if (name === 'list_assets') {
        const query = (args.query || '').toLocaleLowerCase(), start = args.offset || 0, width = args.limit || 20;
        const assets = Object.values(state.assets).filter(a => (!a.ownerId || a.ownerId === state.ownerId) && (!args.type || a.type === args.type) && (!query || [a.id,a.title,a.name].some(v => String(v || '').toLocaleLowerCase().includes(query))));
        return { ok:true, total:assets.length, assets:assets.slice(start,start+width).map(({id,type,title,name,version,parentId,sourceMessageId})=>({id,type,title,name,version,parentId,sourceMessageId})), nextOffset:start+width<assets.length?start+width:null };
      }
      if (name === 'read_approval') {
        const records = Object.values(state.approvals).filter(a => a.ownerId === state.ownerId && a.sessionId === state.id);
        if (args.proposalId) {
          const proposal = records.find(a => a.kind === 'proposal' && a.proposalId === args.proposalId);
          if (!proposal) throw new GuardError('approval_not_found','方案不在当前会话');
          if (args.approvalId && !records.some(a => a.approvalId === args.approvalId && a.proposalIds?.includes(proposal.proposalId))) throw new GuardError('approval_not_found','批准不包含指定方案');
          return { ok:true, proposal:clone(proposal),...proposalDisplay(state,proposal.proposalId) };
        }
        const receipts = records.filter(a => a.kind === 'approval' && (!args.approvalId || a.approvalId === args.approvalId));
        if (args.approvalId && !receipts.length) throw new GuardError('approval_not_found','批准不在当前会话');
        const entries = receipts.flatMap(a => a.proposalIds.map(proposalId => ({approvalId:a.approvalId,proposalId,name:state.approvals[proposalId]?.name,...proposalDisplay(state,proposalId)})));
        if(!args.approvalId)entries.push(...records.filter(p=>p.kind==='proposal'&&!receipts.some(a=>a.proposalIds.includes(p.proposalId))).map(p=>({proposalId:p.proposalId,name:p.name,...proposalDisplay(state,p.proposalId)})));
        const start=args.offset||0,width=args.limit||20;
        return {ok:true,entries:entries.slice(start,start+width),total:entries.length,nextOffset:start+width<entries.length?start+width:null};
      }
      if (name === 'confirm_media') return await confirm(args,ctx);
      if (name === 'execute_approved') {
        const proposal = state.approvals[args.proposalId];
        if (!proposal || proposal.ownerId !== state.ownerId || proposal.sessionId !== state.id || !mediaNames.has(proposal.name) || !validators.has(proposal.name)) throw new GuardError('approval_required','当前会话没有可执行的对应方案');
        return await executeMedia(proposal.name, { ...clone(proposal.args), ...args }, ctx);
      }
      if (mediaNames.has(name)) return await executeMedia(name, args, ctx);
      if (name === 'read_media_result') return await queryMedia(args, ctx);
      if (name === 'read_asset') {
        const asset = assetFor(state, args.id), start = args.offset || 0, width = args.limit || 12000;
        const content = typeof asset.content === 'string' ? asset.content : null;
        const related=[...(asset.parentId?[{id:asset.parentId,relation:'parent'}]:[]),...(asset.sourceIds||[]).filter(id=>id!==asset.parentId).map(id=>({id,relation:'source'}))];
        const relatedAvailable=related.filter(r=>state.assets[r.id]&&(!state.assets[r.id].ownerId||state.assets[r.id].ownerId===state.ownerId)).slice(0,8).map(r=>({...r,type:state.assets[r.id].type,version:state.assets[r.id].version,read:false}));
        return { ok: true,relatedAvailable,relatedTotal:related.length, asset: { ...clone(asset), ...(content !== null ? { content: content.slice(start, start + width) } : {}) },
          offset: start, totalLength: content?.length || 0, nextOffset: content !== null && start + width < content.length ? start + width : null,
          ...(asset.type === 'image' ? { observed: false, note: '这里只读取了图片身份和地址，未进行视觉观察。' } : {}) };
      }
      if (name === 'search_history') return { ok: true, ...searchHistory(state, args) };
      if (name === 'read_history') {
        const record=state.records.find(r=>r.id===args.messageId);
        const view=record?.traceRef&&typeof state.readTrace==='function'?{...state,records:state.records.slice()}:state;
        if(view!==state)view.records[state.records.indexOf(record)]=await state.readTrace(record.id);
        return {ok:true,...readHistory(view,{limit:12000,...args})};
      }
      if (name === 'read_skill') {
        const result = await readAgentSkill(catalog, args.slug, args.reference, args.offset || 0);
        const { slug, version, reference, content, nextOffset, references, resources } = result;
        return { ok: true, slug, version, reference, content, nextOffset, references, resources,
          note: '这是专业方法原文，不是业务任务或事实证据。用户数量与保留要求优先；读取本身不是交付。' };
      }
      if (name === 'measure_text') return { ok: true, count: countBody(args.text, args.unit), unit: args.unit,
        scope: 'exact_supplied_body', convention: '去除Markdown的*、`、#；non_punctuation_characters另排除标点、空白和分隔符。' };
      if (name === 'analyze_image' || name === 'compare_images') {
        const imageIds = name === 'compare_images' ? [args.sourceImageId,args.resultImageId] : args.imageIds;
        if (name === 'compare_images' && args.sourceImageId === args.resultImageId) throw new GuardError('distinct_images_required','比较需要两张不同的真实图片');
        const images = imageIds.map(id => {
          const asset = assetFor(state,id,'image');
          if (asset.simulated || !asset.url) throw new GuardError('real_image_required',`图片 ${id} 缺少真实文件`);
          return {id,url:publicMediaUrl(asset.url),version:asset.version};
        });
        const selectedMaterials = (args.materials || []).map(material => {
          if (!material.sourceId) return {content:material.content,origin:'agent_supplied',agentAnnotation:{status:material.status}};
          const source = assetFor(state,material.sourceId);
          if(source.type!=='text')throw new GuardError('asset_type_mismatch','materials.sourceId仅接受文字；图片放imageIds，比较请用compare_images明确选定原图与成品。');
          if (typeof source.content !== 'string') throw new GuardError('source_content_missing','资料没有可读正文');
          const start=material.offset||0,end=material.limit===undefined?source.content.length:start+material.limit;
          return {sourceId:source.id,version:source.version,content:source.content.slice(start,end),origin:source.origin||'stored_asset',
            provenance:start===0&&end>=source.content.length?'stored_original':'stored_excerpt',offset:start,totalLength:source.content.length,
            nextOffset:end<source.content.length?end:null,agentAnnotation:{content:material.content,status:material.status}};
        });
        const comparisons = name === 'compare_images' ? [{sourceId:args.sourceImageId,resultId:args.resultImageId}] : [];
        const estimatedInputTokens=estimateTokens({question:args.question,materials:selectedMaterials,comparisons})+images.length*2048+1000;
        if (estimatedInputTokens>observationTokenBudget) return {ok:false,submitted:false,error:{code:'observation_budget_exceeded',message:'所选资料超过观察输入预算；请选择必要来源或显式offset/limit后重试，不会静默裁剪。'},estimatedInputTokens,budget:observationTokenBudget,
          materials:selectedMaterials.map(m=>({sourceId:m.sourceId,totalLength:m.totalLength,offset:m.offset})),imageIds};
        const observation = await observeImages({images,question:args.question,materials:selectedMaterials,comparisons},ctx.signal,ctx);
        if (!observation) throw new GuardError('empty_observation','观察没有返回内容');
        return {ok:true,imageIds,question:args.question,materials:selectedMaterials,comparisons,estimatedInputTokens,observation,
          note:'观察仅覆盖明确选择的证据。Agent负责判断差异、未知项及用户要求是否满足；传入证据不代表验收通过。'};
      }
      if (name === 'save_document') return await withSessionLock(state, async () => {
        if (!ctx.callId || !ctx.turnId) throw new GuardError('call_identity_required', '保存正文需要调用和轮次身份。');
        const key = `document_${fingerprint([state.id, ctx.turnId, ctx.callId]).slice(0, 32)}`, digest = fingerprint(args);
        if (state.invocations[key]) {
          if (state.invocations[key].digest !== digest) throw new GuardError('call_identity_conflict', '同一次保存调用不能更换正文。');
          return { ok: true, asset: clone(state.assets[state.invocations[key].assetId]) };
        }
        if (args.parentMessageId && (args.parentId || args.sourceMessageId || !args.content)) throw new GuardError('invalid_arguments','聊天修订只传parentMessageId和修改正文，不混用其他原稿入口');
        let archivedParent;
        if (args.parentMessageId) {
          const original=state.records.find(r=>r.id===args.parentMessageId&&r.kind==='message');
          if (!original || typeof original.content!=='string' || !original.content.trim()) throw new GuardError('HISTORY_NOT_FOUND','当前会话没有可修订的完整文字原稿');
          archivedParent=Object.values(state.assets).find(a=>a.sourceMessageId===original.id&&a.origin==='history_original');
          if (!archivedParent) archivedParent=immutableAsset({id:newId('doc'),type:'text',content:original.content,title:'原始聊天文稿',ownerId:state.ownerId,origin:'history_original',sourceMessageId:original.id,version:1,sourceIds:[],createdAt:now()});
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
        const parent = archivedParent || (args.parentId ? assetFor(state, args.parentId, 'text') : null);
        const sourceIds = [...new Set([...(args.sourceIds || []), ...(parent ? [parent.id] : [])])];
        for (const id of sourceIds) if (id !== archivedParent?.id) assetFor(state, id);
        const existing = args.sourceMessageId && Object.values(state.assets).find(asset => asset.sourceMessageId === args.sourceMessageId && asset.origin === 'history_original');
        if (existing) {
          state.invocations[key] = { kind: 'document', assetId: existing.id, digest, turnId: ctx.turnId, callId: ctx.callId, createdAt: now() };
          try { await persist(state, ctx.save); } catch (error) { delete state.invocations[key]; throw error; }
          return { ok: true, asset: clone(existing), reused: true };
        }
        const asset = immutableAsset({ id: newId('doc'), type: 'text', content, title: args.title || '', ownerId: state.ownerId, origin: args.sourceMessageId ? 'history_original' : 'agent_output',
          ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId } : {}),
          version: parent ? parent.version + 1 : 1, ...(parent ? { parentId: parent.id } : {}), sourceIds, createdAt: now() });
        const newParent=archivedParent&&!state.assets[archivedParent.id];
        if(newParent)state.assets[archivedParent.id]=archivedParent;
        state.assets[asset.id] = asset; state.invocations[key] = { kind: 'document', assetId: asset.id, digest, turnId: ctx.turnId, callId: ctx.callId, createdAt: now() };
        try { await persist(state, ctx.save); } catch (error) { delete state.assets[asset.id]; if(newParent)delete state.assets[archivedParent.id]; delete state.invocations[key]; throw error; }
        return { ok: true, asset: clone(asset) };
      });
      throw new GuardError('unknown_tool', '工具没有实现。');
    } catch (error) { return safeError(error, error.submitted ?? false); }
  }
  return { definitions, execute, approveAndExecute:confirm };
}
