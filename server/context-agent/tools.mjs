import Ajv from 'ajv';
import { readAgentSkill } from './skills.mjs';
import {approveAndExecute,proposalDisplay,unavailableProposal} from './confirmation.mjs';
import { estimateTokens } from './context.mjs';
import { publicMediaUrl } from '../media.mjs';
import { searchHistory, readHistory } from './history.mjs';
import {interactions,prepareInteraction} from './interactions.mjs';
import {selectOriginal,documentReceipt,originalMessageText} from './document-source.mjs';
import {measureDelivery,checkedDocument} from './delivery-check.mjs';
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
    tool('inspect_workspace', '查询本会话真实选中素材、本轮附件、注册工具及媒体模式，返回可读入口；不观察图片，不查询供应商余额或健康。能查到的资料先查，不把未知配置猜成余额不足。', {}),
    tool('request_user_input', '仅在必要的配置选择或多字段回答时发布问题并暂停；普通偏好可合理设计，不必提问。返回只表示发布成功，用户未回答；内容选择绝不批准媒体。不得收集密码、密钥或支付凭据。已有对象选项须绑定resource真实ID。', {
      message:string(1000),questions:{type:'array',minItems:1,maxItems:3,items:schema({key:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_]{0,39}$'},label:string(300),allowFreeText:{type:'boolean'},options:{type:'array',maxItems:8,items:schema({id:string(80),label:string(200),resource:schema({kind:{enum:['asset','proposal']},id,version:{type:'integer',minimum:1}},['kind','id'])},['id','label'])}},['key','label','allowFreeText'])}
    },['message','questions']),
    tool('list_assets', '分页检索当前会话资产目录；不读取正文。query可按名称或准确ID查找历史资产。', { query: { type: 'string', maxLength: 500 }, type: { enum: ['text','image','video'] }, offset, limit: { type:'integer',minimum:1,maximum:50 } }),
    tool('read_approval', '分页读取本会话真实批准记录；指定proposalId可读取保存的完整参数，指定approvalId可查看该批准下的方案。', { approvalId:id, proposalId:id, offset, limit:{type:'integer',minimum:1,maximum:20} }),
    tool('confirm_media', '仅根据本轮真实用户明确授权选择已展示的方案ID，一次确认并提交。否定、引用、仅选创意、附带修改或候选不明确时不要调用；不得默认批准全部。', {proposalIds:{...ids,minItems:1}}, ['proposalIds']),
    tool('execute_approved', '提交已批准的具体媒体调用；服务端恢复保存参数并检查用户、会话、模式、摘要和幂等。无需重抄参数，不允许新增参数。', { proposalId:id, approvalId:id }, ['proposalId','approvalId']),
    tool('read_asset', '读取本会话准确素材原文或文件元数据。图片URL不是视觉观察；长文用nextOffset继续读取。', { id, offset, limit }, ['id']),
    tool('search_history', '检索本会话原话及原始工具证据，排除检索回声和调试Trace；准确记录ID仍可定位任何原记录。', { query: {type:'string',maxLength:2000}, cursor:offset, order:{enum:['oldest','latest']}, maxChars:{type:'integer',minimum:2000,maximum:50000}, limit: { type: 'integer', minimum: 1, maximum: 50 }, before: string(80), after: string(80) }),
    tool('read_history', '按准确记录ID读取原文及前后文；当前完整原文已可见时不重复读取。按nextOffset继续offset/limit分页，检索命中和摘要不等于完整原稿；排除检索回声及调试Trace。', { messageId: id, surroundingRange: { type: 'integer', minimum: 0, maximum: 20 }, offset, limit, maxChars:{type:'integer',minimum:2000,maximum:50000} }, ['messageId']),
    tool('read_skill', '按需读取专业方法和参考原文；不创建任务、不自动安排流程。', { slug: string(100), reference: string(400), offset }, ['slug']),
    tool('save_document', '独立文稿或版本管理才保存。新稿传content；修订传原稿parentId或parentMessageId、新content，并用sourceText给出准确原稿正文供核对。聊天消息混有指令/解释时，sourceText只选连续作品正文，原消息仍完整保留。sourceMessageId仅存档，sourceText可指定准确片段；省略时兼容整条消息归档。保存后核对parentEvidence实际正文，不能只按标题宣称保留了原稿。', { content: string(500000), title: string(500), parentId: id, sourceMessageId: id, parentMessageId: id, sourceText:string(500000), sourceIds: ids }),
    tool('measure_text', 'requirements用于声明本轮最终交付要求，重测不能放宽已有要求；临时片段只作普通测量。明确字数/数量时传requirements及完整text；字数只算正文可用bodyText指定text中的准确连续正文。数量用items划分所有交付项，必须items以两个换行拼接后等于完整text，备选也计入。通过后最终回答原样输出text，修改或追加需重测。语义项如何划分仍由Agent负责；没有requirements时仅测量。', { text: { type: 'string', maxLength: 500000 }, unit: { enum: ['characters', 'non_punctuation_characters'] },bodyText:string(500000),items:{type:'array',minItems:1,maxItems:100,items:string(500000)},requirements:{...schema({min:{type:'integer',minimum:0},max:{type:'integer',minimum:0},itemCount:{type:'integer',minimum:1,maximum:100}},[]),minProperties:1} }, ['text', 'unit']),
  ];
  definitions.find(def => def.name === 'save_document').parameters.anyOf = [{ required: ['content'] }, { required: ['sourceMessageId'] }];
  const documentSchema=definitions.find(d=>d.name==='save_document').parameters;
  Object.assign(documentSchema.properties,{parentVersion:{type:'integer',minimum:1},measurementCallId:id});
  const measurement=definitions.find(d=>d.name==='measure_text');
  Object.assign(measurement.parameters.properties,{
    target:schema({kind:{enum:['reply','document']},id:string(120)},['kind']),
    assetId:id,assetVersion:{type:'integer',minimum:1},
    correction:schema({callId:id,messageId:id,quote:string(30000),reason:string(1000)},['callId','messageId','quote','reason'])
  });
  measurement.parameters.required=['unit'];measurement.parameters.anyOf=[{required:['text']},{required:['assetId','assetVersion']}];
  measurement.parameters.properties.text.description='完整交付文字；新稿必传，bodyText不能代替。';
  measurement.parameters.properties.bodyText.description='text中唯一的连续正文，保留格式，排除标题/说明；可省略。';
  documentSchema.properties.measurementCallId={...id,description:'仅绑定deliveryCheck.status=passed的验收回执，content必须等于该次完整text。普通计数不属于验收，不需要本字段；保存动作本身不要求先测字数。'};
  measurement.description='requirements检查字数/项数，省略则仅计数。target默认完整reply，多份成果各用稳定id；文稿用document。已存稿可用assetId+assetVersion。items双换行拼接须覆盖text。重测沿用target；误声明用correction引用最新测量callId、本轮用户messageId、原话quote及reason。Agent仍负责语义划分。';
  definitions.find(d=>d.name==='save_document').description='需要独立文稿或版本才保存，不要求先测字数。新稿传content；已有资产修订用parentId+parentVersion，不重抄父稿，但先确认完整原文可用；聊天原稿用parentMessageId+sourceText准确作品片段。sourceMessageId仅存档。通过requirements验收的作品传measurementCallId，content等于该次完整text；普通计数没有验收凭证。核对回执parentEvidence实际父稿，不只信标题。';
  if (typeof observeImages === 'function') {
    definitions.push(tool('analyze_image', '仅观察明确选择的imageIds与materials，不自动加父图或同次上传资料。materials.sourceId只接受文字ID，图片放imageIds。必要产品事实和未知项通过materials传入；大段资料指定offset/limit。比较保持用compare_images。', { imageIds: { ...ids, minItems: 1 }, question: string(12000), materials }, ['imageIds','question']));
    definitions.push(tool('compare_images', '读取明确指定的真实原图与成品双图，比较结构、颜色、位置和用户保持要求，报告差异与无法判断项。不自行扩展来源，不用文字替代原图；看不清、缺图或模拟产物不能声称通过，差异不能擅称为更好的创意。', { sourceImageId:id, resultImageId:id, question:string(12000), materials }, ['sourceImageId','resultImageId','question']));
  }
  if (mode === 'simulation' || typeof media?.image === 'function') {
    definitions.push(tool('generate_image', '准备图片方案：本次调用只保存一张图片的具体参数，不提交生成，无需预先批准。用户要图片或先看方案时可直接调用；普通风格缺失可合理设定。多张独立图分别准备后一起展示。实际生成须批准后用confirm_media，已有批准恢复用execute_approved。referenceImages只能用本会话图片ID。', {
      prompt: string(16000), size, referenceImages: ids, sourceIds: ids, replacesProposalId:id,
    }, ['prompt', 'size']));
    definitions.push(tool('edit_image', '准备图片修改方案：绑定准确imageId与修改/保持要求，本次只保存参数，无需预先批准，不提交生成。批准后执行自动记录原图父版本。文字批准用confirm_media；改已有方案用replacesProposalId并重新展示。', {
      imageId: id, instruction: string(16000), size, sourceIds: ids, replacesProposalId:id,
    }, ['imageId', 'instruction']));
  }
  if (mode === 'simulation' || typeof media?.video === 'function') definitions.push(tool('generate_video', '准备视频方案：本次只保存一段视频的具体参数，无需预先批准，不提交生成；展示后须取得对应方案批准才提交。处理中按已有回执查询，不自动建立后台业务任务。', {
    prompt: string(16000), duration: { type: 'integer', minimum: 1, maximum: 20 }, ratio: { enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
    resolution: { enum: ['480p', '720p', '1080p'] }, firstFrameId: id, sourceIds: ids, replacesProposalId:id,
  }, ['prompt', 'duration', 'ratio', 'resolution']));
  definitions.push(tool('read_media_result', '按本会话receiptId查询已有提交，处理中或提交未知都先查回执，不重新生成代替查询。无供应商查询能力时返回unknown。outcome是操作结果，submission是提交状态；truncated时按rawResultRef回读，resultRefs是产物入口。批次not_executed尚未提交，成功项保留。', { receiptId: id }, ['receiptId']));
  if (mode === 'simulation') for (const definition of definitions.filter(def => mediaNames.has(def.name))) definition.description = '当前仅模拟，不会生成真实媒体。' + definition.description;
  for(const d of definitions.filter(d=>['analyze_image','compare_images'].includes(d.name))){
    d.parameters.properties.contextNote=string(1000);
    d.description+=' 关联文字资料是候选而非默认事实；明确选materials，无相关材料时用空数组及contextNote说明。';
  }
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
      const visualIds=name==='edit_image'?[normalized.imageId]:name==='generate_video'?[normalized.firstFrameId].filter(Boolean):normalized.referenceImages||[];
      if(ctx.fromModel&&(normalized.sourceIds||[]).some(id=>assetFor(state,id).type==='image'&&!visualIds.includes(id)))throw new GuardError('visual_source_not_bound','sourceIds只记录来源。选中的图片未作为视觉输入；请明确放入referenceImages、imageId或firstFrameId，不能仅登记来源后生成');
      if (!args.proposalId && !args.approvalId) {
        const proposal = createProposal(state, { name, args: normalized, mode, callId, turnId,executionIdentity:media?.executionIdentity||null,sourceBindings:Object.fromEntries(sourcesFor(name,normalized).map(id=>[id,sourceIdentity(assetFor(state,id))])),replacesProposalId:args.replacesProposalId });
        await persist(state, save);
        return { ok: true, status: 'approval_required', submitted: false, proposalId: proposal.proposalId, turnId: proposal.turnId, name, args: clone(proposal.args), simulated: mode === 'simulation',
          inputEvidence:{visualSources:visualIds.map(id=>({id,version:state.assets[id].version})),textSources:(normalized.sourceIds||[]).filter(id=>state.assets[id].type==='text'),textSourceMeaning:'provenance_only; necessary facts and constraints must be expressed in prompt/instruction'},
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
      if(name==='inspect_workspace'){
        const latest=[...state.records].reverse().find(r=>r.kind==='message'&&r.role==='user');
        const refs=ids=>ids.map(id=>{const a=assetFor(state,id);return {id:a.id,type:a.type,version:a.version,name:a.name||a.title,read:{tool:'read_asset',id:a.id}};});
        return {ok:true,selectedAssets:refs((latest?.workspace?.selectedAssets||[]).map(a=>a.id)),attachments:refs((latest?.attachments||[]).map(a=>a.id)),registeredTools:definitions.map(t=>t.name),mediaMode:mode,providerHealth:'unknown',providerBalance:'unknown',pendingQuestions:interactions(state).filter(i=>i.status==='pending'),resources:{assets:'list_assets',proposals:'read_approval',receipts:'read_media_result'},note:'注册及配置不保证供应商可用；本返回不是视觉观察或媒体批准。'};
      }
      if(name==='request_user_input')return {ok:true,status:'awaiting_user',submitted:false,interaction:prepareInteraction(state,args)};
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
      if (name === 'measure_text') {
        let measured=args;
        if(args.assetId){const a=assetFor(state,args.assetId,'text');
          if(a.version!==args.assetVersion)throw new GuardError('asset_version_mismatch','测量对象版本已变化');
          if(args.text!==undefined&&args.text!==a.content)throw new GuardError('original_content_mismatch','测量正文不是该保存版本');
          measured={...args,text:a.content,target:{kind:'document',id:a.id}};
        }
        return { ok: true, ...measureDelivery(measured,ctx),
        scope: 'exact_supplied_body', convention: '去除Markdown的*、`、#；non_punctuation_characters另排除标点、空白和分隔符。' };
      }
      if (name === 'analyze_image' || name === 'compare_images') {
        const imageIds = name === 'compare_images' ? [args.sourceImageId,args.resultImageId] : args.imageIds;
        const candidates=new Set(imageIds.flatMap(id=>state.assets[id]?.sourceIds||[]).filter(id=>state.assets[id]?.type==='text'));
        for(const message of state.records.filter(r=>r.kind==='message'&&r.role==='user'&&r.attachments?.some(a=>imageIds.includes(a.id))))for(const a of message.attachments)if(state.assets[a.id]?.type==='text')candidates.add(a.id);
        if(ctx.fromModel&&candidates.size&&(!Array.isArray(args.materials)||(!args.materials.length&&!args.contextNote?.trim())))return {ok:false,submitted:false,error:{code:'observation_context_required',message:'存在关联或同次上传的文字候选。请明确选择相关materials；若均无关，传materials:[]及contextNote说明，不自动套用其他商品资料。'},materialCandidates:[...candidates].map(id=>({id,name:state.assets[id].name||state.assets[id].title,version:state.assets[id].version,association:'candidate_not_verified'}))};
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
          return documentReceipt(state,state.assets[state.invocations[key].assetId]);
        }
        if(args.parentVersion!==undefined&&(!args.parentId||assetFor(state,args.parentId,'text').version!==args.parentVersion))throw new GuardError('asset_version_mismatch','父版本不一致；回读准确对象后修订');
        if(ctx.fromModel&&(args.parentId||args.parentMessageId)&&args.sourceText===undefined&&!(args.parentId&&args.parentVersion!==undefined))throw new GuardError('source_text_required','已有资产修订须parentId+parentVersion；聊天修订须parentMessageId+sourceText准确片段。先确认原文可用，不按标签猜父稿');
        if (args.parentMessageId && (args.parentId || args.sourceMessageId || !args.content)) throw new GuardError('invalid_arguments','聊天修订只传parentMessageId和修改正文，不混用其他原稿入口');
        if(args.sourceText!==undefined&&!args.parentMessageId&&!args.sourceMessageId&&!args.parentId)throw new GuardError('invalid_arguments','sourceText必须绑定原始消息或父资产');
        let archivedParent;
        if (args.parentMessageId) {
          const original=state.records.find(r=>r.id===args.parentMessageId&&r.kind==='message');
          if (!original) throw new GuardError('HISTORY_NOT_FOUND','当前会话没有这条原始消息');
          const selected=selectOriginal(originalMessageText(original.content),args.sourceText);
          archivedParent=Object.values(state.assets).find(a=>a.sourceMessageId===original.id&&a.origin==='history_original'&&a.content===selected.content);
          if (!archivedParent) archivedParent=immutableAsset({id:newId('doc'),type:'text',...selected,title:'原始聊天文稿',ownerId:state.ownerId,origin:'history_original',sourceMessageId:original.id,version:1,sourceIds:[],createdAt:now()});
        }
        let content = args.content,sourceRange;
        if (args.sourceMessageId) {
          if (args.parentId) throw new GuardError('invalid_arguments', '聊天原稿存档不同时指定parentId；先取得原稿asset.id，再另存修订。');
          const original = state.records.find(record => record.id === args.sourceMessageId && record.kind === 'message');
          if (!original) throw new GuardError('HISTORY_NOT_FOUND', '当前会话不存在这条原始消息。');
          content=originalMessageText(original.content);
          if (!content.trim()) throw new GuardError('text_original_required', '不能保存空白原稿。');
          const selected=selectOriginal(content,args.sourceText);content=selected.content;sourceRange=selected.sourceRange;
          if (args.content !== undefined && args.content !== content) throw new GuardError('original_content_mismatch', 'sourceMessageId存档必须与原文一致；修改请另存带parentId的修订。');
        }
        const parent = archivedParent || (args.parentId ? assetFor(state, args.parentId, 'text') : null);
        if(args.measurementCallId)checkedDocument(state,ctx.turnId,args.measurementCallId,content);
        if(args.parentId&&args.sourceText!==undefined&&selectOriginal(parent.content,args.sourceText).content!==parent.content)throw new GuardError('original_content_mismatch','已有资产修订需核对完整父稿正文；局部修改范围写在新正文中，不裁掉父版本');
        const sourceIds = [...new Set([...(args.sourceIds || []), ...(parent ? [parent.id] : [])])];
        for (const id of sourceIds) if (id !== archivedParent?.id) assetFor(state, id);
        const existing = args.sourceMessageId && Object.values(state.assets).find(asset => asset.sourceMessageId === args.sourceMessageId && asset.origin === 'history_original'&&asset.content===content);
        if (existing) {
          state.invocations[key] = { kind: 'document', assetId: existing.id, digest, turnId: ctx.turnId, callId: ctx.callId, createdAt: now() };
          try { await persist(state, ctx.save); } catch (error) { delete state.invocations[key]; throw error; }
          return {...documentReceipt(state,existing),reused:true};
        }
        const asset = immutableAsset({ id: newId('doc'), type: 'text', content, title: args.title || '', ownerId: state.ownerId, origin: args.sourceMessageId ? 'history_original' : 'agent_output',
          ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId,...(sourceRange?{sourceRange}: {}) } : {}),
          version: parent ? parent.version + 1 : 1, ...(parent ? { parentId: parent.id } : {}), sourceIds, createdAt: now() });
        const newParent=archivedParent&&!state.assets[archivedParent.id];
        if(newParent)state.assets[archivedParent.id]=archivedParent;
        state.assets[asset.id] = asset; state.invocations[key] = { kind: 'document', assetId: asset.id, digest, turnId: ctx.turnId, callId: ctx.callId, createdAt: now() };
        try { await persist(state, ctx.save); } catch (error) { delete state.assets[asset.id]; if(newParent)delete state.assets[archivedParent.id]; delete state.invocations[key]; throw error; }
        return documentReceipt(state,asset);
      });
      throw new GuardError('unknown_tool', '工具没有实现。');
    } catch (error) { return safeError(error, error.submitted ?? false); }
  }
  return { definitions, execute, approveAndExecute:confirm };
}
