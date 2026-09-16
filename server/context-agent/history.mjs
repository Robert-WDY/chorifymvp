import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const clone = value => structuredClone(value);
const kinds = new Set(['message', 'tool_call', 'tool_result', 'run_event']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fileQueues = new Map();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function checkId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) fail('INVALID_SESSION_ID', 'Invalid session identifier.');
  return id;
}

function checkOwner(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 512) fail('INVALID_OWNER', 'A server-owned identity is required.');
  return ownerId;
}

export function createSession({ id = randomUUID(), ownerId = 'local' } = {}) {
  return { engine: 'context-agent', schemaVersion: 1, id: checkId(id), ownerId: checkOwner(ownerId), records: [], assets: {}, invocations: {}, approvals: {} };
}

function validateRecord(record) {
  if (!record || !kinds.has(record.kind) || typeof record.id !== 'string' || !record.id || typeof record.turnId !== 'string' || !record.turnId || typeof record.groupId !== 'string' || !record.groupId || !Number.isFinite(Date.parse(record.at))) fail('INVALID_HISTORY_RECORD', 'History records require an identity, time, turn and group.');
  if (record.kind === 'message' && (!['user', 'assistant'].includes(record.role) || !(typeof record.content === 'string' || Array.isArray(record.content)))) fail('INVALID_HISTORY_RECORD', 'Only original user and assistant messages may enter chat history.');
  if (record.kind === 'tool_call' && (typeof record.callId !== 'string' || !record.callId || typeof record.name !== 'string' || !record.name || typeof record.arguments !== 'string')) fail('INVALID_HISTORY_RECORD', 'Tool calls require a callId, name and raw JSON arguments.');
  if (record.kind === 'tool_result' && (typeof record.callId !== 'string' || !record.callId || typeof record.output !== 'string')) fail('INVALID_HISTORY_RECORD', 'Tool results require a callId and raw JSON output.');
}

function validateSession(state, ownerId) {
  checkOwner(ownerId);
  if (!state || state.engine !== 'context-agent' || state.schemaVersion !== 1 || !Array.isArray(state.records)) fail('INVALID_SESSION', 'This is not a context-agent session.');
  checkId(state.id);
  if (state.ownerId !== ownerId) fail('SESSION_ACCESS_DENIED', 'Session does not belong to the current owner.');
  const ids = new Set();
  for (const record of state.records) {
    validateRecord(record);
    if (ids.has(record.id)) fail('INVALID_HISTORY_RECORD', 'History record identifiers must be unique.');
    ids.add(record.id);
  }
}

/** Append a detached record. Persisted records can never be rewritten by save(). */
export function appendRecord(state, record) {
  if (!state || state.engine !== 'context-agent' || !Array.isArray(state.records)) fail('INVALID_SESSION', 'Expected a context-agent session.');
  const id = record.id ?? randomUUID();
  const value = clone({ ...record, id, at: record.at ?? new Date().toISOString(), turnId: record.turnId ?? id, groupId: record.groupId ?? id });
  validateRecord(value);
  if (state.records.some(entry => entry.id === id)) fail('DUPLICATE_HISTORY_RECORD', 'This history record already exists.');
  state.records.push(value);
  return clone(value);
}

/** Session files are partitioned by trusted owner identity; IDs never form arbitrary paths. */
export class HistoryStore {
  #directory;

  constructor(directory) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('History directory is required.');
    this.#directory = path.resolve(directory);
  }

  #file(id, ownerId) {
    checkId(id);
    const owner = createHash('sha256').update(checkOwner(ownerId)).digest('hex');
    return path.join(this.#directory, owner, `${id}.json`);
  }

  async create(ownerId = 'local') {
    const state = createSession({ ownerId });
    await this.save(state, ownerId);
    return state;
  }

  async load(id, ownerId = 'local') {
    const file = this.#file(id, ownerId);
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') fail('SESSION_NOT_FOUND', 'Session was not found for the current owner.');
      throw error;
    }
    validateSession(state, ownerId);
    return state;
  }

  async save(state, ownerId = 'local') {
    // Snapshot at invocation time so caller mutation cannot affect the atomic write.
    const snapshot = clone(state);
    validateSession(snapshot, ownerId);
    const file = this.#file(snapshot.id, ownerId);
    const prior = fileQueues.get(file) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      let existing;
      try { existing = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        validateSession(existing, ownerId);
        if (snapshot.records.length < existing.records.length || existing.records.some((record, index) => JSON.stringify(record) !== JSON.stringify(snapshot.records[index]))) fail('HISTORY_REWRITE_FORBIDDEN', 'Existing raw history cannot be changed or removed; reload the latest session before appending.');
      }
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return clone(snapshot);
    });
    fileQueues.set(file, pending);
    try { return await pending; }
    finally { if (fileQueues.get(file) === pending) fileQueues.delete(file); }
  }
}

