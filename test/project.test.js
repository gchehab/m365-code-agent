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

test('a completion with no edits reports actual zero changes without forcing a changes response', async t => {
  const { store } = await fixture(t);
  let count = 0; const events = [];
  const agent = new CodingAgent({ store, emit: event => events.push(event), transport: { async request() { count++; return { kind: 'done', message: '수정 완료' }; } } });
  assert.equal((await agent.run('main.js를 수정해줘')).appliedFiles, 0);
  assert.equal(count, 1);
  assert.match(events.at(-2).text, /실제 적용한 파일: 0개/);
});

test('UTF-16 BOM source files can be read without being mistaken for binary', async t => {
  const { root, store } = await fixture(t);
  const content = 'public class Example { }\r\n';
  await fs.writeFile(path.join(root, 'Example.cs'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
  assert.equal((await store.readFile('Example.cs')).content, content);
});

test('natural-language questions cannot be forced into edits and unknown edit wording retains tools', async t => {
  const { resolveTask } = require('../src/task');
  assert.deepEqual(resolveTask('/ask README 수정해줘'), { mode: 'ask', task: 'README 수정해줘' });
  assert.deepEqual(resolveTask('/agent 왜 수정이 필요한지 설명해줘'), { mode: 'agent', task: '왜 수정이 필요한지 설명해줘' });
  assert.equal(resolveTask('/ASK').mode, 'ask'); assert.ok(resolveTask('/ASK').task.length > 0);
  assert.equal(resolveTask('/agent').mode, 'agent'); assert.ok(resolveTask('/agent').task.length > 0);
  assert.equal(resolveTask('/asker 이름 설명해줘').task, '/asker 이름 설명해줘');
  const edits = ['README 업데이트해줘', '리팩토링해줘', '정리해줘', '개선해줘', '로그 넣어줘', '빈 배열은 null로 반환하고 회귀 테스트도 생성해줘.', 'explain and fix the bug', '설명하고 버그를 고쳐줘'];
  for (const task of edits) assert.equal(resolveTask(task).mode, 'agent', task);
  const questions = ['어떻게 수정하면 좋을지 알려줘', '왜 수정이 필요한지 설명해줘', '수정하지 말고 설명해줘.', '구현 계획을 알려줘.', '앞의 작업을 설명해줘.', 'Explain how to fix this bug'];
  const { store } = await fixture(t);
  for (const task of questions) {
    const resolved = resolveTask(task);
    assert.notEqual(resolved.mode, 'agent', task);
    let requests = 0, approvals = 0;
    const agent = new CodingAgent({ store, ...resolved, emit: () => {}, approveAndApply: async () => { approvals++; }, transport: { async request() { requests++; return { kind: 'done', message: '설명입니다.' }; } } });
    assert.equal((await agent.run(resolved.task)).appliedFiles, 0);
    assert.equal(requests, 1, task); assert.equal(approvals, 0, task);
  }
});

test('default budget permits more than twenty rounds and configured limits still stop execution', async t => {
  const { root, store } = await fixture(t); const events = []; let count = 0;
  await fs.writeFile(path.join(root, 'src/main.js'), Array.from({length: 40}, (_, i) => 'const line' + i + ' = ' + i + ';').join('\n'));
  const transport = { async request() { if (++count <= 25) return { kind: 'tools', calls: [{ name: 'read_file', path: 'src/main.js', startLine: count, lineCount: 1 }] }; return { kind: 'done', message: '26번째 요청에서 완료' }; } };
  const agent = new CodingAgent({ store, emit: event => events.push(event), transport });
  assert.equal((await agent.run('프로젝트를 분석해줘')).status, 'done');
  assert.equal(count, 26);
  const progress = events.filter(event => event.type === 'progress');
  assert.equal(progress[0].total, 100); assert.equal(progress.at(-1).remaining, 74);
  count = 0;
  const limited = new CodingAgent({ store, maxRounds: 2, emit: () => {}, transport });
  await assert.rejects(limited.run('프로젝트를 분석해줘'), /안전 한도 2회/);
  assert.equal(count, 2);
});

test('a read-only question rejects model-proposed changes instead of invoking approval/apply', async t => {
  const { store } = await fixture(t), { resolveTask } = require('../src/task');
  let requests = 0, approvals = 0;
  const task = '왜 수정이 필요한지 설명해줘';
  const agent = new CodingAgent({ store, ...resolveTask(task), emit: () => {}, approveAndApply: async () => { approvals++; }, transport: { async request() {
    if (++requests === 1) return { kind: 'changes', files: [{ path: 'unexpected.js', action: 'create', baseHash: null, content: 'unexpected' }] };
    return { kind: 'done', message: '설명입니다.' };
  } } });
  assert.equal((await agent.run(task)).appliedFiles, 0);
  assert.equal(approvals, 0);
});

test('bounded tool batches retain useful source and explicitly defer excess calls without execution', async t => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'src/main.js'), 'x'.repeat(3000));
  let requests = 0, commands = 0;
  const agent = new CodingAgent({ store, maxPromptCharacters: 12000, emit: () => {}, runCommand: async () => { commands++; }, transport: { async request(prompt) {
    if (++requests === 1) return { kind: 'tools', calls: [{ name: 'read_file', path: 'src/main.js' }, { name: 'read_file', path: 'src/main.js' }, { name: 'run_command', command: 'unexpected-command' }] };
    const data = JSON.parse(prompt.split('DATA: ')[1]);
    const results = data.history.at(-1).observations;
    assert.ok(results[0].result.content.length >= 2500); assert.ok(results[1].result.content.length >= 2500);
    assert.match(results[2].error, /실행하지 않았습니다/);
    assert.ok(prompt.length <= 12000);
    return { kind: 'done', message: '읽음' };
  } } });
  await agent.run('본문 분석');
  assert.equal(commands, 0);
});
