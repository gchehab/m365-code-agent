'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { WorkspaceStore } = require('../src/workspace');
const { CodingAgent } = require('../src/agent');
const { ChangeController } = require('../src/changes');
const { parseReply } = require('../src/protocol');
const output = path.resolve(__dirname, '..', '.test-output');
async function directory(t, prefix = 'delete-') {
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, prefix));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), output); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function fixture(t, content = Buffer.from('old\n')) {
  const root = await directory(t); await fs.writeFile(path.join(root, 'target.bin'), content);
  return { root, target: path.join(root, 'target.bin'), store: await new WorkspaceStore(root).initialize() };
}

test('delete requires observed hashes and keeps byte-exact binary, UTF-16 and empty backups', async t => {
  for (const content of [Buffer.from([0, 0xff, 0x89, 0x50]), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('한글\r\n', 'utf16le')]), Buffer.alloc(0)]) {
    const { store, target } = await fixture(t, content);
    await assert.rejects(store.prepareChanges([{ path: 'target.bin', action: 'delete', baseHash: 'guessed' }]), /먼저/);
    const info = await store.fileInfo('target.bin');
    assert.equal(info.hash, createHash('sha256').update(content).digest('hex')); assert.equal(info.size, content.length); assert.equal(info.content, undefined);
    const changes = await store.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]);
    assert.deepEqual(changes[0].originalBytes, content); await store.verifyChanges(changes);
    await fs.writeFile(target, 'changed after preview');
    await assert.rejects(store.verifyChanges(changes), /변경/);
    await assert.rejects(store.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]), /변경/);
  }
});

test('partial text reads authorize deletion by saved content hash, but stale editor text cannot authorize changed disk bytes', async t => {
  const { root, store } = await fixture(t);
  const read = await store.readFile('target.bin', { startLine: 1, lineCount: 1 });
  assert.equal((await store.prepareChanges([{ path: read.path, action: 'delete', baseHash: read.hash }]))[0].action, 'delete');
  const stale = await new WorkspaceStore(root, async () => 'cached old text').initialize();
  const cached = await stale.readFile('target.bin');
  await assert.rejects(stale.prepareChanges([{ path: cached.path, action: 'delete', baseHash: cached.hash }]), /변경/);
});

test('file_info and delete retain exclusions, root bounds, symlink protection, file-only and size limits', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n'); await fs.mkdir(path.join(root, 'ignored')); await fs.writeFile(path.join(root, 'ignored', 'file'), 'secret');
  await fs.writeFile(path.join(root, '.env'), 'secret');
  const store = await new WorkspaceStore(root).initialize();
  for (const name of ['..', '../outside', 'C:/outside', '.env', 'ignored/file', 'NUL', '.']) await assert.rejects(store.fileInfo(name));
  await assert.rejects(store.fileInfo('ignored'), /제외|파일/);
  await fs.mkdir(path.join(root, 'folder')); await assert.rejects(store.fileInfo('folder'), /폴더/);
  const outside = await directory(t, 'delete-outside-'); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.fileInfo('escape/keep.txt'), /링크|정션/);
  await assert.rejects(store.prepareChanges([{ path: 'escape/keep.txt', action: 'delete', baseHash: 'x'.repeat(64) }]), /링크|정션/);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  const small = await new WorkspaceStore(root, undefined, { maxFileBytes: 2 }).initialize(); await assert.rejects(small.fileInfo('target.bin'), /크기/);
});

test('binary-only projects and empty files can be deleted through actual file evidence rather than shell commands', async t => {
  for (const content of [Buffer.from([0, 0xff, 0x89]), Buffer.alloc(0)]) {
    const { store, target } = await fixture(t, content); let requests = 0;
    const agent = new CodingAgent({ store, emit() {}, approveAndApply: async changes => { await store.verifyChanges(changes); await fs.unlink(changes[0].target); return true; }, transport: { async request(prompt) {
      const data = JSON.parse(prompt.split('DATA: ')[1]); requests++;
      if (requests === 1) {
        const read = data.history.find(item => item.origin === 'automatic_workspace_inspection').observations.find(item => item.result);
        return { kind: 'changes', files: [{ path: read.result.path, action: 'delete', baseHash: read.result.hash }] };
      }
      assert.ok(data.history.some(item => item.kind === 'change_result' && item.applied && item.deletedFiles.includes('target.bin')));
      return { kind: 'done', message: 'Deleted.' };
    } } });
    assert.equal((await agent.run('Delete target.bin.')).appliedFiles, 1); assert.equal(requests, 2); await assert.rejects(fs.access(target));
  }
});

