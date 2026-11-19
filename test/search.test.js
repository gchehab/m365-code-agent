'use strict';
require('../src/i18n').setLanguage('ko');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore } = require('../src/workspace');
const { CodingAgent } = require('../src/agent');

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'm365-search-'));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (name, content) => {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };
  return { root, write, store: await new WorkspaceStore(root).initialize() };
}

test('retrieval reaches code beyond the old 1000-file inventory and reads the matching lines before the first turn', async t => {
  const { store, write } = await fixture(t);
  for (let start = 0; start < 1250; start += 50)
    await Promise.all(Array.from({ length: 50 }, (_, offset) =>
      write(`src/filler-${String(start + offset).padStart(4, '0')}.js`, 'export const unrelatedValue = 1;\n')));
  const target = 'zz-package/runtime/manager.ts';
  await write(target, '// unrelated heading\n'.repeat(240) +
    'export function refreshAccessToken() { return renewSessionRecord(); }\n');
  await write('docs/refresh-token-notes.md', 'refresh token notes\n'.repeat(200));
  assert.equal((await store.listFiles(1000)).files.includes(target), false);
  const literal = await store.search('renewSessionRecord');
  assert.equal(literal.matches[0].path, target);
  assert.equal(literal.searchedFiles, 1252);
  const events = [];
  const agent = new CodingAgent({ store, maxPromptCharacters: 12000, emit: event => events.push(event), transport: {
    async request(prompt) {
      const data = JSON.parse(prompt.split('DATA: ')[1]);
      assert.equal(data.files.files[0], target);
      const reads = data.history.find(entry => entry.origin === 'automatic_workspace_inspection').observations;
      const source = reads.find(entry => entry.result?.path === target).result;
      assert.ok(source.startLine > 200);
      assert.match(source.content, /refreshAccessToken/);
      assert.ok(prompt.length <= 12000);
      return { kind: 'done', message: '관련 코드의 실제 줄을 확인했습니다.' };
    },
  } });
  assert.equal((await agent.run('토큰 갱신 구현을 찾아줘')).status, 'done');
  assert.ok(events.some(event => event.id === 'project-search' && event.state === 'done'));
});

test('identifier terms rank related code and preserve columns for a long single line', async t => {
  const { store, write } = await fixture(t);
  await write('src/transport.ts', 'export function getHTTPClientConfig() { return {}; }\n');
  await write('src/long.ts', '// ' + 'padding '.repeat(1300) + 'function refreshAccessToken() {}');
  const identifiers = await store.searchCode('http client config');
  assert.equal(identifiers.matches[0].path, 'src/transport.ts');
  const long = await store.searchCode('refresh access token', ['src/long.ts']);
  assert.equal(long.matches[0].line, 1);
  assert.ok(long.matches[0].column > 6000);
  const result = await store.readFile(long.matches[0].path, {
    startLine: long.matches[0].line, startColumn: long.matches[0].column, lineCount: 1, maxCharacters: 400,
  });
  assert.match(result.content, /refreshAccessToken/);
});

test('search respects root and nested excludes, generated outputs, secrets and junctions even with explicit scopes', async t => {
  const { root, store, write } = await fixture(t);
  await write('.gitignore', 'ignored/\n');
  await write('.m365agentignore', '/private/\n');
  await write('ignored/hidden.ts', 'needleSearchValue');
  await write('private/hidden.ts', 'needleSearchValue');
  await write('dist/output.js', 'needleSearchValue');
  await write('.env.local', 'needleSearchValue');
  await write('packages/service/.gitignore', 'hidden.ts\nprivate/\n');
  await write('packages/service/hidden.ts', 'needleSearchValue');
  await write('packages/service/private/hidden.ts', 'needleSearchValue');
  await write('packages/service/public.ts', 'export const needleSearchValue = 1;');
  const outside = await fs.mkdtemp(path.join(path.dirname(root), 'm365-search-outside-'));
  t.after(async () => {
    assert.equal(path.dirname(outside), path.dirname(root));
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, 'secret.ts'), 'needleSearchValue');
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await store.searchCode('needle search value');
  assert.deepEqual(result.matches.map(match => match.path), ['packages/service/public.ts']);
  assert.deepEqual((await store.search('needleSearchValue')).matches.map(match => match.path), ['packages/service/public.ts']);
  for (const scope of ['packages/service/hidden.ts', 'packages/service/private', 'packages/service/private/hidden.ts'])
    assert.equal((await store.searchCode('needle search value', [scope])).matches.length, 0);
  await assert.rejects(store.searchCode('needle', ['escape']), /링크|정션/);
  await assert.rejects(store.searchCode('needle', ['../outside']), /경로/);
  await assert.rejects(store.searchCode('needle', ['.env.local']), /제외/);
});

