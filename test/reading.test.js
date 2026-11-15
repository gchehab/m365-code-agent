'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { renderWebview } = require('../src/view');
const { renderResponse, ResponsePanel } = require('../src/response-panel');
const { decorate } = require('../src/markdown');
const root = path.resolve(__dirname, '..');
const theme = ':root{--vscode-foreground:#ddd;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#181818;--vscode-input-background:#252526;--vscode-input-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#393939;--vscode-focusBorder:#569cd6;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#333;--vscode-button-secondaryForeground:#ddd;--vscode-errorForeground:#f88;--vscode-font-family:Segoe UI,sans-serif;--vscode-editor-font-family:Consolas,monospace;--vscode-textLink-foreground:#79b8ff}';
const reply = '## 빈 배열 처리\n\n**원인:** 빈 배열에서 평균을 계산하면 `NaN`이 반환됩니다. 입력값을 먼저 확인하도록 수정했습니다.\n\n```javascript\nconst average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;\n```\n\n### 검증 결과\n\n- 빈 배열은 `null`을 반환합니다.\n- 일반 배열은 기존 결과를 유지합니다.\n\n| 입력 | 결과 |\n| --- | --- |\n| `[]` | `null` |\n| `[1, 2, 3]` | `2` |';
async function fixture(t, html, width = 360) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 820 } });
  const errors = []; page.on('pageerror', error => errors.push(error)); t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => { window.sent = []; window.saved = {}; window.acquireVsCodeApi = () => ({ getState: () => window.saved, setState: value => { window.saved = value; }, postMessage: message => window.sent.push(message) }); });
  await page.route('https://reading.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', body: file ? (file.endsWith('.css') ? theme : '') + await fs.readFile(path.join(root, 'media', file), 'utf8') : html });
  });
  await page.goto('https://reading.test/'); await page.waitForFunction(() => window.sent.some(item => item.type === 'ready'));
  return { page, host: data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data) };
}
const options = { nonce: 'test-nonce', cspSource: 'https://reading.test', resource: name => 'https://reading.test/' + name };

test('reading layout groups activity, preserves scroll through sync and provides code/response controls', async t => {
  const { page, host } = await fixture(t, renderWebview(options));
  const events = [
    { type: 'message', role: 'user', text: '빈 배열 오류를 수정하고 테스트해줘.' },
    { type: 'message', role: 'system', text: '프로젝트 파일 8개를 확인했습니다.' },
    { type: 'tool', id: 'read', label: 'read_file · src/average.js', state: 'done', detail: '실제 파일을 읽었습니다.' },
    { type: 'tool', id: 'test', label: 'run_command · npm test', state: 'done', detail: '테스트 통과' },
    decorate({ type: 'message', role: 'assistant', text: reply })
  ];
  await host({ type: 'history', sessionId: 'one', events, attachments: [], running: false });
  assert.equal(await page.locator('.activity').count(), 1);
  assert.equal(await page.locator('.activity').getAttribute('open'), null);
  assert.equal(await page.locator('.activity-title').textContent(), '작업 기록 · 3개');
  assert.equal(await page.locator('#composerOptions').getAttribute('open'), null);
  assert.equal(await page.locator('.markdown strong').evaluate(node => getComputedStyle(node).fontSize), '14px');
  assert.equal(await page.locator('.code-block pre').evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap');
  await page.locator('.wrap-button').click();
  assert.equal(await page.locator('.code-block pre').evaluate(node => getComputedStyle(node).whiteSpace), 'pre');
  await page.getByRole('button', { name: '코드 복사', exact: true }).click();
  const codeCopy = await page.evaluate(() => window.sent.find(item => item.type === 'copyCode'));
  assert.equal(codeCopy.text, 'const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;\n');
  await host({ type: 'copyResult', id: codeCopy.id, success: true });
  assert.equal(await page.locator('.copy-button').textContent(), '복사됨');
  await page.getByRole('button', { name: '크게 보기', exact: true }).click();
  assert.equal((await page.evaluate(() => window.sent.find(item => item.type === 'openResponse'))).text, reply);
  await page.locator('#readingOptions > summary').click(); await page.locator('#fontLarger').click();
  await page.locator('#wrapCode').uncheck();
  assert.equal(await page.evaluate(() => window.saved.readingSize), 15);
  assert.equal(await page.evaluate(() => window.saved.wrapCode), false);
  await page.locator('#readingOptions > summary').click();
  await fs.mkdir(path.join(root, '.test-output'), { recursive: true });
  await page.setViewportSize({ width: 420, height: 1000 });
  await page.evaluate(() => { document.documentElement.style.setProperty('--reading-font-size', '14px'); document.body.classList.add('wrap-code'); document.querySelector('.code-block').removeAttribute('data-wrap'); document.getElementById('messages').scrollTop = 0; });
  await page.screenshot({ path: path.join(root, '.test-output', 'reading-chat-dark.png') });
  for (const width of [280, 360, 540]) {
    await page.setViewportSize({ width, height: 820 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 360, height: 820 });
  const long = decorate({ type: 'message', role: 'assistant', text: Array(12).fill('기존 코드를 검토하고 빈 배열 처리와 반환값을 확인했습니다.').join('\n\n') });
  events.push(long); await host(long);
  await page.locator('#messages').evaluate(node => { node.scrollTop = 70; });
  await page.waitForFunction(() => !document.getElementById('jumpToLatest').hidden);
  const before = await page.locator('#messages').evaluate(node => node.scrollTop);
  const extra = decorate({ type: 'message', role: 'assistant', text: '추가 검증도 완료했습니다.' }); events.push(extra); await host(extra);
  assert.ok(Math.abs(await page.locator('#messages').evaluate(node => node.scrollTop) - before) < 2, 'new reply does not steal scroll');
  await host({ type: 'history', sessionId: 'one', events, attachments: [], running: false });
  assert.ok(Math.abs(await page.locator('#messages').evaluate(node => node.scrollTop) - before) < 2, 'web sync preserves reading position');
  await page.locator('#jumpToLatest').click();
  assert.equal(await page.locator('#jumpToLatest').isVisible(), false);
  assert.ok(await page.locator('#messages').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 3));
  await host({ type: 'tool', id: 'broken', label: 'read_file · missing.js', state: 'error', detail: '파일을 찾지 못했습니다.' });
  assert.equal(await page.locator('.activity').last().evaluate(node => node.open), true, 'errors stay discoverable');
  await host({ type: 'history', sessionId: 'two', events, attachments: [], running: false });
  assert.ok(await page.locator('#messages').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 3), 'switching chats starts at latest');
});

