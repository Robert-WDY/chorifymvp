import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, stat, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const clone = value => structuredClone(value);
const kinds = new Set(['message', 'tool_call', 'tool_result', 'system_observation', 'run_event']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fileQueues = new Map();
const immutable = new WeakSet(), serialized = new WeakMap();
const serializedAssets = new WeakMap();
function freeze(value) {
  if (value && typeof value === 'object' && !immutable.has(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value); immutable.add(value);
  }
  return value;
}
const digest = text => createHash('sha256').update(text).digest('hex');
function pack(record) {
  if (immutable.has(record) && serialized.has(record)) return serialized.get(record);
  validateRecord(record);
  let body=record, trace;
  if (record.kind==='run_event' && ['model_request','model_response'].includes(record.event) && !record.traceRef) {
    trace=JSON.stringify(record);
    body=Object.fromEntries(['id','at','turnId','groupId','kind','event','traceId','phase'].filter(k=>record[k]!==undefined).map(k=>[k,record[k]]));
    body.traceRef={recordId:record.id};
  }
  const json=JSON.stringify(body), result={id:record.id,json,hash:digest(json),trace};
  if(immutable.has(record))serialized.set(record,result);
  return result;
}

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
  return { engine: 'context-agent', schemaVersion: 1, id: checkId(id), ownerId: checkOwner(ownerId), records: [], assets: {}, invocations: {}, approvals: {}, summaries: {} };
}

function validateRecord(record) {
  if (!record || !kinds.has(record.kind) || typeof record.id !== 'string' || !record.id || typeof record.turnId !== 'string' || !record.turnId || typeof record.groupId !== 'string' || !record.groupId || !Number.isFinite(Date.parse(record.at))) fail('INVALID_HISTORY_RECORD', 'History records require an identity, time, turn and group.');
  if (record.kind === 'message' && (!['user', 'assistant'].includes(record.role) || !(typeof record.content === 'string' || Array.isArray(record.content)))) fail('INVALID_HISTORY_RECORD', 'Only original user and assistant messages may enter chat history.');
  if (record.kind === 'tool_call' && (typeof record.callId !== 'string' || !record.callId || typeof record.name !== 'string' || !record.name || typeof record.arguments !== 'string')) fail('INVALID_HISTORY_RECORD', 'Tool calls require a callId, name and raw JSON arguments.');
  if (record.kind === 'tool_result' && (typeof record.callId !== 'string' || !record.callId || typeof record.output !== 'string')) fail('INVALID_HISTORY_RECORD', 'Tool results require a callId and raw JSON output.');
  if (record.kind === 'system_observation' && (record.callId!==undefined || typeof record.name!=='string' || typeof record.output!=='string' || !record.source)) fail('INVALID_HISTORY_RECORD','System observations require an actual operation and confirmation source, without a fabricated call ID.');
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
  state.records.push(freeze(value));
  return clone(value);
}

/** SQLite is a storage adapter only: no business tasks or scheduling state.
 * Separate append-only record/trace rows and stable asset rows replace snapshot rewrites.
 * Every save is a FULL synchronous transaction before a provider may be submitted.
 */
