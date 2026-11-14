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

test('Ask and Plan enforce read-only behavior and include previous conversation', async t => {
  for (const mode of ['ask', 'plan']) {
    const { store } = await fixture(t);
    let applied = false, executed = false, round = 0;
    const agent = new CodingAgent({ store, mode, conversation: [{ role: 'user', text: '이전 요청의 문맥' }], emit: () => {},
      approveAndApply: async () => { applied = true; }, runCommand: async () => { executed = true; },
      transport: { async request(prompt, id) {
        assert.match(prompt, /이전 요청의 문맥/);
        if (++round === 1) return { kind: 'tools', calls: [{ name: 'run_command', command: 'echo forbidden' }] };
        if (round === 2) return { kind: 'changes', files: [{ path: 'new.txt', action: 'create', baseHash: null, content: 'bad' }] };
        return { kind: 'done', message: '읽기 전용 완료' };
      } }
    });
    await agent.run('조사해줘');
    assert.equal(applied, false); assert.equal(executed, false);
  }
});

test('command output and exit code return to the agent as tool observations', async t => {
  const { store } = await fixture(t);
  let round = 0;
  const events = [];
  const agent = new CodingAgent({ store, emit: event => events.push(event), runCommand: async () => ({ exitCode: 1, output: 'failed assertion' }),
    transport: { async request(prompt) {
      if (++round === 1) return { kind: 'tools', calls: [{ name: 'run_command', command: 'npm test' }] };
      assert.match(prompt, /failed assertion/); assert.match(prompt, /"exitCode":1/);
      return { kind: 'done', message: '테스트 실패 확인' };
    } }
  });
  await agent.run('테스트해줘');
  assert.equal(events.filter(event => event.type === 'tool' && event.label.startsWith('run_command')).length, 2);
});

test('command runner captures failures, bounds output and terminates timed-out jobs', async t => {
  const { root } = await fixture(t);
  const { CommandRunner } = require('../src/terminal');
  const runner = new CommandRunner();
  const node = '"' + process.execPath + '"';
  const result = await runner.run(`${node} -e "console.log('x'.repeat(15000));process.exit(3)"`, root);
  assert.equal(result.exitCode, 3); assert.equal(result.truncated, true); assert.ok(result.output.length <= 12000);
  const timed = await runner.run(`${node} -e "setInterval(()=>{},1000)"`, root, () => {}, 200);
  assert.equal(timed.timedOut, true);
});

test('compact prompts use standard JSON fencing and retain code whitespace as escaped data', () => {
  const source = 'def hello():\n    print("a  b")\n';
  const prompt = buildPrompt({ id: 'compact', task: '설명해줘', workspace: 'sample', files: { files: [], truncated: false }, history: [], extraContext: JSON.stringify([{ path: 'a.py', content: source }]) });
  assert.ok(prompt.length < 2500);
  assert.equal(prompt.includes('\n'), false);
  assert.equal(prompt.includes('m365-agent'), false);
  assert.match(prompt, /standard json/);
  assert.equal(JSON.parse(prompt.split('DATA: ')[1]).context[0].content, source);
});

test('prompt budgeting preserves the task, marks omissions and never silently truncates file bodies', () => {
  const task = '사용자 요청 전체를 유지해줘.';
  const history = [{ kind: 'tool_results', observations: [{ call: { name: 'read_file', path: 'large.txt' }, result: { hash: 'abc', content: 'large'.repeat(4000) } }] }];
  const prompt = buildPrompt({ id: 'budget', task, workspace: 'sample', files: { files: Array.from({ length: 250 }, (_, i) => `long/path/to/source-${i}.js`), truncated: false }, extraContext: JSON.stringify([{ path: 'attached.py', content: 'x'.repeat(10000) }]), history, maxCharacters: 4000 });
  assert.ok(prompt.length <= 4000);
  const data = JSON.parse(prompt.split('DATA: ')[1]);
  assert.equal(data.task, task);
  assert.equal(data.files.truncated, true);
  assert.ok(data.context[0].omitted);
  assert.ok(data.history[0].observations[0].error);
  assert.equal(data.history[0].observations[0].result, undefined);
  assert.equal(history[0].observations[0].result.hash, 'abc');
});

test('agent rebuilds a request only after a confirmed pre-submit length rejection', async t => {
  const { store } = await fixture(t);
  const { promptLimitError } = require('../src/composer');
  let attempts = 0;
  const agent = new CodingAgent({ store, emit: () => {}, transport: { async request(prompt) {
    if (++attempts === 1) { assert.ok(prompt.length > 4000); throw promptLimitError(4000, prompt.length); }
    assert.ok(prompt.length <= 4000);
    return { kind: 'done', message: '자동 축소 후 완료' };
  } } });
  assert.equal((await agent.run('한도를 맞춰줘', JSON.stringify([{ path: 'big.txt', content: 'x'.repeat(6000) }]))).status, 'done');
  assert.equal(attempts, 2);
  attempts = 0;
  agent.transport.request = async () => { attempts++; throw new Error('전송 확인 실패'); };
  await assert.rejects(agent.run('중복 전송 금지'), /전송 확인/);
  assert.equal(attempts, 1);
});