test('wide response reader safely renders Markdown and applies reading preferences', async t => {
  const { page, host } = await fixture(t, renderResponse({ ...options, text: reply + '\n\n<img src=x onerror=alert(1)> [unsafe](javascript:alert(1))' }), 980);
  await host({ type: 'readingSettings', readingSize: 16, wrapCode: true });
  assert.equal(await page.locator('main').evaluate(node => getComputedStyle(node).fontSize), '16px');
  assert.equal(await page.locator('main img,main a[href^="javascript:"]').count(), 0);
  assert.ok(await page.locator('main').evaluate(node => node.getBoundingClientRect().width) >= 700);
  await page.locator('#copyResponse').click();
  const copy = await page.evaluate(() => window.sent.find(item => item.type === 'copyResponse'));
  await host({ type: 'copyResult', id: copy.id, success: false });
  assert.equal(await page.locator('#copyResponse').textContent(), '복사 실패');
  await page.screenshot({ path: path.join(root, '.test-output', 'reading-response-wide.png') });
  await page.evaluate(() => { const vars = { '--vscode-foreground': '#242424', '--vscode-descriptionForeground': '#616161', '--vscode-editor-background': '#ffffff', '--vscode-sideBar-background': '#f3f3f3', '--vscode-input-background': '#f5f5f5', '--vscode-panel-border': '#d5d5d5', '--vscode-textLink-foreground': '#006ab1', '--vscode-button-secondaryBackground': '#e5e5e5', '--vscode-button-secondaryForeground': '#333' }; for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value); });
  await page.screenshot({ path: path.join(root, '.test-output', 'reading-response-light.png') });
});

test('response panel reuses one read-only editor and routes clipboard acknowledgements to it', async () => {
  let panels = 0, receive, disposed;
  const posted = [], copied = [];
  const panel = { webview: { cspSource: 'test', asWebviewUri: value => value, onDidReceiveMessage: fn => { receive = fn; }, postMessage: value => posted.push(value) }, onDidDispose: fn => { disposed = fn; }, reveal() {}, dispose() { disposed(); } };
  const vscode = { ViewColumn: { Active: 1 }, Uri: { joinPath: (_base, ...parts) => parts.join('/') }, window: { createWebviewPanel() { panels++; return panel; } } };
  const reader = new ResponsePanel({ context: { extensionUri: 'test' }, copyText: (value, target) => copied.push({ value, target }) }, vscode);
  reader.show({ text: 'First' }); reader.show({ text: 'Second', readingSize: 16, wrapCode: false });
  assert.equal(panels, 1); receive({ type: 'ready' }); assert.deepEqual(posted.at(-1), { type: 'readingSettings', readingSize: 16, wrapCode: false });
  receive({ type: 'copyResponse', id: 'copy' }); assert.equal(copied[0].value.text, 'Second'); assert.equal(copied[0].target, panel.webview);
  reader.show({ text: '<script>unsafe()</script>' }); assert.ok(!panel.webview.html.includes('<script>unsafe()'));
  reader.dispose(); assert.equal(reader.text, ''); assert.equal(reader.panel, null);
});
