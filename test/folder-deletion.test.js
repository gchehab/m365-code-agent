'use strict';
require('../src/i18n').setLanguage('ko');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { WorkspaceStore } = require('../src/workspace');
const { ChangeController } = require('../src/changes');
const { CodingAgent } = require('../src/agent');
const output = path.resolve(__dirname, '..', '.test-output');
async function fixture(t) {
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'folder-delete-'));
  t.after(async () => { assert.equal(path.dirname(root), output); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'old/nested/empty'), { recursive: true }); await fs.mkdir(path.join(root, 'old/empty'));
  const files = new Map([['old/a.js', Buffer.from('old\n')], ['old/nested/image.bin', Buffer.from([0, 0xff, 0x89])], ['old/nested/empty.txt', Buffer.alloc(0)]]);
  for (const [name, bytes] of files) await fs.writeFile(path.join(root, name), bytes);
  return { root, files, store: await new WorkspaceStore(root).initialize() };
}

test('folder deletion uses a bounded complete tree hash, preserves raw bytes and notices changed or newly added children', async t => {
  const { root, files, store } = await fixture(t);
  await assert.rejects(store.prepareChanges([{ path: 'old', action: 'delete', baseHash: 'guessed' }]), /folder_info/);
  const info = await store.folderInfo('old'); assert.equal(info.kind, 'directory'); assert.equal(info.fileCount, files.size); assert.equal(info.directoryCount, 4);
  const changes = await store.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]);
  assert.equal(changes[0].directory, true);
  for (const file of changes[0].directorySnapshot.files) assert.deepEqual(file.bytes, files.get(file.path));
  await store.verifyChanges(changes);
  await fs.writeFile(path.join(root, 'old/new.txt'), 'new user file'); await assert.rejects(store.verifyChanges(changes), /변경/);
  await fs.unlink(path.join(root, 'old/new.txt')); await store.verifyChanges(changes);
  await fs.writeFile(path.join(root, 'old/a.js'), 'edited'); await assert.rejects(store.verifyChanges(changes), /변경/);
});

test('folder deletion cannot overlap child edits, traverse roots/links, or include excluded empty directories', async t => {
  const { root, store } = await fixture(t);
  const folder = await store.folderInfo('old'), child = await store.fileInfo('old/a.js');
  await assert.rejects(store.prepareChanges([{ path: folder.path, action: 'delete', baseHash: folder.hash }, { path: child.path, action: 'delete', baseHash: child.hash }]), /중복/);
  for (const name of ['.', '..', '../escape', 'C:/outside']) await assert.rejects(store.folderInfo(name));
  await fs.writeFile(path.join(root, '.gitignore'), 'old/ignored/\n'); await fs.mkdir(path.join(root, 'old/ignored'));
  const ignored = await new WorkspaceStore(root).initialize(); await assert.rejects(ignored.folderInfo('old'), /제외/);
  await fs.unlink(path.join(root, '.gitignore'));
  await fs.mkdir(path.join(root, 'outside')); await fs.writeFile(path.join(root, 'outside/keep.txt'), 'keep');
  await fs.symlink(path.join(root, 'outside'), path.join(root, 'old/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.folderInfo('old'), /링크|정션/); assert.equal(await fs.readFile(path.join(root, 'outside/keep.txt'), 'utf8'), 'keep');
});

test('folder inspection stops during scanning without granting a deletion hash', async t => {
  const { store } = await fixture(t); let probes = 0;
  await assert.rejects(store.folderInfo('old', () => ++probes > 2), /중지/);
  assert.equal(store.directoryReads.has('old'), false);
});

test('folder deletion refuses an incomplete byte backup before applying any deletion', async t => {
  const { root, store } = await fixture(t), info = await store.folderInfo('old');
  const original = store.loadDirectory.bind(store);
  t.mock.method(store, 'loadDirectory', async (...args) => {
    const snapshot = await original(...args);
    if (args[1] === true) delete snapshot.files[0].bytes;
    return snapshot;
  });
  await assert.rejects(store.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]), /바이트 백업/);
  assert.equal(await fs.readFile(path.join(root, 'old/a.js'), 'utf8'), 'old\n');
});

test('folder deletion recovery explicitly records folder_info while file_info remains file-only', async t => {
  const { store } = await fixture(t); let requests = 0;
  await assert.rejects(store.fileInfo('old'), /folder_info/);
  assert.equal(store.directoryReads.has('old'), false);
  const agent = new CodingAgent({ store, emit() {}, approveAndApply: async changes => { assert.equal(changes[0].directory, true); return false; }, transport: { async request(prompt) {
    if (++requests === 1) return { kind: 'changes', files: [{ path: 'old', action: 'delete', baseHash: 'missing-evidence' }] };
    const data = JSON.parse(prompt.split('DATA: ')[1]);
    const evidence = data.history.find(item => item.origin === 'proposal_validation_repair').observations[0];
    assert.equal(evidence.call.name, 'folder_info'); assert.equal(evidence.result.kind, 'directory');
    return { kind: 'changes', files: [{ path: evidence.result.path, action: 'delete', baseHash: evidence.result.hash }] };
  } } });
  assert.equal((await agent.run('Delete the old folder.')).status, 'rejected'); assert.equal(requests, 2);
});

