import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSession, appendRecord, searchHistory, readHistory } from '../server/context-agent/history.mjs';
import { buildContext } from '../server/context-agent/context.mjs';
import { createTools } from '../server/context-agent/tools.mjs';
import { createImageObserver } from '../server/context-agent/providers.mjs';
import { ContextAgent } from '../server/context-agent/loop.mjs';
import { loadCatalog, readSkill } from '../server/catalog.mjs';
import { loadAgentCatalog, readAgentSkill, projectSkills } from '../server/context-agent/skills.mjs';

const prompt = await readFile(new URL('../server/context-agent/prompt.md', import.meta.url), 'utf8');
const say = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
const call = (name, args, id) => [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id }];
const blocks = input => input.filter(v => typeof v.content === 'string' && v.content.startsWith('Context reference data')).map(v => JSON.parse(v.content.split('\n')[1]));
function fixture(options = {}) {
  const state = createSession({ ownerId: 'repair-test' });
  const ctx = { state, ownerId: state.ownerId, turnId: 'turn', callId: 'call', save: async () => {} };
  return { state, ctx, tools: createTools(options) };
}
function img(state, id, extra = {}) { return state.assets[id] = { id, type: 'image', version: 1, url: `https://example.test/${id}.png`, sourceIds: [], ...extra }; }
function doc(state, id, content) { return state.assets[id] = { id, type: 'text', version: 1, content, sourceIds: [] }; }
function message(state, content, role = 'user', extra = {}) { return appendRecord(state, { kind: 'message', role, content, ...extra }); }

test('repair: memory search excludes its own calls/results; exact identities remain readable', () => {
  const { state } = fixture();
  const original = message(state, '保留红色标签，不改变杯子');
  const query = appendRecord(state, { kind: 'tool_call', name: 'search_history', callId: 'search', arguments: '{"query":"红色标签"}' });
  const result = appendRecord(state, { kind: 'tool_result', callId: 'search', output: JSON.stringify(searchHistory(state, { query: '红色标签' })) });
  const read = appendRecord(state, { kind: 'tool_call', name: 'read_history', callId: 'read', arguments: JSON.stringify({ messageId: original.id }) });
  const echo = appendRecord(state, { kind: 'tool_result', callId: 'read', output: JSON.stringify(readHistory(state, { messageId: original.id })) });
  const before = JSON.stringify(state);
  assert.deepEqual(searchHistory(state, { query: '红色标签' }).matches.map(v => v.id), [original.id]);
  for (const record of [query, result, read, echo]) {
    assert.equal(searchHistory(state, { query: record.id }).matches[0].id, record.id);
    assert.deepEqual(readHistory(state, { messageId: record.id }).records[0], record);
  }
  assert.equal(JSON.stringify(state), before);
});

test('repair: surrounding memory cannot reintroduce nested model requests or retrieval echoes', () => {
  const { state } = fixture();
  const source = message(state, '唯一原稿：只要两张独立图片');
  const trace = appendRecord(state, { kind: 'run_event', event: 'model_request', input: [{ content: 'DO_NOT_REINJECT'.repeat(2000) }] });
  appendRecord(state, { kind: 'tool_call', name: 'read_history', callId: 'r', arguments: '{}' });
  appendRecord(state, { kind: 'tool_result', callId: 'r', output: JSON.stringify(trace) });
  const actual = appendRecord(state, { kind: 'tool_call', name: 'analyze_image', callId: 'vision', arguments: '{}' });
  const observed = appendRecord(state, { kind: 'tool_result', callId: 'vision', output: '{"observation":"容量未知"}' });
  const next = message(state, '第一张保持红色');
  const before = JSON.stringify(state);
  const result = readHistory(state, { messageId: source.id, surroundingRange: 20 });
  assert.deepEqual(result.records.map(v => v.id), [source.id, actual.id, observed.id, next.id]);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_REINJECT'));
  assert.deepEqual(readHistory(state, { messageId: trace.id }).records[0], trace);
  assert.equal(JSON.stringify(state), before);
});

test('repair: actual catalog projection removes fixed direction count without changing legacy catalog', async () => {
  const catalog = await loadAgentCatalog(), before = JSON.stringify(catalog);
  const { state, tools } = fixture({ catalog, mode: 'live' });
  message(state, '给我一个方向，别加备选');
  const { input } = buildContext(state, { systemPrompt: prompt, skillDirectory: catalog.skills, toolDefinitions: tools.definitions });
  assert.ok(!JSON.stringify(input).includes('2–3'));
  assert.ok(!JSON.stringify(input).includes('flow engine'));
  const method = await readAgentSkill(catalog, 'direction-designer-zh-v1');
  assert.doesNotMatch(method.content, /structure\.directions|compiled|当前节点/);
  assert.equal(JSON.stringify(catalog), before);
  assert.match((await readSkill(await loadCatalog(), 'direction-designer-zh-v1')).content, /structure\.directions/);
  assert.match(projectSkills(catalog.skills).find(s => s.slug === 'video-decomposition-zh-v1').description, /不代表已接通/);
});