export class HistoryStore {
  #directory;
  #versions=new WeakMap();
  constructor(directory) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('History directory is required.');
    this.#directory = path.resolve(directory);
  }
  #file(id, ownerId) {
    checkId(id);
    const owner=createHash('sha256').update(checkOwner(ownerId)).digest('hex');
    return path.join(this.#directory,owner,`${id}.sqlite`);
  }
  #open(file, create=false) {
    const db=new DatabaseSync(file,{readOnly:!create});
    if(create)db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id));`);
    return db;
  }
  #attach(state) {
    Object.defineProperty(state,'readTrace',{enumerable:false,value:recordId=>this.readTrace(state.id,state.ownerId,recordId)});
    return state;
  }
  async create(ownerId='local') {
    const state=this.#attach(createSession({ownerId}));
    await this.save(state,ownerId);return state;
  }
  async load(id,ownerId='local') {
    const file=this.#file(id,ownerId);
    let db;
    try { await stat(file); }
    catch(error) {
      if(error.code!=='ENOENT')throw error;
      // Non-destructive migration: the legacy JSON remains available as a backup.
      let state;
      try { state=JSON.parse(await readFile(file.replace(/\.sqlite$/,'.json'),'utf8')); }
      catch(legacyError) { if(legacyError.code==='ENOENT')fail('SESSION_NOT_FOUND','Session was not found for the current owner.');throw legacyError; }
      validateSession(state,ownerId);await this.save(state,ownerId);return this.load(id,ownerId);
    }
    db=this.#open(file);
    try {
      const identity=JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get('identity')?.value || 'null');
      if(!identity||identity.id!==id||identity.ownerId!==ownerId)fail('SESSION_ACCESS_DENIED','Stored session identity does not match');
      const state=createSession({id,ownerId});
      state.records=db.prepare('SELECT json FROM records ORDER BY seq').all().map(r=>freeze(JSON.parse(r.json)));
      for(const row of db.prepare('SELECT kind,id,json FROM objects').all())state[row.kind][row.id]=row.kind==='assets'?freeze(JSON.parse(row.json)):JSON.parse(row.json);
      validateSession(state,ownerId);this.#versions.set(state,Number(db.prepare('SELECT value FROM meta WHERE key=?').get('revision')?.value||0));return this.#attach(state);
    } finally { db.close(); }
  }
  async readTrace(id,ownerId,recordId) {
    const db=this.#open(this.#file(id,ownerId));
    try {
      const identity=JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get('identity')?.value || 'null');
      if(identity?.ownerId!==ownerId||identity?.id!==id)fail('SESSION_ACCESS_DENIED','Trace owner mismatch');
      const row=db.prepare('SELECT json FROM traces WHERE id=?').get(recordId);
      if(!row)fail('HISTORY_NOT_FOUND','Trace not found in this session');
      return JSON.parse(row.json);
    } finally { db.close(); }
  }
  async exportSession(id,ownerId='local') {
    const state=await this.load(id,ownerId);
    const records=[];
    for(const record of state.records)records.push(record.traceRef?await this.readTrace(id,ownerId,record.id):clone(record));
    return {...state,records};
  }
  async save(state,ownerId='local') {
    checkOwner(ownerId);checkId(state?.id);
    if(state?.engine!=='context-agent'||state.schemaVersion!==1||!Array.isArray(state.records))fail('INVALID_SESSION','Expected context-agent session');
    if(state.ownerId!==ownerId)fail('SESSION_ACCESS_DENIED','Session does not belong to current owner');
    // Capture only append candidates + object values. Immutable record serialization
    // is cached; large trace payloads are never repeatedly cloned or rewritten.
    const rows=state.records.map(pack);
    const ids=new Set(rows.map(r=>r.id));
    if(ids.size!==rows.length)fail('INVALID_HISTORY_RECORD','Duplicate record identities');
    const objects=[];
    for(const value of Object.values(state.summaries||{})) validateSummary(state,value);
    for(const kind of ['assets','invocations','approvals','summaries'])for(const [id,value]of Object.entries(state[kind]||{})) {
      let packed=kind==='assets'&&serializedAssets.get(value);
      if(!packed){const json=JSON.stringify(value);packed={json,hash:digest(json)};if(kind==='assets'){freeze(value);serializedAssets.set(value,packed);}}
      objects.push({kind,id,...packed});
    }
    const file=this.#file(state.id,ownerId), identity=JSON.stringify({id:state.id,ownerId});
    const previous=fileQueues.get(file)||Promise.resolve();
    const pending=previous.catch(()=>{}).then(async()=>{
      await mkdir(path.dirname(file),{recursive:true,mode:0o700});
      const db=this.#open(file,true);
      try {
        await chmod(file,0o600);
        db.exec('BEGIN IMMEDIATE');
        const stored=db.prepare('SELECT value FROM meta WHERE key=?').get('identity');
        if(stored&&stored.value!==identity)fail('SESSION_ACCESS_DENIED','Stored identity mismatch');
        const prior=db.prepare('SELECT seq,id,hash FROM records ORDER BY seq').all();
        if(prior.length>rows.length||prior.some((r,i)=>r.id!==rows[i].id||r.hash!==rows[i].hash))fail('HISTORY_REWRITE_FORBIDDEN','Existing history cannot be changed or removed');
        const revision=Number(db.prepare('SELECT value FROM meta WHERE key=?').get('revision')?.value||0);
        if(revision && this.#versions.get(state)!==revision)fail('STALE_SESSION','Reload the session before modifying stored execution records');
        const insert=db.prepare('INSERT INTO records(seq,id,hash,json) VALUES(?,?,?,?)');
        const trace=db.prepare('INSERT INTO traces(id,json) VALUES(?,?)');
        let bytesWritten=0;
        for(let i=prior.length;i<rows.length;i++){
          const r=rows[i];if(r.trace){trace.run(r.id,r.trace);bytesWritten+=Buffer.byteLength(r.trace);}
          insert.run(i,r.id,r.hash,r.json);bytesWritten+=Buffer.byteLength(r.json);
        }
        const old=new Map(db.prepare('SELECT kind,id,hash FROM objects').all().map(r=>[`${r.kind}:${r.id}`,r.hash]));
        const upsert=db.prepare('INSERT INTO objects(kind,id,hash,json) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET hash=excluded.hash,json=excluded.json');
        for(const o of objects){const key=`${o.kind}:${o.id}`;if(old.has(key)&&old.get(key)!==o.hash&&o.kind!=='invocations')fail('IMMUTABLE_OBJECT','Saved assets and approvals cannot be rewritten');if(old.get(key)!==o.hash){upsert.run(o.kind,o.id,o.hash,o.json);bytesWritten+=Buffer.byteLength(o.json);}old.delete(key);}
        // Durable execution/approval/asset evidence must not disappear in stale snapshots.
        if(old.size)fail('HISTORY_REWRITE_FORBIDDEN','Stored objects cannot be removed');
        db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run('identity',identity);
        db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('revision',String(revision+1));
        db.exec('COMMIT');this.#versions.set(state,revision+1);
        return {id:state.id,records:rows.length,appendedRecords:rows.length-prior.length,payloadBytesWritten:bytesWritten};
      }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
      finally{db.close();}
    });
    fileQueues.set(file,pending);
    try{return await pending;}finally{if(fileQueues.get(file)===pending)fileQueues.delete(file);}
  }
}

function recordText(record) {
  const content = record.kind === 'message' ? record.content : ['tool_result','system_observation'].includes(record.kind) ? record.output : record.kind === 'tool_call' ? record.arguments : record;
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

export function searchHistory(state, { query = '', limit = 10, before, after, cursor, order='latest', maxChars=16000 } = {}) {
  if (typeof query !== 'string') fail('INVALID_HISTORY_QUERY', 'History query must be text.');
  const maximum = integer(limit, 10, 50, 'limit');
  const upper = timestamp(before, Infinity);
  const lower = timestamp(after, -Infinity);
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matches = [];
  const calls = new Map(state.records.filter(record => record.kind === 'tool_call').map(record => [record.callId, record.name]));
  if(!['oldest','latest'].includes(order))fail('INVALID_HISTORY_QUERY','Unknown history order');
  if(cursor!==undefined)integer(cursor,0,Number.MAX_SAFE_INTEGER,'cursor');
  for (const [seq,record] of state.records.entries()) {
    if(cursor!==undefined&&(order==='oldest'?seq<=cursor:seq>=cursor))continue;
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
    matches.push({ seq,messageId: record.id, id: record.id, kind: record.kind, ...(record.role ? { role: record.role } : {}), at: record.at, turnId: record.turnId, groupId: record.groupId, excerpt: raw.slice(offset, offset + 600), offset, length: raw.length,...(record.attachments?{attachments:record.attachments.slice(0,12).map(a=>({id:a.id,type:a.type,name:a.name?.slice(0,100),version:a.version}))}:{}) });
  }
  const sorted=order==='latest'?matches.reverse():matches, selected=[];
  const budget=integer(maxChars,16000,50000,'maxChars');
  if(budget<2000)fail('INVALID_HISTORY_QUERY','maxChars must be at least 2000');
  for(const match of sorted.slice(0,maximum)) {
    let projected=match;
    if(!selected.length&&JSON.stringify(match).length>budget-400){const {attachments,...rest}=match;projected={...rest,excerpt:match.excerpt.slice(0,200),attachmentsOmitted:Boolean(attachments),readMore:{messageId:match.id}};}
    if(JSON.stringify([...selected,projected]).length>budget-400)break;
    selected.push(projected);
  }
  return {matches:selected,totalMatches:matches.length,order,nextCursor:selected.length<sorted.length?selected.at(-1)?.seq??null:null};
}

// Retrieval is a view of original evidence, not a search through prior searches.
// Exact IDs can still recover every persisted record, including debug traces.
function isMemoryRecord(record, calls) {
  if (record.kind === 'run_event') return false;
  const name = record.kind === 'tool_call' ? record.name : calls.get(record.callId);
  return !['search_history', 'read_history'].includes(name);
}

export function readHistory(state, { messageId, surroundingRange = 0, offset=0, limit=12000, maxChars=24000 } = {}) {
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
    const field = ['tool_result','system_observation'].includes(target.kind) ? 'output' : target.kind === 'tool_call' ? 'arguments' : target.kind === 'message' && typeof target.content === 'string' ? 'content' : '$record';
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
  const budget=integer(maxChars,24000,50000,'maxChars');
  if(budget<2000)fail('INVALID_HISTORY_QUERY','maxChars must be at least 2000');
  const target=records.find(r=>r.id===messageId), omittedSurrounding=[];
  const result={messageId,seq:index,records:[target],pagination,omittedSurrounding};
  // Bound the entire serialized response, including escaped text and neighbors.
  while(JSON.stringify(result).length>budget-(surrounding?900:100)){
    const field=target.rawJsonExcerpt!==undefined?'rawJsonExcerpt':pagination.field;
    if(typeof target[field]!=='string'||target[field].length<2)fail('HISTORY_BUDGET_EXCEEDED','Record metadata exceeds the read budget');
    target[field]=target[field].slice(0,Math.floor(target[field].length*0.75));
    pagination.hasMore=true;pagination.nextOffset=pagination.offset+target[field].length;
    pagination.limit=target[field].length;
  }
  for(const neighbor of records.filter(r=>r.id!==messageId)){
    if(JSON.stringify({...result,records:[...result.records,neighbor]}).length<=budget-1800)result.records.push(neighbor);
    else {
      const seq=state.records.findIndex(r=>r.id===neighbor.id);
      if(omittedSurrounding.length<4)omittedSurrounding.push({messageId:neighbor.id,seq});
      result.surroundingContinuation??={fromSeq:seq,toSeq:seq,readMore:{tool:'search_history',arguments:{query:'',order:'oldest',...(seq>0?{cursor:seq-1}:{})}}};
      result.surroundingContinuation.toSeq=seq;
    }
  }
  result.records.sort((a,b)=>state.records.findIndex(r=>r.id===a.id)-state.records.findIndex(r=>r.id===b.id));
  return result;
}

// SQLite seq is the immutable append position, never a projected context index.
export function summarySourceHash(state,from,to){return digest(JSON.stringify(state.records.slice(from,to+1).map(r=>pack(r).hash)));}
export function currentSummary(state){return Object.values(state.summaries||{}).sort((a,b)=>b.coveredToSeq-a.coveredToSeq)[0]||null;}
/** Compatibility copy only. Always retain the unmodified full export beside it. */
export function baselineSnapshot(full){
  const {summaries,...state}=clone(full);
  state.records=state.records.map(r=>r.kind==='system_observation'?{...r,kind:'run_event',event:'system_observation_compat',originalKind:'system_observation'}:r);
  return state;
}
export function validateSummary(state,summary){
  const {coveredFromSeq:from,coveredToSeq:to}=summary;
  if(summary.kind!=='session_summary'||summary.schemaVersion!==1||summary.sessionId!==state.id||!summary.summaryId||!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>=state.records.length||typeof summary.summaryText!=='string'||!summary.summaryText.trim()||summary.generatorVersion!=='session-summary-v1')fail('INVALID_SUMMARY','Invalid summary identity or coverage');
  if(summary.sourceHash!==summarySourceHash(state,from,to))fail('INVALID_SUMMARY','Summary source hash does not match original records');
  const previous=summary.previousSummaryId?state.summaries?.[summary.previousSummaryId]:null;
  if(summary.previousSummaryId?(!previous||previous.coveredToSeq+1!==from):from!==0)fail('INVALID_SUMMARY','Invalid summary chain');
  if(!Array.isArray(summary.sourceRefs)||summary.sourceRefs.length>64)fail('INVALID_SUMMARY','Summary references must be bounded');
  const range=state.records.slice(from,to+1), text=JSON.stringify(range.filter(r=>r.kind!=='run_event'));
  for(const ref of summary.sourceRefs){
    if(previous?.sourceRefs.some(r=>JSON.stringify(r)===JSON.stringify(ref)))continue;
    if(ref.kind==='asset'){
      const asset=state.assets[ref.id];
      if(!asset||(asset.ownerId&&asset.ownerId!==state.ownerId)||asset.version!==ref.version||!text.includes(ref.id))fail('INVALID_SUMMARY','Asset reference is outside summary evidence');
    }else if(!range.some(r=>r.kind!=='run_event'&&r.id===ref.id&&r.kind===ref.kind))fail('INVALID_SUMMARY','Record reference is outside summary evidence');
  }
  return summary;
}