test('large files support paged reads and exact partial edits without a complete read', async t => {
  const { root, store } = await fixture(t);
  const original = Array.from({ length: 1000 }, (_, i) => `const item${i} = "${'x'.repeat(65)}";`).join('\r\n');
  await fs.writeFile(path.join(root, 'large.js'), original);
  const page = await store.readFile('large.js', { startLine: 400, lineCount: 5, maxCharacters: 2000 });
  assert.equal(page.startLine, 400); assert.equal(page.endLine, 404); assert.equal(page.totalLines, 1000); assert.equal(page.complete, false); assert.equal(page.nextLine, 405);
  assert.equal(store.ledger.has('large.js'), false);
  assert.ok(page.content.length < 2000);
  const changes = await store.prepareChanges([{ path: 'large.js', action: 'edit', baseHash: page.hash, edits: [{ oldText: 'const item400 =', newText: 'const fixed400 =' }] }]);
  assert.equal(changes[0].content, original.replace('const item400 =', 'const fixed400 ='));
  await assert.rejects(store.prepareChanges([{ path: 'large.js', action: 'replace', baseHash: page.hash, content: 'bad' }]), /먼저/);
  await assert.rejects(store.prepareChanges([{ path: 'large.js', action: 'edit', baseHash: page.hash, edits: [{ oldText: 'const item900 =', newText: 'bad' }] }]), /읽은 범위/);
  await fs.writeFile(path.join(root, 'large.js'), original + '// user change');
  await assert.rejects(store.verifyChanges(changes), /변경/);
});

test('partial edits reject ambiguous, overlapping and stale anchors, and preserve CRLF', async t => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'edit.txt'), 'same same\r\nunique alpha beta\r\nlast\r\n');
  const file = await store.readFile('edit.txt', { startLine: 1, lineCount: 3, maxCharacters: 1000 });
  const proposal = edits => [{ path: file.path, action: 'edit', baseHash: file.hash, edits }];
  await assert.rejects(store.prepareChanges(proposal([{ oldText: 'same', newText: 'x' }])), /한 번/);
  await assert.rejects(store.prepareChanges(proposal([{ oldText: 'unique alpha', newText: 'a' }, { oldText: 'alpha beta', newText: 'b' }])), /겹칩니다/);
  const changes = await store.prepareChanges(proposal([{ oldText: 'unique alpha beta\nlast', newText: 'unique changed\nlast' }]));
  assert.equal(changes[0].content, 'same same\r\nunique changed\r\nlast\r\n');
  await fs.writeFile(path.join(root, 'edit.txt'), 'changed');
  await assert.rejects(store.prepareChanges(proposal([{ oldText: 'unique alpha beta', newText: 'x' }])), /변경/);
});

test('search reads disk directly and never invokes editor hooks or grants an edit read', async t => {
  const { root } = await fixture(t);
  let hooks = 0;
  const store = await new WorkspaceStore(root, async () => { hooks++; return 'unsaved content'; }).initialize();
  assert.equal((await store.search('reduce')).matches.length, 1);
  assert.equal(hooks, 0); assert.equal(store.ledger.size, 0); assert.equal(store.editReads.size, 0);
  assert.equal((await store.readFile('src/average.js')).content, 'unsaved content');
  assert.equal(hooks, 1);
});

test('additional credential and state file names are excluded', async t => {
  const { store } = await fixture(t);
  for (const name of ['.npmrc', 'nested/.netrc', 'id_rsa', 'id_ed25519', 'credentials', 'credentials.json', 'terraform.tfstate', 'terraform.tfstate.backup', 'appsettings.json', 'appsettings.Production.json', '.docker/config.json', '.kube/config']) assert.throws(() => store.normalize(name), /제외/);
  assert.equal(store.normalize('src/credentials-helper.js'), 'src/credentials-helper.js');
});

test('execution settings always require review', () => {
  const { requiresReview } = require('../src/policy');
  for (const file of ['package.json', 'sub/package-lock.json', '.vscode/tasks.json', '.github/workflows/ci.yml', 'Makefile', 'scripts/test.ps1', 'setup.py', 'Dockerfile', 'build.gradle', 'x.csproj']) assert.equal(requiresReview(file), true, file);
  assert.equal(requiresReview('src/average.js'), false);
  assert.equal(requiresReview('README.md'), false);
});

test('stream decoding preserves UTF-8 split characters and CP949 output', () => {
  const { outputDecoder } = require('../src/terminal');
  const utf8 = outputDecoder('utf8');
  let text = '';
  for (const byte of Buffer.from('한글🙂')) text += utf8.write(Buffer.from([byte]));
  assert.equal(text + utf8.end(), '한글🙂');
  const korean = outputDecoder('cp949');
  text = '';
  for (const byte of [0xc7, 0xd1, 0xb1, 0xdb]) text += korean.write(Buffer.from([byte]));
  assert.equal(text + korean.end(), '한글');
});