test('repair: long adapted methods page without losing original professional content', async () => {
  const catalog = await loadCatalog();
  let adapted = '', next = 0;
  do { const p = await readAgentSkill(catalog, 'actor-realism-v2', undefined, next); adapted += p.content; next = p.nextOffset; } while (next !== null);
  let raw = ''; next = 0;
  do { const p = await readSkill(catalog, 'actor-realism-v2', undefined, next); raw += p.content; next = p.nextOffset; } while (next !== null);
  assert.equal(adapted,await readFile(new URL('../server/context-agent/methods/v1/actor-realism-v2/method.md',import.meta.url),'utf8'));
  assert.ok(adapted.length>raw.length*0.85,'professional method must remain substantial');
  assert.doesNotMatch(adapted, /# 当前阶段边界/);
});

test('repair: runtime capabilities come from tools, not video Skill names', () => {
  for (const options of [{ mode: 'live' }, { mode: 'live', media: { image() {} }, observeImages() {} }]) {
    const { state, tools } = fixture(options);
    message(state, '你能看视频吗？');
    const input = buildContext(state, { toolDefinitions: tools.definitions, skillDirectory: [{ slug: 'video-decomposition-zh-v1', name: '视频拆解' }] }).input;
    const c = blocks(input).find(b => b.capabilities).capabilities;
    assert.equal(c.videoObservation, false);
    assert.equal(c.imageObservation, Boolean(options.observeImages));
    assert.deepEqual(c.registeredTools, tools.definitions.map(t => t.name));
    assert.ok(!c.registeredTools.includes('generate_video'));
  }
  assert.match(createTools().definitions.find(t => t.name === 'generate_image').description, /仅模拟/);
});

test('repair: model receives addressable original messages and saved version identity', () => {
  const { state, tools } = fixture();
  const original = message(state, '原脚本：雨后街角，保持人物与对白。', 'assistant');
  doc(state, 'script', original.content); state.assets.script.version = 3; state.assets.script.parentId = 'v2';
  message(state, '只压缩时长，不换方向');
  const before = JSON.stringify(state);
  const input = buildContext(state, { toolDefinitions: tools.definitions }).input;
  assert.equal(blocks(input).find(b => b.originalMessages).originalMessages[0].messageId, original.id);
  assert.equal(blocks(input).find(b => b.assetDirectory).assetDirectory[0].version, 3);
  assert.ok(input.some(v => v.content === original.content));
  assert.equal(JSON.stringify(state), before);
});

test('repair: save original chat exactly, then create a real child revision; repeat original archival reuses asset', async () => {
  const f = fixture();
  const original = message(f.state, '## 原稿\n不改变产品功能。\n\n结尾保留。', 'assistant');
  const first = await f.tools.execute('save_document', { sourceMessageId: original.id, title: '原稿' }, f.ctx);
  assert.equal(first.asset.content, original.content);
  assert.equal(first.asset.sourceMessageId, original.id);
  const child = await f.tools.execute('save_document', { content: '## 修改稿\n不改变产品功能。\n结尾保留。', parentId: first.asset.id }, { ...f.ctx, callId: 'revise' });
  assert.equal(child.asset.parentId, first.asset.id);
  assert.equal(child.asset.version, 2);
  assert.ok(child.asset.sourceIds.includes(first.asset.id));
  const again = await f.tools.execute('save_document', { sourceMessageId: original.id }, { ...f.ctx, callId: 'archive-again' });
  assert.equal(again.asset.id, first.asset.id);
  assert.equal((await f.tools.execute('save_document', { content: 'changed' }, { ...f.ctx, callId: 'archive-again' })).error.code, 'call_identity_conflict');
  assert.equal(Object.keys(f.state.assets).length, 2);
  assert.equal(f.state.records[0].content, original.content);
});

test('repair: original archival rejects invented messages, changed originals, invalid parent and empty input', async () => {
  const f = fixture(); const original = message(f.state, '原稿', 'assistant');
  for (const [args, code] of [
    [{}, 'invalid_arguments'],
    [{ sourceMessageId: 'foreign-message' }, 'HISTORY_NOT_FOUND'],
    [{ sourceMessageId: original.id, content: '冒充原稿' }, 'original_content_mismatch'],
    [{ sourceMessageId: original.id, parentId: 'fake-parent' }, 'invalid_arguments'],
  ]) {
    const out = await f.tools.execute('save_document', args, f.ctx);
    assert.equal(out.ok, false); assert.equal(out.error.code, code);
    assert.equal(Object.keys(f.state.assets).length, 0);
  }
});

test('repair: archival and revision keep existing persistence rollback and call idempotency', async () => {
  const f = fixture(); const original = message(f.state, 'original', 'assistant');
  const args = { sourceMessageId: original.id };
  const failed = await f.tools.execute('save_document', args, { ...f.ctx, save: async () => { throw new Error('disk failed'); } });
  assert.equal(failed.ok, false); assert.equal(Object.keys(f.state.assets).length, 0);
  assert.equal(Object.keys(f.state.invocations).length, 0);
  const first = await f.tools.execute('save_document', args, f.ctx);
  assert.equal((await f.tools.execute('save_document', args, f.ctx)).asset.id, first.asset.id);
  assert.equal((await f.tools.execute('save_document', { content: 'changed' }, f.ctx)).error.code, 'call_identity_conflict');
});

test('repair: observation reads explicitly selected material and does not expand to co-uploaded documents', async () => {
  let received;
  const f = fixture({ observeImages: async args => { received = args; return { text: '实际容量和开盖结构无法判断。' }; } });
  img(f.state, 'product', { sourceIds: ['facts'] });
  doc(f.state, 'facts', '用户提供：白色；容量未知。');
  doc(f.state, 'more', '开盖机制待确认'); doc(f.state, 'unrelated', '另一个商品容量500ml');
  message(f.state, '看附件', 'user', { attachments: [{ id: 'product' }, { id: 'more' }] });
  const out = await f.tools.execute('analyze_image', { imageIds: ['product'], question: '哪些卖点有依据？',materials:[{sourceId:'facts'}] }, f.ctx);
  assert.equal(out.ok, true);
  assert.deepEqual(received.materials.map(m => m.sourceId).sort(), ['facts']);
  assert.equal(received.materials.find(m => m.sourceId === 'facts').content, f.state.assets.facts.content);
  assert.ok(!received.materials.some(m=>m.sourceId==='more'));
  assert.ok(received.materials.every(m => m.provenance === 'stored_original'));
  assert.ok(!JSON.stringify(received).includes('500ml'));
});

test('repair: image type error recovery uses explicit source/result comparison', async () => {
  let received, calls = 0;
  const f = fixture({ observeImages: async args => { received = args; calls++; return { text: '瓶身颜色变化，保持要求未满足。' }; } });
  img(f.state, 'original'); img(f.state, 'result', { parentId: 'original', version: 2 });
  const bad = await f.tools.execute('analyze_image', { imageIds: ['result'], question: '是否保持？', materials: [{ sourceId: 'original', content: '原图' }] }, f.ctx);
  assert.equal(bad.error.code, 'asset_type_mismatch'); assert.equal(calls, 0);
  assert.match(bad.error.message, /imageIds/);
  const repaired = await f.tools.execute('compare_images', { sourceImageId:'original',resultImageId:'result',question:'是否保持？' }, f.ctx);
  assert.equal(repaired.ok, true);
  assert.deepEqual(received.images.map(i => i.id), ['original', 'result']);
  assert.deepEqual(received.comparisons, [{ sourceId: 'original', resultId: 'result' }]);
  assert.match(repaired.observation.text, /未满足/);
  assert.equal(repaired.passed, undefined);
});

test('repair: explicit dual images are deduplicated and impossible source cannot pass visual checking', async () => {
  let calls = 0;
  const f = fixture({ observeImages: async () => { calls++; return { text: 'observed' }; } });
  img(f.state, 'original'); img(f.state, 'result', { parentId: 'original' });
  const pair = await f.tools.execute('analyze_image', { imageIds: ['original', 'result'], question: 'compare' }, f.ctx);
  assert.deepEqual(pair.imageIds, ['original', 'result']);
  f.state.assets.original.simulated = true;
  const failed = await f.tools.execute('compare_images', { sourceImageId:'original',resultImageId:'result',question:'compare' }, f.ctx);
  assert.equal(failed.error.code, 'real_image_required'); assert.equal(calls, 1);
});

test('repair: model-supplied verified annotation cannot replace stored unknown or certify output', async () => {
  let received;
  const f = fixture({ observeImages: async args => { received = args; return { text: '容量未知，不能确定便携。' }; } });
  img(f.state, 'product', { sourceIds: ['facts'] }); doc(f.state, 'facts', '容量与便携性未知');
  const out = await f.tools.execute('analyze_image', { imageIds: ['product'], question: '卖点？', materials: [{ sourceId: 'facts', content: '已证明便携', status: 'verified' }] }, f.ctx);
  assert.equal(received.materials.length, 1);
  assert.equal(received.materials[0].content, '容量与便携性未知');
  assert.equal(received.materials[0].agentAnnotation.status, 'verified');
  assert.equal(received.materials[0].status, undefined);
  assert.match(out.observation.text, /不能确定/);
});

test('repair: observer actual wire contains both images, identity pairs, original facts and uncertainty instructions', async () => {
  let input;
  const observer = createImageObserver({ respond: async messages => { input = messages; return say('有差异，不能确认保持。'); } });
  const result = await observer({ images: [{ id: 'old', version: 1, url: 'https://example.test/old.png' }, { id: 'new', version: 2, url: 'https://example.test/new.png' }], question: '保持检查', materials: [{ content: '容量未知', provenance: 'stored_original' }], comparisons: [{ sourceId: 'old', resultId: 'new' }] });
  assert.equal(input[1].content.filter(v => v.type === 'input_image').length, 2);
  assert.deepEqual(JSON.parse(input[1].content[0].text).comparisons, [{ sourceId: 'old', resultId: 'new' }]);
  assert.match(input[0].content, /不证明实际大小、容量或便携/);
  assert.match(result.text, /不能确认/);
});

test('repair scripted integration: model selects memory, archives original, saves revision and judges the returned version', async () => {
  const f = fixture({ mode: 'live' });
  const original = message(f.state, '原脚本：保持红杯，只压缩旁白。', 'assistant');
  let step = 0, parent;
  const brain = { respond: async input => {
    const results = input.filter(v => v.type === 'function_call_output').map(v => JSON.parse(v.output));
    switch (step++) {
      case 0: return call('search_history', { query: '原脚本' }, 'find');
      case 1: assert.equal(results.at(-1).matches[0].id, original.id); return call('read_history', { messageId: original.id }, 'read');
      case 2: assert.equal(results.at(-1).records[0].content, original.content); return call('save_document', { sourceMessageId: original.id }, 'archive');
      case 3: parent = results.at(-1).asset; return call('save_document', { content: '15秒脚本：红杯保持，旁白压缩。', parentId: parent.id }, 'revise');
      default: assert.equal(results.at(-1).asset.parentId, parent.id); assert.equal(results.at(-1).asset.version, 2); return say('已保存15秒修订，红杯保持。');
    }
  } };
  const result = await new ContextAgent({ brain, tools: f.tools }).run(f.state, '改成15秒，杯子不变');
  assert.equal(result.status, 'completed'); assert.equal(result.modelCalls, 5);
  assert.deepEqual(f.state.records.filter(r => r.kind === 'tool_call').map(r => r.name), ['search_history', 'read_history', 'save_document', 'save_document']);
});

test('repair scripted integration: free creation can propose independent pictures without photos; no approval means no submission', async () => {
  let submitted = 0, step = 0;
  const f = fixture({ mode: 'live', media: { image: async () => { submitted++; } } });
  const brain = { respond: async () => step++ === 0 ? [
    ...call('generate_image', { prompt: '虚构的紫色圆瓶，白底', size: '1024x1024' }, 'purple'),
    ...call('generate_image', { prompt: '虚构的黄色方瓶，白底', size: '1024x1024' }, 'yellow'),
  ] : say('已准备两张独立方案，等待批准。') };
  const result = await new ContextAgent({ brain, tools: f.tools }).run(f.state, '自由设计两款瓶子广告图，各一张，不拼图');
  assert.equal(result.status, 'completed'); assert.equal(submitted, 0);
  assert.equal(Object.values(f.state.approvals).filter(v => v.kind === 'proposal').length, 2);
  assert.equal(Object.keys(f.state.assets).length, 0);
});

test('repair scripted integration: ordinary answer still ends immediately without a planner, save or second audit', async () => {
  const f = fixture({ mode: 'live' });
  const brain = { respond: async () => say('当前可以写视频脚本；没有注册视频观察工具，不能直接观看视频。') };
  const result = await new ContextAgent({ brain, tools: f.tools }).run(f.state, '你能看视频吗');
  assert.equal(result.modelCalls, 1); assert.equal(result.toolCalls, 0);
  assert.equal(Object.keys(f.state.assets).length, 0);
});
