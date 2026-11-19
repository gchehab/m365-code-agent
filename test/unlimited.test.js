'use strict';
require('../src/i18n').setLanguage('ko');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodingAgent } = require('../src/agent');
const { WorkspaceStore } = require('../src/workspace');
const { buildPrompt } = require('../src/protocol');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm365-unlimited-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.js'), Array.from({ length: 130 }, (_, index) => `const value${index} = ${index};`).join('\n'));
  return new WorkspaceStore(root).initialize();
}

test('unlimited progressing tasks pass 100 rounds without changing the finite ceiling or approval policy', async () => {
  // This test measures loop/approval policy. Real disk reads and paging have their
  // own workspace tests; avoid 110 repeated filesystem traversals in this unit test.
  const store = { root: 'memory-project', async listFiles() { return { files: ['main.js'], truncated: false }; }, async readFile(name, { startLine = 1 } = {}) {
    return { path: name, hash: 'fixed-memory-source', content: `const value${startLine} = ${startLine};`, startLine, endLine: startLine, nextLine: startLine + 1, nextColumn: 1, totalLines: 130, complete: false };
  } };
  const events = []; let requests = 0;
  const agent = new CodingAgent({ store, unlimitedRounds: true, maxRounds: 2, emit: event => events.push(event), transport: { async request(prompt) {
    requests++; const data = JSON.parse(prompt.split('DATA: ')[1]);
    assert.equal(data.progress.unlimited, true); assert.equal(data.progress.limit, null); assert.equal(data.progress.round, requests);
    assert.match(prompt, /Commands need user approval/);
    return requests <= 110 ? { kind: 'tools', calls: [{ name: 'read_file', path: 'main.js', startLine: requests, lineCount: 1 }] } : { kind: 'done', message: 'Analysis complete.' };
  } } });
  assert.equal((await agent.run('Analyze this source.')).status, 'done');
  assert.equal(requests, 111); assert.equal(agent.maxRounds, 2); assert.equal(agent.autoApprove, false);
  const progress = events.filter(event => event.type === 'progress');
  assert.equal(progress.at(-1).round, 111); assert.equal(progress.at(-1).total, null); assert.equal(progress.at(-1).remaining, null);
  assert.ok(events.some(event => event.type === 'status' && event.text.includes('무제한')));
});

test('unlimited tasks still stop on repeated unchanged evidence', async t => {
  const store = await fixture(t); let requests = 0;
  const agent = new CodingAgent({ store, unlimitedRounds: true, emit() {}, transport: { async request() { requests++; return { kind: 'tools', calls: [{ name: 'read_file', path: 'main.js', startLine: 1, lineCount: 1 }] }; } } });
  await assert.rejects(agent.run('Analyze this source.'), { code: 'NO_PROGRESS' });
  assert.equal(requests, 3); assert.equal(agent.running, false);
});

test('stop cancels an unlimited automatically approved task without another request', async t => {
  const store = await fixture(t); let requests = 0, stopped = 0; const events = [];
  const agent = new CodingAgent({ store, unlimitedRounds: true, autoApprove: true, emit: event => events.push(event), transport: { async stop() { stopped++; }, async request() {
    requests++; if (requests === 5) await agent.stop();
    return { kind: 'tools', calls: [{ name: 'read_file', path: 'main.js', startLine: requests, lineCount: 1 }] };
  } } });
  await assert.rejects(agent.run('Analyze this source.'), /중지/);
  assert.equal(requests, 5); assert.equal(stopped, 1); assert.equal(agent.running, false); assert.equal(events.at(-1).type, 'idle');
});

test('bounded prompts preserve JSON-safe unlimited progress when context is reduced', () => {
  const prompt = buildPrompt({ id: 'test', task: 'Analyze this source.', workspace: 'test', files: [], maxCharacters: 4000,
    progress: { taskId: 'task', round: 101, limit: null, unlimited: true, appliedFiles: 0, noProgressRounds: 0, recentTools: [{ name: 'read_file', path: 'x'.repeat(6000) }] } });
  const data = JSON.parse(prompt.split('DATA: ')[1]);
  assert.equal(data.progress.unlimited, true); assert.equal(data.progress.limit, null); assert.equal(data.progress.round, 101);
  assert.ok(prompt.length <= 4000);
});