test('failed deletion proposals recover through file_info and read-only tasks cannot apply them', async t => {
  const { store, target } = await fixture(t, Buffer.from([0, 0xff, 0x89])); let count = 0, applied = 0;
  const agent = new CodingAgent({ store, emit() {}, approveAndApply: async changes => { applied++; await fs.unlink(changes[0].target); return true; }, transport: { async request(prompt) {
    if (++count === 1) return { kind: 'changes', files: [{ path: 'target.bin', action: 'delete', baseHash: 'invalid' }] };
    if (count === 2) { const data = JSON.parse(prompt.split('DATA: ')[1]); const repair = data.history.find(item => item.origin === 'proposal_validation_repair'); assert.equal(repair.observations[0].call.name, 'file_info'); return { kind: 'changes', files: [{ path: 'target.bin', action: 'delete', baseHash: repair.observations[0].result.hash }] }; }
    return { kind: 'done', message: 'Deleted.' };
  } } });
  await agent.run('Delete target.bin.'); assert.equal(applied, 1); await assert.rejects(fs.access(target));
  const other = await fixture(t); const info = await other.store.fileInfo('target.bin');
  const readonly = new CodingAgent({ store: other.store, mode: 'ask', autoApprove: true, emit() {}, approveAndApply: async () => { throw new Error('must not apply'); }, transport: { async request() { return { kind: 'changes', files: [{ path: info.path, action: 'delete', baseHash: info.hash }] }; } } });
  await assert.rejects(readonly.run('Explain the file.'), { code: 'NO_PROGRESS' }); assert.equal(await fs.readFile(other.target, 'utf8'), 'old\n');
});

test('delete responses merge idempotent proposals but reject deletion/edit conflicts', () => {
  const reply = file => JSON.stringify({ requestId: 'd', kind: 'changes', files: [file] });
  const file = { path: 'target.bin', action: 'delete', baseHash: 'hash' };
  assert.equal(parseReply(reply(file) + '\n' + reply({ ...file, content: '' }), 'd').files.length, 1);
  assert.throws(() => parseReply(reply(file) + '\n' + reply({ ...file, action: 'replace', content: 'different' }), 'd'), { code: 'AMBIGUOUS_REPLY' });
});

function controllerFixture(store, target, apply) {
  const events = [], documents = [{ uri: { scheme: 'file', fsPath: target }, isDirty: false }];
  const host = { previews: new Map(), checkpoints: [], changedFiles: new Map(), taskId: 'delete-test', post: event => events.push(event) };
  const vscode = { Uri: { file: value => ({ scheme: 'file', fsPath: value }) }, WorkspaceEdit: class { deleteFile() {} }, workspace: { textDocuments: documents, applyEdit: apply } };
  return { host, documents, events, controller: new ChangeController(host, vscode) };
}

test('dirty changes arriving during verification block deletion before the editor edit is applied', async t => {
  const { store, target } = await fixture(t); const info = await store.fileInfo('target.bin');
  const changes = await store.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]); let calls = 0;
  const { controller, documents } = controllerFixture(store, target, async () => { calls++; return true; });
  const original = store.verifyChanges.bind(store); let verified = 0;
  store.verifyChanges = async value => { await original(value); if (++verified === 2) documents[0].isDirty = true; };
  await assert.rejects(controller.stageAndApply(store, changes, 'Delete', false, true), /저장하지 않은/);
  assert.equal(calls, 0); assert.equal(await fs.readFile(target, 'utf8'), 'old\n');
});

test('partial editor failures retain raw backups and stop the agent instead of retrying deletion', async t => {
  const { store, target } = await fixture(t, Buffer.from([0, 0xff])); const info = await store.fileInfo('target.bin');
  const changes = await store.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]);
  const { controller, host, events } = controllerFixture(store, target, async () => { await fs.unlink(target); return false; });
  await assert.rejects(controller.stageAndApply(store, changes, 'Delete', false, true), { code: 'PARTIAL_DELETE' });
  assert.equal(host.checkpoints.length, 1); assert.deepEqual(host.checkpoints[0].changes[0].originalBytes, Buffer.from([0, 0xff])); assert.ok(events.some(event => event.type === 'undoState' && event.available));
  const other = await fixture(t); const otherInfo = await other.store.fileInfo('target.bin'); let requests = 0;
  const agent = new CodingAgent({ store: other.store, emit() {}, approveAndApply: async () => { const error = new Error('partial failure'); error.code = 'PARTIAL_DELETE'; throw error; }, transport: { async request() { requests++; return { kind: 'changes', files: [{ path: otherInfo.path, action: 'delete', baseHash: otherInfo.hash }] }; } } });
  await assert.rejects(agent.run('Delete target.bin.'), { code: 'PARTIAL_DELETE' }); assert.equal(requests, 1);
});