test('cached searches reflect edits, additions, deletions and changed ignores without granting edit reads', async t => {
  const { root, store, write } = await fixture(t);
  await write('src/handler.ts', 'export function originalHandler() {}');
  let diskReads = 0;
  const load = store.loadFile.bind(store);
  store.loadFile = async (...args) => { diskReads++; return load(...args); };
  store.readText = async () => { throw new Error('Search must not read editor buffers'); };
  assert.equal((await store.searchCode('original handler')).matches[0].path, 'src/handler.ts');
  const firstReads = diskReads;
  assert.equal((await store.searchCode('original handler')).matches[0].path, 'src/handler.ts');
  assert.equal(diskReads, firstReads, 'unchanged source is reused');
  assert.equal(store.ledger.size, 0);
  assert.equal(store.editReads.size, 0);
  await assert.rejects(store.prepareChanges([{ path: 'src/handler.ts', action: 'edit', baseHash: '0'.repeat(64),
    edits: [{ oldText: 'originalHandler', newText: 'otherHandler' }] }]), /먼저/);
  await write('src/handler.ts', 'export function replacementHandler() {}');
  assert.equal((await store.searchCode('replacement handler')).matches[0].path, 'src/handler.ts');
  assert.equal((await store.searchCode('original')).matches.length, 0);
  await fs.unlink(path.join(root, 'src/handler.ts'));
  assert.equal((await store.searchCode('replacement')).matches.length, 0);
  await write('src/new.ts', 'export function replacementHandler() {}');
  assert.equal((await store.searchCode('replacement')).matches[0].path, 'src/new.ts');
  await write('src/.gitignore', 'new.ts\n');
  assert.equal((await store.searchCode('replacement')).matches.length, 0);
});

test('scope and resource limits report incomplete coverage, and cancellation interrupts indexing', async t => {
  const { store, write } = await fixture(t);
  await write('src/one.ts', 'export const needleOne = 1;');
  await write('src/two.ts', 'export const needleTwo = 2;');
  await write('large.txt', 'needle '.repeat(50000));
  const inventory = await store.discoverFiles({ limit: 1 });
  assert.equal(inventory.truncated, true);
  assert.ok(inventory.reasons.includes('inventory-limit'));
  const oversized = await store.searchCode('needle', ['large.txt']);
  assert.equal(oversized.matches.length, 0);
  assert.equal(oversized.truncated, true);
  assert.ok(oversized.reasons.includes('index-limit'));
  assert.equal((await store.searchCode('needle', ['src/one.ts'])).matches.length, 1);
  await assert.rejects(store.discoverFiles({ cancelled: () => true }), /중지/);
  let stopped = false;
  const load = store.loadFile.bind(store);
  store.codeIndex = null;
  store.loadFile = async (...args) => { const file = await load(...args); stopped = true; return file; };
  await assert.rejects(store.searchCode('needle', ['src'], () => stopped), /중지/);
});

test('the model can request ranked code search and receives observations without edit authorization', async t => {
  const { store, write } = await fixture(t);
  await write('src/misc.ts', 'export function dispatchPayment() {}');
  let rounds = 0;
  const agent = new CodingAgent({ store, mode: 'ask', emit() {}, transport: {
    async request(prompt) {
      assert.match(prompt.split('DATA: ')[0], /search_code\(query/);
      if (++rounds === 1) return { kind: 'tools', calls: [{ name: 'search_code', query: 'dispatch payment', paths: ['src'] }] };
      const data = JSON.parse(prompt.split('DATA: ')[1]);
      const result = data.history.at(-1).observations[0].result;
      assert.equal(result.matches[0].path, 'src/misc.ts');
      assert.equal(result.matches[0].line, 1);
      assert.equal(result.indexedFiles, 1);
      return { kind: 'done', message: '검색 결과 확인' };
    },
  } });
  assert.equal((await agent.run('결제 처리 위치를 찾아줘')).status, 'done');
  assert.equal(rounds, 2);
});
