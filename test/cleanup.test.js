'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { cleanTestOutput } = require('../scripts/clean-test-output.cjs');

test('test-output cleanup defaults to dry run and retains recent, running, unknown and linked folders', async t => {
  const output = path.resolve(__dirname, '..', '.test-output');
  const repo = await fs.mkdtemp(path.join(output, 'cleanup-fixture-'));
  t.after(async () => { assert.equal(path.dirname(repo), output); await fs.rm(repo, { recursive: true, force: true }); });
  const root = path.join(repo, '.test-output'); await fs.mkdir(root);
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
  const output = path.resolve(__dirname, '..', '.test-output');
  const repo = await fs.mkdtemp(path.join(output, 'cleanup-fixture-'));
  t.after(async () => { assert.equal(path.dirname(repo), output); await fs.rm(repo, { recursive: true, force: true }); });
  const root = path.join(repo, '.test-output'), oldRun = path.join(root, 'integration-legacy');
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
