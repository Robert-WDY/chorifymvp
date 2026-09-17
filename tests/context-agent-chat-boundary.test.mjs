import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoryStore, appendRecord} from '../server/context-agent/history.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {createTools} from '../server/context-agent/tools.mjs';

// Scripted Agent decisions exercise real context, tools and persistence only.
// These tests do not measure whether a live model chooses the right path.
const say = text => [{type:'message', role:'assistant', content:[{type:'output_text', text}]}];
const call = (id, args) => [{type:'function_call', call_id:id, name:'save_document', arguments:JSON.stringify(args)}];
const feedback = input => JSON.parse(input.filter(x => x.type === 'function_call_output').at(-1).output).data;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chorify-chat-boundary-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const store = new HistoryStore(directory);
  const state = await store.create('offline-owner');
  return {store, state, save: s => store.save(s, 'offline-owner'), reload: () => store.load(state.id, 'offline-owner')};
}

test('chat-only editing: complete original survives restart and supports a direct reply without tools or assets', async t => {
  const f = await fixture(t);
  const original = '这款茶呈现桂花香与乌龙茶香，适合午后慢慢品饮。';
  const revised = '桂花与乌龙双香，午后慢饮。';
  const tools = {definitions:createTools().definitions, execute:async () => assert.fail('chat-only turn must not force tools')};
  await new ContextAgent({tools, save:f.save, brain:{respond:async () => say(original)}}).run(f.state, '写一句桂花乌龙文案');
  const loaded = await f.reload();
  let decisions = 0;
  const result = await new ContextAgent({tools, save:f.save, brain:{respond:async input => {
    decisions++;
    assert.ok(input.some(m => m.role === 'assistant' && m.content === original));
    assert.ok(input.some(m => m.role === 'user' && m.content === '把刚才的文案缩短，不改变卖点'));
    return say(revised);
  }}}).run(loaded, '把刚才的文案缩短，不改变卖点');
  assert.equal(result.text, revised);
  assert.equal(result.status, 'completed');
  assert.equal(decisions, 1);
  assert.equal(result.toolCalls, 0);
  const after = await f.reload();
  assert.deepEqual(after.records.filter(r => r.kind === 'message' && r.role === 'assistant').map(r => r.content), [original, revised]);
  assert.equal(Object.keys(after.assets).length, 0);
  const request = after.records.filter(r => r.event === 'model_request').at(-1);
  const trace = await after.readTrace(request.id);
  assert.ok(trace.input.some(m => m.role === 'assistant' && m.content === original));
});

test('versioned editing: one atomic chat revision, then one asset revision, preserve actual parents across reloads', async t => {
  const f = await fixture(t), tools = createTools();
  const original = appendRecord(f.state, {kind:'message', role:'assistant', content:'桂花与乌龙双香，午后慢饮。', turnId:'earlier', groupId:'earlier'});
  await f.save(f.state);
  let step = 0, saved;
  const result = await new ContextAgent({tools, save:f.save, brain:{respond:async input => {
    if (step++ === 0) {
      assert.ok(input.some(m => m.role === 'assistant' && m.content === original.content));
      return call('archive-and-revise', {parentMessageId:original.id, sourceText:original.content, content:'桂花乌龙，双香慢饮。', title:'茶文案修订'});
    }
    saved = feedback(input);
    assert.equal(saved.ok, true);
    return say(saved.asset.content);
  }}}).run(f.state, '把刚才聊天中的文案再缩短，保存成有原稿版本关系的文稿');
  assert.equal(result.toolCalls, 1);
  const loaded = await f.reload();
  const child = loaded.assets[saved.asset.id], parent = loaded.assets[child.parentId];
  assert.equal(parent.content, original.content);
  assert.equal(parent.sourceMessageId, original.id);
  assert.equal(child.version, 2);
  assert.equal(Object.keys(loaded.assets).length, 2);
  step = 0;
  const next = await new ContextAgent({tools, save:f.save, brain:{respond:async input => {
    if (step++ === 0) {
      assert.equal(feedback(input).asset.content, child.content);
      return call('asset-revise', {parentId:child.id, sourceText:child.content, content:'双香桂花乌龙，悠然慢饮。'});
    }
    saved = feedback(input);
    assert.equal(saved.ok, true);
    return say(saved.asset.content);
  }}}).run(loaded, `修改文稿 ${child.id}，语气放松一些，保存下一版`);
  assert.equal(next.toolCalls, 1);
  const after = await f.reload();
  assert.equal(after.assets[saved.asset.id].parentId, child.id);
  assert.equal(after.assets[saved.asset.id].version, 3);
  assert.equal(after.assets[parent.id].content, original.content);
  assert.equal(after.assets[child.id].content, child.content);
  assert.deepEqual(after.records.filter(r => r.kind === 'tool_call').map(r => r.name), ['save_document', 'save_document']);
});
