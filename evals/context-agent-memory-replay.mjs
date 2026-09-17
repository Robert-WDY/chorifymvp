// Offline input/schema replay only: never runs a model, observation or media provider.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { loadAgentCatalog as loadCatalog } from '../server/context-agent/skills.mjs';
import { createTools } from '../server/context-agent/tools.mjs';
import { createSession, readHistory } from '../server/context-agent/history.mjs';
import { buildContext, estimateTokens } from '../server/context-agent/context.mjs';

const [traceRoot, output = 'evaluations/2026-09-16-context-agent-memory-repair'] = process.argv.slice(2);
if (!traceRoot) throw new Error('Usage: node evals/context-agent-memory-replay.mjs <shared-trace-root> [output-directory]');
const catalog = await loadCatalog();
const prompt = await readFile(new URL('../server/context-agent/prompt.md', import.meta.url), 'utf8');
const forbidden = () => { throw new Error('Offline replay must not call a provider'); };
const tools = createTools({ catalog, mode: 'live', media: { image: forbidden }, observeImages: forbidden });
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map(tools.definitions.map(t => [t.name, ajv.compile(t.parameters)]));
const summary = { kind: 'offline_input_and_schema_replay', realModelRuns: 0, providerCalls: 0, sessions: 0, wireCalls: 0, wirePassed: 0, wireFailures: [], projections: [], memoryReads: [] };
await mkdir(output, { recursive: true });
const redact = value => {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"'<>\\]+/g, '[URL_REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(apiKey|api_key|authorization|token|secret|password)$/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
};
const selected = new Set(['USER_STYLE_01', 'USER_STYLE_06', 'QA_001', 'MT_TASK_001', 'IMG_MULTI_001']);
for (const entry of await readdir(traceRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let state;
  try { state = JSON.parse((await readFile(path.join(traceRoot, entry.name, 'session.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  summary.sessions++;
  for (const record of state.records.filter(r => r.kind === 'tool_call')) {
    summary.wireCalls++;
    const validate = validators.get(record.name);
    if (validate && validate(JSON.parse(record.arguments))) summary.wirePassed++;
    else summary.wireFailures.push({ case: entry.name, name: record.name, callId: record.callId, errors: validate?.errors ?? 'unregistered_tool' });
    if (record.name === 'read_history') {
      const previous = createSession({ id: state.id, ownerId: state.ownerId });
      previous.records = state.records.slice(0, state.records.indexOf(record));
      const old = state.records.find(r => r.kind === 'tool_result' && r.callId === record.callId);
      if (!old) continue;
      const args = JSON.parse(record.arguments);
      const next = { ok: true, ...readHistory(previous, { limit: 12000, ...args }) };
      summary.memoryReads.push({ case: entry.name, beforeCharacters: old.output.length, afterCharacters: JSON.stringify(next).length,
        beforeKinds: JSON.parse(old.output).records?.map(r => r.event ?? r.kind), afterKinds: next.records.map(r => r.event ?? r.kind),
        targetRetained: next.records.some(r => r.id === args.messageId), originalRecordsUnchanged: JSON.stringify(previous.records) === JSON.stringify(state.records.slice(0, state.records.indexOf(record))) });
    }
  }
  if (!selected.has(entry.name)) continue;
  const requests = state.records.filter(r => r.event === 'model_request' && r.phase === 'agent');
  const request = entry.name === 'MT_TASK_001' || entry.name === 'USER_STYLE_06' ? requests.at(-1) : requests[0];
  if (!request) continue;
  // Reconstruct the recorded point in time. Never expose assets created later.
  const before = createSession({ id: state.id, ownerId: state.ownerId });
  before.records = state.records.slice(0, state.records.indexOf(request));
  for (const item of request.input) {
    if (typeof item.content !== 'string' || !item.content.startsWith('Context reference data')) continue;
    const data = JSON.parse(item.content.split('\n')[1]);
    for (const asset of data.assetDirectory ?? []) {
      if (!state.assets[asset.id]) throw new Error(`Missing archived asset: ${asset.id}`);
      before.assets[asset.id] = state.assets[asset.id];
    }
  }
  const next = buildContext(before, { systemPrompt: prompt, skillDirectory: catalog.skills, toolDefinitions: tools.definitions, currentTurnId: request.turnId, tokenBudget: 24000, reservedTokens: 6000 });
  const file = `${entry.name}-input-projection.json`;
  await writeFile(path.join(output, file), JSON.stringify(redact({ case: entry.name, notice: 'Before is an archived real request. After is a local input reconstruction, not a new model response. Earlier tool results are historical and were not re-executed. URLs redacted for sharing.', before: request.input, after: next.input }), null, 2) + '\n');
  summary.projections.push({ case: entry.name, file,
    beforeEstimatedInputTokens: estimateTokens(request.input), afterEstimatedInputTokens: next.metrics.estimatedInputTokens,
    beforeFixedCountInCatalog: request.input.some(r => typeof r.content === 'string' && r.content.startsWith('Context reference data') && r.content.includes('2–3')),
    afterFixedCountInCatalog: next.input.some(r => typeof r.content === 'string' && r.content.startsWith('Context reference data') && r.content.includes('2–3')),
    afterOmittedRecords: next.metrics.omittedRecords });
}
await writeFile(path.join(output, 'offline-replay.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (summary.wireFailures.length) process.exitCode = 1;