function recordText(record) {
  const content = record.kind === 'message' ? record.content : record.kind === 'tool_result' ? record.output : record.kind === 'tool_call' ? record.arguments : record;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function integer(value, fallback, maximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) fail('INVALID_HISTORY_QUERY', `${label} is outside the supported range.`);
  return resolved;
}

function timestamp(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('INVALID_HISTORY_QUERY', 'History time boundaries must be valid timestamps.');
  return parsed;
}

export function searchHistory(state, { query = '', limit = 10, before, after } = {}) {
  if (typeof query !== 'string') fail('INVALID_HISTORY_QUERY', 'History query must be text.');
  const maximum = integer(limit, 10, 50, 'limit');
  const upper = timestamp(before, Infinity);
  const lower = timestamp(after, -Infinity);
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matches = [];
  const calls = new Map(state.records.filter(record => record.kind === 'tool_call').map(record => [record.callId, record.name]));
  for (const record of state.records) {
    // Request/response traces repeat chat text and would crowd out its source.
    // Runtime records remain directly addressable by their exact identifier.
    if (query.trim() !== record.id && !isMemoryRecord(record, calls)) continue;
    const time = Date.parse(record.at);
    if (time >= upper || time <= lower) continue;
    const raw = recordText(record);
    const searchable = `${record.id} ${record.kind} ${record.name ?? ''} ${raw}`.toLocaleLowerCase();
    if (!words.every(word => searchable.includes(word))) continue;
    const position = words.length ? Math.max(0, raw.toLocaleLowerCase().indexOf(words[0])) : 0;
    const offset = Math.max(0, position - 100);
    matches.push({ messageId: record.id, id: record.id, kind: record.kind, ...(record.role ? { role: record.role } : {}), at: record.at, turnId: record.turnId, groupId: record.groupId, excerpt: raw.slice(offset, offset + 600), offset, length: raw.length, ...(record.assetIds ? { assetIds: clone(record.assetIds) } : {}), ...(record.attachments ? { attachments: clone(record.attachments) } : {}) });
  }
  return { matches: matches.reverse().slice(0, maximum), totalMatches: matches.length };
}

// Retrieval is a view of original evidence, not a search through prior searches.
// Exact IDs can still recover every persisted record, including debug traces.
function isMemoryRecord(record, calls) {
  if (record.kind === 'run_event') return false;
  const name = record.kind === 'tool_call' ? record.name : calls.get(record.callId);
  return !['search_history', 'read_history'].includes(name);
}

export function readHistory(state, { messageId, surroundingRange = 0, offset, limit } = {}) {
  if (typeof messageId !== 'string' || !messageId) fail('INVALID_HISTORY_QUERY', 'A history record identifier is required.');
  const index = state.records.findIndex(record => record.id === messageId);
  if (index < 0) fail('HISTORY_NOT_FOUND', 'History record was not found in this session.');
  const surrounding = integer(surroundingRange, 0, 20, 'surroundingRange');
  const calls = new Map(state.records.filter(record => record.kind === 'tool_call').map(record => [record.callId, record.name]));
  const visible = state.records.filter(record => record.id === messageId || isMemoryRecord(record, calls));
  const position = visible.findIndex(record => record.id === messageId);
  const records = clone(visible.slice(Math.max(0, position - surrounding), position + surrounding + 1));
  let pagination = null;
  if (offset !== undefined || limit !== undefined) {
    const target = records.find(record => record.id === messageId);
    const field = target.kind === 'tool_result' ? 'output' : target.kind === 'tool_call' ? 'arguments' : target.kind === 'message' && typeof target.content === 'string' ? 'content' : '$record';
    const start = integer(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const size = integer(limit, 12000, 100000, 'limit');
    if (!size) fail('INVALID_HISTORY_QUERY', 'Pagination limit must be positive.');
    const raw = field === '$record' ? JSON.stringify(target) : target[field];
    if (field !== '$record') target[field] = raw.slice(start, start + size);
    else if (start > 0 || raw.length > size) {
      const recordIndex = records.findIndex(record => record.id === messageId);
      records[recordIndex] = { id: target.id, at: target.at, kind: target.kind, turnId: target.turnId, groupId: target.groupId, rawJsonExcerpt: raw.slice(start, start + size), notice: 'Raw JSON page of the original record; retrieve every page to reconstruct it.' };
    }
    const hasMore = start + size < raw.length;
    pagination = { field, offset: start, limit: size, totalLength: raw.length, hasMore, nextOffset: hasMore ? start + size : null };
  }
  return { messageId, records, pagination };
}
