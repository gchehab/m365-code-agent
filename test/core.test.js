'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore, digest } = require('../src/workspace');
const { parseReply, buildPrompt } = require('../src/protocol');
const { validateCopilotUrl } = require('../src/browser');
const { CodingAgent } = require('../src/agent');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm365-agent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'average.js'), 'exports.average = a => a.reduce((x,y)=>x+y,0)/a.length;\n');
  return { root, store: await new WorkspaceStore(root).initialize() };
}

test('workspace prevents traversal, secrets, ignored files and Windows reserved paths', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  await fs.mkdir(path.join(root, 'ignored'));
  await fs.writeFile(path.join(root, 'ignored', 'private.txt'), 'private');
  await fs.writeFile(path.join(root, '.env.local'), 'secret');
  const store = await new WorkspaceStore(root).initialize();
  for (const target of ['../outside', '/outside', 'C:\\outside', '.env.local', 'src/NUL.txt', 'src/test:stream', 'ignored/private.txt']) {
    await assert.rejects(store.readFile(target));
  }
  const files = await store.listFiles();
  assert.deepEqual(files.files, ['.gitignore', 'src/average.js']);
});

test('symlink/junction escapes are rejected for reads and creates', async t => {
  const { root, store } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'm365-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside');
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.readFile('escape/outside.txt'), /링크|정션/);
  await assert.rejects(store.prepareChanges([{ path: 'escape/new.txt', action: 'create', baseHash: null, content: 'bad' }]), /링크|정션/);
});

test('changes require a read hash and detect modifications before applying', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.prepareChanges([{ path: 'src/average.js', action: 'replace', baseHash: 'fake', content: 'x' }]), /먼저/);
  const read = await store.readFile('src/average.js');
  const prepared = await store.prepareChanges([{ path: read.path, action: 'replace', baseHash: read.hash, content: 'exports.average = () => null;\n' }]);
  await fs.writeFile(path.join(root, read.path), 'user changed it');
  await assert.rejects(store.verifyChanges(prepared), /변경/);
  await assert.rejects(store.prepareChanges([{ path: 'src/average.js', action: 'create', baseHash: null, content: 'overwrite' }]), /존재/);
});

test('new nested file and literal search work', async t => {
  const { store } = await fixture(t);
  const prepared = await store.prepareChanges([{ path: 'tests/average.test.js', action: 'create', baseHash: null, content: 'test();' }]);
  await store.verifyChanges(prepared);
  const result = await store.search('reduce');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, 'src/average.js');
});

test('protocol refuses wrong turn IDs and arbitrary prose; accepts fenced structured output', () => {
  assert.throws(() => parseReply('{"requestId":"old","kind":"done","message":"x"}', 'current'));
  assert.throws(() => parseReply('just overwrite everything', 'current'));
  assert.deepEqual(parseReply('```m365-agent\n{"requestId":"current","kind":"done","message":"완료"}\n```', 'current').message, '완료');
  assert.throws(() => buildPrompt({ id: 'a', task: 'x'.repeat(9000), workspace: 'test', files: [], history: [], maxCharacters: 5000 }), /너무/);
  assert.throws(() => validateCopilotUrl('https://evil.example/chat'));
  assert.throws(() => validateCopilotUrl('http://m365.cloud.microsoft/chat'));
});

test('agent reads, proposes, applies and completes through a transport', async t => {
  const { root, store } = await fixture(t);
  const events = [];
  let turn = 0;
  const transport = {
    async request(prompt, id) {
      turn++;
      if (turn === 1) return { requestId: id, kind: 'tools', calls: [{ name: 'read_file', path: 'src/average.js' }] };
      if (turn === 2) {
        assert.match(prompt, /reduce/);
        return { requestId: id, kind: 'changes', summary: '빈 배열 수정', files: [{ path: 'src/average.js', action: 'replace', baseHash: store.ledger.get('src/average.js'), content: 'exports.average = a => a.length ? 1 : null;\n' }] };
      }
      assert.match(prompt, /"applied":true/);
      return { requestId: id, kind: 'done', message: '수정 완료. 테스트 미실행.' };
    }, async stop() {}
  };
  const agent = new CodingAgent({ store, transport, emit: event => events.push(event), approveAndApply: async changes => {
    await store.verifyChanges(changes);
    for (const change of changes) await fs.writeFile(change.target, change.content);
    return true;
  }});
  const result = await agent.run('빈 배열을 처리해줘');
  assert.equal(result.status, 'done');
  assert.match(await fs.readFile(path.join(root, 'src/average.js'), 'utf8'), /null/);
  assert.equal(turn, 3);
  assert.equal(events.at(-1).type, 'idle');
});

test('cancelled requests never apply changes', async t => {
  const { store } = await fixture(t);
  let applied = false;
  let agent;
  const transport = { async request() { await agent.stop(); return { kind: 'changes', files: [] }; }, async stop() {} };
  agent = new CodingAgent({ store, transport, emit: () => {}, approveAndApply: async () => { applied = true; } });
  await assert.rejects(agent.run('cancel'), /중지/);
  assert.equal(applied, false);
});
