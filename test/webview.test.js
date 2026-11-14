'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');

test('chat UI handles submission, Korean IME, progress, approvals and narrow layouts', async t => {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'src', 'extension.js');
  const localRequire = createRequire(source);
  let provider;
  const noop = () => {};
  const vscode = {
    window: { createOutputChannel: () => ({ appendLine: noop, dispose: noop }), registerWebviewViewProvider: (_id, value) => { provider = value; } },
    workspace: { registerTextDocumentContentProvider: noop }, commands: { registerCommand: noop },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }
  };
  const sandbox = { require: name => name === 'vscode' ? vscode : localRequire(name), module: { exports: {} } };
  vm.runInNewContext(await fs.readFile(source, 'utf8'), sandbox, { filename: source });
  sandbox.module.exports.activate({ workspaceState: { get: (_key, fallback) => fallback, update: noop }, subscriptions: [], extensionUri: { fsPath: root } });
  const view = { webview: { cspSource: 'https://agent.test', asWebviewUri: uri => 'https://agent.test/' + path.basename(uri.fsPath), onDidReceiveMessage: noop } };
  provider.resolveWebviewView(view);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  await page.addInitScript(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: message => window.sent.push(message) });
  });
  await page.route('https://agent.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const theme = ':root{--vscode-foreground:#ddd;--vscode-sideBar-background:#181818;--vscode-input-background:#252526;--vscode-input-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#444;--vscode-focusBorder:#569cd6;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#333;--vscode-button-secondaryForeground:#ddd;--vscode-errorForeground:#f88;--vscode-font-family:Segoe UI,sans-serif;--vscode-editor-font-family:Consolas,monospace;--vscode-textLink-foreground:#79b8ff}';
    await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', body: file ? (file.endsWith('.css') ? theme : '') + await fs.readFile(path.join(root, 'media', file), 'utf8') : view.webview.html });
  });
  await page.goto('https://agent.test/');
  await page.waitForFunction(() => window.sent.some(message => message.type === 'ready'));
  assert.equal(await page.locator('#review').isChecked(), true);
  const input = page.locator('#task');
  await input.fill('첫 줄'); await input.press('Shift+Enter');
  assert.equal((await page.evaluate(() => window.sent.filter(message => message.type === 'run'))).length, 0);
  await input.evaluate(element => { element.dispatchEvent(new CompositionEvent('compositionstart')); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); element.dispatchEvent(new CompositionEvent('compositionend')); });
  assert.equal((await page.evaluate(() => window.sent.filter(message => message.type === 'run'))).length, 0);
  await input.press('Enter');
  assert.equal((await page.evaluate(() => window.sent.filter(message => message.type === 'run'))).length, 1);
  assert.equal(await page.locator('#stop').isVisible(), true);
  const host = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  await host({ type: 'message', role: 'user', text: '빈 배열 오류를 수정하고 테스트해줘.' });
  await host({ type: 'tool', id: 'read-1', label: 'read_file · src/average.js', state: 'running' });
  await host({ type: 'tool', id: 'read-1', label: 'read_file · src/average.js', state: 'done' });
  assert.equal(await page.locator('.tool').count(), 1);
  await host({ type: 'message', role: 'assistant', text: '빈 배열에는 null을 반환하도록 수정합니다.\n```js\naverage([]) === null\n```' });
  await host({ type: 'changes', summary: '빈 배열 처리 및 회귀 테스트', files: [{ id: 'preview-1', path: 'src/average.js', action: 'replace' }], review: true, token: 'review-123' });
  await page.locator('#apply').click();
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'apply'))).token, 'review-123');
  await host({ type: 'commandApproval', command: 'npm test', root: 'C:\\workspace\\sample', token: 'cmd-123' });
  await page.locator('#approveCommand').click();
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'approveCommand'))).token, 'cmd-123');
  await host({ type: 'idle' });
  await host({ type: 'status', text: '전송을 확인하지 못했습니다.', error: true });
  assert.equal(await page.locator('#status.error').textContent(), '전송을 확인하지 못했습니다.');
  for (const width of [280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await host({ type: 'status', text: '변경 검토 · 파일을 눌러 diff를 확인하세요.' });
  await host({ type: 'changes', summary: '빈 배열 처리 및 회귀 테스트', files: [{ id: 'preview-1', path: 'src/average.js', action: 'replace' }, { id: 'preview-2', path: 'test/average.test.js', action: 'create' }], review: true, token: 'new' });
  await fs.mkdir(path.join(root, '.test-output'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.test-output', 'agent-ui.png') });
});
