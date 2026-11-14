'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseReply } = require('../src/protocol');
const { WorkspaceStore } = require('../src/workspace');
const { CodingAgent } = require('../src/agent');
const changes = files => ({ requestId: 'multi', kind: 'changes', files });
const file = (name, content) => ({ path: name, action: 'create', baseHash: null, content });
const blocks = values => values.map(value => '```json\n' + JSON.stringify(value) + '\n```').join('\n설명\n');

test('code-writing responses merge separate files, repeated containers and commentary', () => {
  const first = changes([file('src/a.js', 'const x = "a\u00a0b";\n')]), second = changes([file('src/b.js', 'exports.b = 2;\n')]);
  const reply = parseReply(blocks([first, second, changes([...first.files, ...second.files]), { requestId: 'multi', kind: 'done', message: '코드를 준비했습니다.' }]), 'multi');
  assert.equal(reply.files.length, 2); assert.equal(reply.files[0].content, 'const x = "a\u00a0b";\n'); assert.match(reply.summary, /코드를 준비/);
  assert.equal(parseReply(JSON.stringify([first, second]), 'multi').files.length, 2);
});

test('same-file conflicts stay blocked, including equivalent Windows path spellings', () => {
  for (const action of ['create', 'replace']) {
    assert.throws(() => parseReply(blocks([changes([{ ...file('src/a.js', 'one'), action }]), changes([{ ...file('./src\\A.js', 'two'), action }])]), 'multi'), { code: 'AMBIGUOUS_REPLY' });
  }
  const edit = value => changes([{ path: 'a.js', action: 'edit', baseHash: 'hash', edits: [{ oldText: 'old', newText: value }] }]);
  assert.throws(() => parseReply(blocks([edit('one'), edit('two')]), 'multi'), { code: 'AMBIGUOUS_REPLY' });
  const changedHash = edit('one'); changedHash.files[0].baseHash = 'different-hash';
  assert.throws(() => parseReply(blocks([edit('one'), changedHash]), 'multi'), { code: 'AMBIGUOUS_REPLY' });
});

test('tool blocks deduplicate and take precedence over premature edits and completion', () => {
  const one = { requestId: 'multi', kind: 'tools', calls: [{ name: 'read_file', path: 'a.js' }] };
  const two = { requestId: 'multi', kind: 'tools', calls: [{ name: 'read_file', arguments: { path: 'b.js' } }] };
  const reply = parseReply(blocks([one, two, one, changes([file('never.js', 'never')]), { requestId: 'multi', kind: 'done', message: '미리 완료' }]), 'multi');
  assert.deepEqual(reply.calls.map(call => call.path), ['a.js', 'b.js']); assert.deepEqual(reply.deferred, ['changes', 'done']);
  const command = { requestId: 'multi', kind: 'tools', calls: [{ name: 'run_command', command: 'npm test' }] };
  assert.equal(parseReply(blocks([command, command]), 'multi').calls.length, 1);
});

test('merged same-file edits retain hash/read/overlap validation and never replay deferred proposals', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm365-multi-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.js'), 'const a = 1;\nconst b = 2;\n');
  const store = await new WorkspaceStore(root).initialize(); const read = await store.readFile('a.js');
  const edit = (oldText, newText) => changes([{ path: 'a.js', action: 'edit', baseHash: read.hash, edits: [{ oldText, newText }] }]);
  const reply = parseReply(blocks([edit('const a = 1;', 'const a = 3;'), edit('const b = 2;', 'const b = 4;')]), 'multi');
  assert.equal((await store.prepareChanges(reply.files))[0].content, 'const a = 3;\nconst b = 4;\n');
  const overlapping = parseReply(blocks([edit('const a = 1;', 'one'), edit('a = 1', 'two')]), 'multi');
  await assert.rejects(store.prepareChanges(overlapping.files), /겹칩니다/);
  let round = 0, applies = 0;
  const agent = new CodingAgent({ store, emit() {}, approveAndApply: async updates => { applies++; await store.verifyChanges(updates); for (const update of updates) await fs.writeFile(update.target, update.content); return true; }, transport: { async request(prompt, id) {
    round++;
    if (round === 1) return parseReply(blocks([{ requestId: id, kind: 'tools', calls: [{ name: 'read_file', path: 'a.js' }] }, { requestId: id, kind: 'changes', files: [file('never.js', 'never')] }, { requestId: id, kind: 'done', message: 'premature' }]), id);
    if (round === 2) { assert.equal(applies, 0); const data = JSON.parse(prompt.split('DATA: ')[1]); assert.match(data.history.at(-1).note, /NOT applied/); return { ...reply, requestId: id }; }
    return { requestId: id, kind: 'done', message: '적용 결과 확인' };
  } } });
  await agent.run('코드 작성해줘');
  assert.equal(applies, 1); await assert.rejects(fs.access(path.join(root, 'never.js')));
});
