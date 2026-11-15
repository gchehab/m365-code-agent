'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore } = require('../src/workspace');
const { CodingAgent } = require('../src/agent');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm365-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.js'), 'exports.value = 1;\n');
  return { root, store: await new WorkspaceStore(root).initialize() };
}
const invalid = { kind: 'changes', files: [{ path: 'main.js', action: 'replace', baseHash: 'incorrect', content: 'exports.value = 2;\n' }] };

test('failed proposals trigger an actual targeted read and can recover without any model tool request', async t => {
  const { root, store } = await fixture(t); let requests = 0, applies = 0; const events = [];
  const agent = new CodingAgent({ store, emit: event => events.push(event), approveAndApply: async changes => { applies++; await store.verifyChanges(changes); await fs.writeFile(changes[0].target, changes[0].content); return true; }, transport: { async request(prompt) {
    if (++requests === 1) return invalid;
    if (requests === 2) {
      const data = JSON.parse(prompt.split('DATA: ')[1]);
      const repair = data.history.find(item => item.origin === 'proposal_validation_repair');
      assert.ok(repair); assert.match(repair.observations[0].result.content, /value = 1/);
      assert.match(data.progress.lastError, /hash/);
      return { ...invalid, files: [{ ...invalid.files[0], baseHash: repair.observations[0].result.hash }] };
    }
    return { kind: 'done', message: 'Applied the verified update.' };
  } } });
  assert.equal((await agent.run('Update the code.')).appliedFiles, 1);
  assert.equal(applies, 1); assert.equal(requests, 3);
  assert.equal(await fs.readFile(path.join(root, 'main.js'), 'utf8'), 'exports.value = 2;\n');
  assert.ok(events.some(event => event.type === 'tool' && event.label.startsWith('수정 대상 자동 확인') && event.state === 'done'));
});

test('the same invalid proposal stops after correction attempts rather than consuming twenty rounds', async t => {
  const { root, store } = await fixture(t); let requests = 0, applies = 0;
  const agent = new CodingAgent({ store, emit() {}, approveAndApply: async () => { applies++; }, transport: { async request() { requests++; return invalid; } } });
  await assert.rejects(agent.run('Update the code.'), { code: 'NO_PROGRESS' });
  assert.equal(requests, 3); assert.equal(applies, 0);
  assert.equal(await fs.readFile(path.join(root, 'main.js'), 'utf8'), 'exports.value = 1;\n');
});

test('unchanged reads are identified as a continuation and repeated reads do not burn all rounds', async t => {
  const { store } = await fixture(t); let requests = 0; const taskIds = new Set();
  const agent = new CodingAgent({ store, emit() {}, transport: { async request(prompt) {
    requests++; const data = JSON.parse(prompt.split('DATA: ')[1]); taskIds.add(data.progress.taskId);
    if (requests === 3) assert.equal(data.progress.noProgressRounds, 1);
    return { kind: 'tools', calls: [{ name: 'read_file', path: 'main.js' }] };
  } } });
  await assert.rejects(agent.run('Explain the project.'), { code: 'NO_PROGRESS' });
  assert.equal(requests, 3); assert.equal(taskIds.size, 1);
});

test('identical command outcomes stop repetition without caching or skipping actual executions', async t => {
  const { store } = await fixture(t); let requests = 0, executed = 0;
  const agent = new CodingAgent({ store, autoApprove: true, emit() {}, runCommand: async () => { executed++; return { exitCode: 0, output: 'ok' }; }, transport: { async request() { requests++; return { kind: 'tools', calls: [{ name: 'run_command', command: 'npm test' }] }; } } });
  await assert.rejects(agent.run('Run the tests.'), { code: 'NO_PROGRESS' });
  assert.equal(requests, 3); assert.equal(executed, 3);
});

test('the same test command is progress again after a verified source change', async t => {
  const { root, store } = await fixture(t); const file = await store.readFile('main.js'); let requests = 0, executed = 0;
  const agent = new CodingAgent({ store, emit() {}, runCommand: async () => { executed++; return { exitCode: 0, output: 'ok' }; }, approveAndApply: async changes => { await store.verifyChanges(changes); await fs.writeFile(changes[0].target, changes[0].content); return true; }, transport: { async request() {
    requests++;
    if (requests === 2) return { kind: 'changes', files: [{ path: 'main.js', action: 'replace', baseHash: file.hash, content: 'exports.value = 2;\n' }] };
    if (requests < 4) return { kind: 'tools', calls: [{ name: 'run_command', command: 'npm test' }] };
    return { kind: 'done', message: 'Tested before and after the edit.' };
  } } });
  assert.equal((await agent.run('Update and test the code.')).status, 'done');
  assert.equal(executed, 2); assert.equal(await fs.readFile(path.join(root, 'main.js'), 'utf8'), 'exports.value = 2;\n');
});

test('identical file proposals cannot count as applied progress', async t => {
  const { store } = await fixture(t); const file = await store.readFile('main.js'); let applied = 0;
  const agent = new CodingAgent({ store, emit() {}, approveAndApply: async () => { applied++; return true; }, transport: { async request() { return { kind: 'changes', files: [{ path: 'main.js', action: 'replace', baseHash: file.hash, content: file.content }] }; } } });
  await assert.rejects(agent.run('Update the code.'), { code: 'NO_PROGRESS' }); assert.equal(applied, 0);
});
