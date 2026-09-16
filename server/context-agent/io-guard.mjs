import { createHash, randomUUID } from 'node:crypto';

// These records describe actual tool attempts and exact approvals, not business tasks.
const locks = new Map();
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const newId = prefix => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export class GuardError extends Error {
  constructor(code, message) { super(message); this.code = code; this.submitted = false; }
}
export function assertOwner(state, ownerId) {
  if (!state || state.engine !== 'context-agent' || state.schemaVersion !== 1 || !state.id || !state.ownerId)
    throw new GuardError('invalid_session', '需要独立 context-agent 会话。');
  if (!ownerId || ownerId !== state.ownerId) throw new GuardError('forbidden', '不能访问其他用户的会话或素材。');
}
export async function withSessionLock(state, action) {
  const key = `${state.ownerId}:${state.id}`;
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  locks.set(key, tail);
  await previous.catch(() => {});
  try { return await action(); } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}
export async function persist(state, save) {
  if (typeof save !== 'function') throw new GuardError('persistence_required', '调用尚未提交：运行层必须提供持久保存能力。');
  await save(state);
}
export function assertNotCancelled(signal) {
  if (signal?.aborted) throw new GuardError('cancelled', '用户已取消；没有提交新的媒体调用。');
}
export function assertMediaBudget(state, turnId, maxMediaCalls = 0) {
  if (!turnId) throw new GuardError('turn_identity_required', '缺少当前轮次身份，不能提交。');
  const used = Object.values(state.invocations || {}).filter(x => x.kind === 'media' && x.turnId === turnId && x.attempted).length;
  if (!Number.isInteger(maxMediaCalls) || maxMediaCalls < 1 || used >= maxMediaCalls)
    throw new GuardError('media_budget_exceeded', `本轮媒体提交预算已用完（${used}/${maxMediaCalls || 0}）；需要调整运行额度后继续。`);
}
export function assetFor(state, id, type) {
  const asset = Object.hasOwn(state.assets || {}, id) && state.assets[id];
  if (!asset || (asset.ownerId && asset.ownerId !== state.ownerId)) throw new GuardError('asset_not_found', `素材 ${id} 不在当前会话可访问范围；请读取历史确认标识。`);
  if (type && asset.type !== type) throw new GuardError('asset_type_mismatch', `素材 ${id} 是 ${asset.type}，本次需要 ${type}；没有提交媒体请求。`);
  return asset;
}
export function createProposal(state, { name, args, callId, turnId, mode }) {
  if (!callId || !turnId) throw new GuardError('call_identity_required', '准备媒体方案需要 callId 和 turnId。');
  const proposalId = `proposal_${fingerprint([state.id, state.ownerId, turnId, callId]).slice(0, 32)}`;
  const digest = fingerprint({ name, args, mode });
  const existing = state.approvals[proposalId];
  if (existing) {
    if (existing.digest !== digest) throw new GuardError('call_identity_conflict', '同一次调用身份不能改换参数；修改方案请使用新调用。');
    return existing;
  }
  const proposal = { kind: 'proposal', proposalId, sessionId: state.id, ownerId: state.ownerId, name, args: structuredClone(args), digest, mode, callId, turnId, createdAt: now() };
  state.approvals[proposalId] = proposal;
  return proposal;
}
export function approvedProposal(state, { proposalId, approvalId, name, args, mode }) {
  const proposal = state.approvals[proposalId], approval = state.approvals[approvalId];
  if (!proposal || proposal.kind !== 'proposal' || !approval || approval.kind !== 'approval' || !approval.proposalIds.includes(proposalId)
    || [proposal, approval].some(x => x.ownerId !== state.ownerId || x.sessionId !== state.id))
    throw new GuardError('approval_required', '没有匹配当前会话具体方案的用户批准；请展示已保存方案并取得批准。');
  if (proposal.digest !== fingerprint({ name, args, mode }) || approval.digests[proposalId] !== proposal.digest)
    throw new GuardError('approval_parameters_changed', '参数、工具或执行模式已改变；旧批准不能复用，请重新准备并展示方案。');
  return proposal;
}
export async function approveProposals(state, { proposalIds, ownerId }, save) {
  assertOwner(state, ownerId);
  return withSessionLock(state, async () => {
    if (!Array.isArray(proposalIds) || !proposalIds.length || new Set(proposalIds).size !== proposalIds.length)
      throw new GuardError('invalid_approval', '请选择一组互不重复的具体媒体方案。');
    const proposals = proposalIds.map(id => {
      const proposal = state.approvals?.[id];
      if (!proposal || proposal.kind !== 'proposal' || proposal.ownerId !== ownerId || proposal.sessionId !== state.id)
        throw new GuardError('invalid_approval', '待批准方案不属于当前用户会话。');
      return proposal;
    });
    const approval = { kind: 'approval', approvalId: newId('approval'), sessionId: state.id, ownerId,
      proposalIds: [...proposalIds], digests: Object.fromEntries(proposals.map(p => [p.proposalId, p.digest])), approvedAt: now() };
    state.approvals[approval.approvalId] = approval;
    try { await persist(state, save); } catch (error) { delete state.approvals[approval.approvalId]; throw error; }
    return { approvalId: approval.approvalId, proposalIds: approval.proposalIds,
      proposals: proposals.map(({ proposalId, name, args }) => ({ proposalId, name, args: structuredClone(args) })), approvedAt: approval.approvedAt };
  });
}
