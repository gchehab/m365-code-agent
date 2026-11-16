'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { cleanTestOutput } = require('../scripts/clean-test-output.cjs');

async function cleanupRepo(t) {
  const output = await fs.realpath(os.tmpdir());
  const repo = await fs.realpath(await fs.mkdtemp(path.join(output, 'm365-cleanup-fixture-')));
  t.after(async () => { assert.equal(path.dirname(repo), output); await fs.rm(repo, { recursive: true, force: true }); });
  const root = path.join(repo, '.test-output'); await fs.mkdir(root);
  return { repo, root };
}

async function cleanupFixture(t) {
  const { repo, root } = await cleanupRepo(t);
  const run = async (name, hours) => {
    const target = path.join(root, name); await fs.mkdir(target);
    await fs.writeFile(path.join(target, '.m365-test-run.json'), JSON.stringify({kind: 'm365-code-agent-integration', state: 'finished', pid: 2147483647}));
    await fs.writeFile(path.join(target, 'payload.bin'), 'payload');
    const time = new Date(Date.now() - hours * 3600000); await fs.utimes(target, time, time);
    return target;
  };
  return { repo, run };
}

test('cleanup visits each selected tree only during planning and its own final validation', async t => {
  const { repo, run } = await cleanupFixture(t), counts = new Map();
  await run('integration-new', 0);
  for (const name of ['a', 'b', 'c']) await run('integration-' + name, 72);
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', async target => {
    if (path.basename(target) === 'payload.bin') counts.set(target, (counts.get(target) || 0) + 1);
    return realpath(target);
  });
  const result = await cleanTestOutput(repo, { keep: 1, apply: true });
  assert.equal(result.removed.length, 3); assert.equal(result.removedBytes, result.candidateBytes);
  assert.equal(counts.size, 3); assert.ok([...counts.values()].every(count => count === 2));
});

test('cleanup rechecks ownership of its target and keeps a run that becomes active after planning', async t => {
  const { repo, run } = await cleanupFixture(t);
  await run('integration-new', 0); const target = await run('integration-old', 72);
  let ownershipChanged = false;
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', async entry => {
    const value = await realpath(entry);
    if (entry === path.join(target, 'payload.bin')) {
      ownershipChanged = true;
      await fs.writeFile(path.join(target, '.m365-test-run.json'), JSON.stringify({kind: 'm365-code-agent-integration', state: 'running', pid: process.pid}));
    }
    return value;
  });
  const inputRepo = process.platform === 'win32' ? repo.replace(/^[A-Z]:/i, drive => drive.toLowerCase()) : repo;
  const result = await cleanTestOutput(inputRepo, { keep: 1, apply: true });
  assert.equal(ownershipChanged, true, 'the ownership change must actually be exercised');
  assert.deepEqual(result.removed, []); assert.equal(result.removedBytes, 0);
  assert.equal(await fs.readFile(path.join(target, 'payload.bin'), 'utf8'), 'payload');
});

test('test-output cleanup defaults to dry run and retains recent, running, unknown and linked folders', async t => {
  const { repo, root } = await cleanupRepo(t);
  const now = Date.now(), old = new Date(now - 72 * 3600000);
  const run = async (name, marker) => {
    const target = path.join(root, name); await fs.mkdir(target);
    if (marker) await fs.writeFile(path.join(target, '.m365-test-run.json'), JSON.stringify(marker));
    await fs.utimes(target, old, old); return target;
  };
  const finished = { kind: 'm365-code-agent-integration', state: 'finished', pid: 2147483647 };
  const latest = await run('integration-new', finished); await fs.utimes(latest, new Date(now), new Date(now));
  await run('integration-old', finished);
  await run('integration-live', { ...finished, state: 'running', pid: process.pid });
  await run('integration-finishedlive', { ...finished, pid: process.pid });
  await run('integration-unknown');
  const linked = await run('integration-linked', finished);
  const outside = path.join(repo, 'project'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(linked, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.utimes(linked, old, old);
  const dry = await cleanTestOutput(repo, { keep: 1, now });
  assert.equal(dry.dryRun, true); assert.deepEqual(dry.candidates, ['integration-old']); assert.deepEqual(dry.removed, []);
  await fs.access(path.join(root, 'integration-old'));
  const applied = await cleanTestOutput(repo, { keep: 1, now, apply: true });
  assert.deepEqual(applied.removed, ['integration-old']); await assert.rejects(fs.access(path.join(root, 'integration-old')));
  for (const name of ['integration-new', 'integration-live', 'integration-unknown', 'integration-linked']) await fs.access(path.join(root, name));
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(cleanTestOutput(repo, { keep: 0 }), /keep/);
});

test('cleanup accepts completed legacy runs and refuses a linked output root', async t => {
  const { repo, root } = await cleanupRepo(t);
  const oldRun = path.join(root, 'integration-legacy');
  await fs.mkdir(path.join(oldRun, 'workspace'), { recursive: true });
  await fs.writeFile(path.join(oldRun, 'vscode-test.log'), 'completed');
  await fs.writeFile(path.join(oldRun, 'workspace', 'vscode-test-result.json'), '{"ok":true}');
  const old = new Date(Date.now() - 72 * 3600000); await fs.utimes(oldRun, old, old);
  await fs.mkdir(path.join(root, 'integration-new'));
  assert.deepEqual((await cleanTestOutput(repo, { keep: 1, apply: true })).removed, ['integration-legacy']);
  await fs.rename(root, path.join(repo, 'saved-output'));
  await fs.symlink(path.join(repo, 'saved-output'), root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanTestOutput(repo, { apply: true }), /루트/);
  await fs.access(path.join(repo, 'saved-output', 'integration-new'));
});
