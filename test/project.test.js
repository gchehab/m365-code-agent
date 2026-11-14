'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore, digest } = require('../src/workspace');
const { CodingAgent } = require('../src/agent');
const { parseReply } = require('../src/protocol');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm365-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"example"}\n');
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'exports.value = 1;\n');
  return { root, store: await new WorkspaceStore(root).initialize() };
}

test('project analysis reads real source before the first model request without attachments', async t => {
  const { store } = await fixture(t);
  const events = [];
  const agent = new CodingAgent({ store, emit: event => events.push(event), transport: { async request(prompt) {
    const data = JSON.parse(prompt.split('DATA: ')[1]);
    const reads = data.history.find(item => item.origin === 'automatic_workspace_inspection').observations;
    assert.ok(reads.some(item => item.result?.path === 'src/main.js' && item.result.content.includes('exports.value = 1;')));
    return { kind: 'done', message: 'src/main.js에서 진입 코드를 확인했습니다.' };
  } } });
  await agent.run('프로젝트를 분석해줘');
  assert.ok(events.some(event => event.type === 'tool' && event.label.includes('src/main.js') && event.state === 'done'));
});

test('nested tool arguments read a real file and the edit is applied to disk', async t => {
  const { root, store } = await fixture(t);
  let round = 0;
  const agent = new CodingAgent({ store, emit: () => {}, transport: { async request(prompt, id) {
    if (++round === 1) return parseReply(JSON.stringify({ requestId: id, kind: 'tools', calls: [{ function: { name: 'read_file', arguments: JSON.stringify({ file_path: './src/main.js', start_line: 1 }) } }] }), id);
    if (round === 2) {
      const observations = JSON.parse(prompt.split('DATA: ')[1]).history.at(-1).observations;
      const file = observations[0].result;
      assert.equal(file.content, 'exports.value = 1;\n');
      return { kind: 'changes', files: [{ path: file.path, action: 'edit', baseHash: file.hash, edits: [{ oldText: 'exports.value = 1;', newText: 'exports.value = 2;' }] }] };
    }
    return { kind: 'done', message: '실제 파일 수정 완료' };
  } }, approveAndApply: async changes => { await store.verifyChanges(changes); for (const change of changes) await fs.writeFile(change.target, change.content); return true; } });
  await agent.run('src/main.js의 value를 2로 수정해줘');
  assert.equal(await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'), 'exports.value = 2;\n');
});

test('file reads and partial edits support files over 128KB and paging within long lines', async t => {
  const { root, store } = await fixture(t);
  const content = 'exports.value = 1;\n' + '// filler line\n'.repeat(20000);
  await fs.writeFile(path.join(root, 'src', 'large.js'), content);
  const file = await store.readFile('src/large.js', { startLine: 1, lineCount: 2, maxCharacters: 1000 });
  assert.equal(file.hash, digest(content)); assert.equal(file.complete, false);
  const changes = await store.prepareChanges([{ path: file.path, action: 'edit', baseHash: file.hash, edits: [{ oldText: 'exports.value = 1;', newText: 'exports.value = 3;' }] }]);
  assert.equal(changes[0].content, content.replace('exports.value = 1;', 'exports.value = 3;'));
  const long = '0123456789'.repeat(1000);
  await fs.writeFile(path.join(root, 'long.js'), long);
  let line = 1, column = 1, result = '';
  do {
    const page = await store.readFile('long.js', { startLine: line, startColumn: column, lineCount: 1, maxCharacters: 333 });
    result += page.content; line = page.nextLine; column = page.nextColumn;
  } while (line !== null);
  assert.equal(result, long);
});

test('directory listing and scoped search reach nested project code', async t => {
  const { store } = await fixture(t);
  assert.deepEqual((await store.listFiles(10, './src')).files, ['src/main.js']);
  assert.equal((await store.search('value', ['src'])).matches[0].path, 'src/main.js');
});

test('a model cannot report a requested edit completed without applying changes', async t => {
  const { store } = await fixture(t);
  let count = 0;
  const agent = new CodingAgent({ store, emit: () => {}, transport: { async request() { count++; return { kind: 'done', message: '수정 완료' }; } } });
  await assert.rejects(agent.run('main.js를 수정해줘'), /적용한 파일은 0개/);
  assert.equal(count, 2);
});

test('UTF-16 BOM source files can be read without being mistaken for binary', async t => {
  const { root, store } = await fixture(t);
  const content = 'public class Example { }\r\n';
  await fs.writeFile(path.join(root, 'Example.cs'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
  assert.equal((await store.readFile('Example.cs')).content, content);
});