test('model-supplied directory metadata cannot turn an ordinary file change into a folder operation', async t => {
  const { store } = await fixture(t);
  const [created] = await store.prepareChanges([{ path: 'new.js', action: 'create', baseHash: null, content: 'new\n', directory: true }]);
  assert.equal(created.directory, false);
  const file = await store.readFile('old/a.js');
  const [replaced] = await store.prepareChanges([{ path: file.path, action: 'replace', baseHash: file.hash, content: 'updated\n', directory: true }]);
  assert.equal(replaced.directory, false);
});

test('folder metadata enforces entry and backup limits without authorizing a partial tree', async t => {
  const { root, store } = await fixture(t);
  await fs.mkdir(path.join(root, 'many'));
  await Promise.all(Array.from({ length: 1000 }, (_, index) => fs.writeFile(path.join(root, 'many', index + '.txt'), '')));
  await assert.rejects(store.folderInfo('many'), /1,000/);
  assert.equal(store.directoryReads.has('many'), false);
  await fs.mkdir(path.join(root, 'large'));
  const payload = Buffer.alloc(12 * 1024 * 1024);
  for (let index = 0; index < 3; index++) await fs.writeFile(path.join(root, 'large', index + '.bin'), payload);
  await assert.rejects(store.folderInfo('large'), /32MB/);
  assert.equal(store.directoryReads.has('large'), false);
});

test('partial folder deletion restores only missing known entries while preserving a newly added file', async t => {
  const { root, files, store } = await fixture(t);
  const info = await store.folderInfo('old'), changes = await store.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]);
  const events = [], host = { previews: new Map(), checkpoints: [], changedFiles: new Map(), post: event => events.push(event) }; let applying = 0;
  class Edit { constructor() { this.creates = []; this.deletes = []; } deleteFile(uri, options) { this.deletes.push({ uri, options }); } createFile(uri, options) { this.creates.push({ uri, options }); } }
  const vscode = { Uri: { file: value => ({ scheme: 'file', fsPath: value }) }, WorkspaceEdit: Edit, workspace: { textDocuments: [], fs: { createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }) }, async applyEdit(edit) {
    if (++applying === 1) { assert.ok(edit.deletes.every(item => item.options.recursive === false)); await fs.unlink(edit.deletes[0].uri.fsPath); await fs.writeFile(path.join(root, 'old/new-user.txt'), 'keep new'); return false; }
    for (const item of edit.creates) await fs.writeFile(item.uri.fsPath, item.options.contents, { flag: 'wx' }); return true;
  } } };
  const controller = new ChangeController(host, vscode);
  await assert.rejects(controller.stageAndApply(store, changes, 'Delete folder', true, true), { code: 'PARTIAL_DELETE' });
  assert.equal(host.checkpoints[0].changes[0].partialDirectory, true); assert.equal(host.checkpoints[0].changes[0].directorySnapshot.files.length, 1);
  await fs.rename(path.join(root, 'old'), path.join(root, 'saved-original'));
  await fs.mkdir(path.join(root, 'old')); await fs.writeFile(path.join(root, 'old/user.txt'), 'replacement root');
  await assert.rejects(controller.undo(), /폴더가 바뀌어/);
  assert.equal(await fs.readFile(path.join(root, 'old/user.txt'), 'utf8'), 'replacement root');
  await fs.unlink(path.join(root, 'old/user.txt')); await fs.rmdir(path.join(root, 'old'));
  await fs.rename(path.join(root, 'saved-original'), path.join(root, 'old'));
  await controller.undo();
  for (const [name, bytes] of files) assert.deepEqual(await fs.readFile(path.join(root, name)), bytes);
  assert.equal(await fs.readFile(path.join(root, 'old/new-user.txt'), 'utf8'), 'keep new');
  assert.equal(host.checkpoints.length, 0);
});

test('dirty descendants block folder deletion even with automatic approval', async t => {
  const { root, store } = await fixture(t), info = await store.folderInfo('old');
  const changes = await store.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]);
  const controller = new ChangeController({}, { workspace: { textDocuments: [{ uri: { scheme: 'file', fsPath: path.join(root, 'old/nested/empty.txt') }, isDirty: true }] } });
  await assert.rejects(controller.stageAndApply(store, changes, 'Delete folder', false, true), /저장하지 않은/);
  await fs.access(path.join(root, 'old/a.js'));
});
