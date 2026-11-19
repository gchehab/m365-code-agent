'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { renderWebview } = require('../src/view');
const { renderResponse, ResponsePanel } = require('../src/response-panel');
const { decorate } = require('../src/markdown');
const structuredAnswer = require('./fixtures/structured-answer.json');
const root = path.resolve(__dirname, '..');
const theme = ':root{--vscode-foreground:#ddd;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#181818;--vscode-input-background:#252526;--vscode-input-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#393939;--vscode-focusBorder:#569cd6;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#333;--vscode-button-secondaryForeground:#ddd;--vscode-errorForeground:#f88;--vscode-font-family:Segoe UI,sans-serif;--vscode-editor-font-family:Consolas,monospace;--vscode-textLink-foreground:#79b8ff}';
const reply = '## 빈 배열 처리\n\n**원인:** 빈 배열에서 평균을 계산하면 `NaN`이 반환됩니다. 입력값을 먼저 확인하도록 수정했습니다.\n\n```javascript\nconst average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;\n```\n\n### 검증 결과\n\n- 빈 배열은 `null`을 반환합니다.\n- 일반 배열은 기존 결과를 유지합니다.\n\n| 입력 | 결과 |\n| --- | --- |\n| `[]` | `null` |\n| `[1, 2, 3]` | `2` |';
async function fixture(t, html, width = 360, initialState = {}) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 820 } });
  const errors = []; page.on('pageerror', error => errors.push(error)); t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(state => { window.sent = []; window.saved = state; window.acquireVsCodeApi = () => ({ getState: () => window.saved, setState: value => { window.saved = value; }, postMessage: message => window.sent.push(message) }); }, initialState);
  await page.route('https://reading.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', body: file ? (file.endsWith('.css') ? theme : '') + await fs.readFile(path.join(root, 'media', file), 'utf8') : html });
  });
  await page.goto('https://reading.test/'); await page.waitForFunction(() => window.sent.some(item => item.type === 'ready'));
  return { page, host: data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data) };
}
const options = { nonce: 'test-nonce', cspSource: 'https://reading.test', resource: name => 'https://reading.test/' + name };

test('structured analysis reads as sections in the real chat and uses the same text for copy and wide view', async t => {
  const { page, host } = await fixture(t, renderWebview(options));
  const original = JSON.stringify(structuredAnswer);
  const answer = decorate({ type: 'message', role: 'assistant', text: original }, '프로젝트 분석');
  await host(answer);
  assert.equal(await page.locator('.markdown h2').first().textContent(), '프로젝트 구조');
  assert.ok((await page.locator('.markdown').textContent()).includes(structuredAnswer.summary));
  assert.ok(!(await page.locator('.markdown').textContent()).includes('"projectStructure"'));
  await page.getByRole('button', { name: '답변 복사', exact: true }).click();
  const copied = await page.evaluate(() => window.sent.find(item => item.type === 'copyCode'));
  assert.equal(copied.text, answer.text);
  await page.getByRole('button', { name: '크게 보기', exact: true }).click();
  const expanded = await page.evaluate(() => window.sent.find(item => item.type === 'openResponse'));
  assert.equal(expanded.text, answer.text);
  assert.equal(original, JSON.stringify(structuredAnswer));
  await fs.mkdir(path.join(root, '.test-output'), { recursive: true });
  await page.locator('#messages').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(root, '.test-output', 'structured-answer-chat.png') });
});

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

test('automatic approval is off by default, visible when selected, and snapshotted into each submitted task', async t => {
  const { page, host } = await fixture(t, renderWebview(options));
  assert.equal(await page.locator('#autoApprove').isChecked(), false);
  assert.equal(await page.locator('#unlimitedRounds').isChecked(), false);
  await page.locator('#task').fill('첫 요청'); await page.locator('#task').press('Enter');
  assert.equal((await page.evaluate(() => window.sent.filter(item => item.type === 'run').at(-1))).autoApprove, false);
  await host({ type: 'idle' });
  await page.locator('#composerOptions > summary').click();
  await page.locator('#autoApprove').check();
  assert.equal(await page.locator('#review').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.saved.autoApprove), true);
  await page.screenshot({ path: path.join(root, '.test-output', 'automatic-approval-ui.png') });
  await page.locator('#composerOptions > summary').click();
  assert.equal(await page.locator('#approvalMode').isVisible(), true);
  assert.equal(await page.locator('#approvalMode').textContent(), '승인 없이 진행');
  await page.locator('#task').fill('샘플을 수정하고 테스트해줘.'); await page.locator('#task').press('Enter');
  assert.equal((await page.evaluate(() => window.sent.filter(item => item.type === 'run').at(-1))).autoApprove, true);
  assert.equal(await page.locator('#autoApprove').isDisabled(), true);
  await host({ type: 'idle' });
  assert.equal(await page.locator('#review').isDisabled(), true);
  await page.locator('#composerOptions > summary').click(); await page.locator('#autoApprove').uncheck();
  assert.equal(await page.locator('#review').isDisabled(), false);
  assert.equal(await page.locator('#review').isChecked(), true);
  assert.equal(await page.evaluate(() => window.saved.autoApprove), false);
  for (const width of [280, 360]) { await page.setViewportSize({ width, height: 720 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
});

test('unlimited requests and automatic approval restore and submit as four independent choices', async t => {
  const { page, host } = await fixture(t, renderWebview(options), 360, { unlimitedRounds: true, autoApprove: false });
  assert.equal(await page.locator('#unlimitedRounds').isChecked(), true);
  assert.equal(await page.locator('#autoApprove').isChecked(), false);
  for (const [unlimited, automatic] of [[false, false], [true, false], [false, true], [true, true]]) {
    await page.locator('#composerOptions > summary').click();
    await page.locator('#unlimitedRounds').setChecked(unlimited);
    await page.locator('#autoApprove').setChecked(automatic);
    assert.equal(await page.locator('#review').isDisabled(), automatic);
    await page.locator('#composerOptions > summary').click();
    assert.equal(await page.locator('#roundMode').isVisible(), unlimited);
    assert.equal(await page.locator('#approvalMode').textContent(), automatic ? '승인 없이 진행' : '승인 켜짐');
    await page.locator('#task').fill('이 프로젝트를 분석해줘.'); await page.locator('#task').press('Enter');
    const request = await page.evaluate(() => window.sent.filter(item => item.type === 'run').at(-1));
    assert.equal(request.unlimitedRounds, unlimited); assert.equal(request.autoApprove, automatic);
    assert.equal(await page.locator('#unlimitedRounds').isDisabled(), true);
    assert.equal(await page.locator('#autoApprove').isDisabled(), true);
    await host({ type: 'progress', round: 101, total: unlimited ? null : 150, remaining: unlimited ? null : 49, unlimited });
    assert.equal(await page.locator('#roundProgress').textContent(), unlimited ? 'Copilot 요청 101회 · 무제한' : 'Copilot 요청 101회 · 안전 한도 150회');
    await host({ type: 'idle' }); await host({ type: 'runResult', clientRequestId: request.clientRequestId, success: true });
  }
  assert.equal(await page.evaluate(() => window.saved.unlimitedRounds), true);
  assert.equal(await page.evaluate(() => window.saved.autoApprove), true);
  await page.locator('#composerOptions > summary').click();
  await page.setViewportSize({ width: 360, height: 900 });
  await page.screenshot({ path: path.join(root, '.test-output', 'unlimited-options-ui.png') });
  for (const width of [280, 360]) { await page.setViewportSize({ width, height: 720 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
});

test('deletion review visibly distinguishes removed files and preserves approval tokens and previews', async t => {
  const { page, host } = await fixture(t, renderWebview(options));
  await host({ type: 'changes', summary: '구형 이미지 삭제', files: [{ id: 'delete-preview', path: 'assets/old.png', action: 'delete', binary: true, size: 123 }], review: true, forcedReview: ['assets/old.png'], token: 'delete-token' });
  assert.match(await page.locator('#changeFiles .deleted-file').textContent(), /D · 삭제.*old.png.*바이너리/);
  assert.match(await page.locator('#reviewReason').textContent(), /파일 삭제/);
  await page.locator('#changeFiles .file').click(); assert.equal((await page.evaluate(() => window.sent.find(item => item.type === 'preview'))).id, 'delete-preview');
  await page.locator('#apply').click(); assert.equal((await page.evaluate(() => window.sent.find(item => item.type === 'apply'))).token, 'delete-token');
  await host({ type: 'changes', summary: '자동 승인 삭제', files: [{ id: 'automatic-delete', path: 'old.js', action: 'delete' }], review: false, autoApproved: true, token: 'automatic' });
  assert.equal(await page.locator('#apply').isVisible(), false); assert.match(await page.locator('#reviewReason').textContent(), /승인 없이/);
  await host({ type: 'commandApproval', command: 'npm test', root: 'C:/project', changedFiles: [{ path: 'old.js', action: 'delete', id: 'automatic-delete', currentTask: true }], token: 'command' });
  assert.match(await page.locator('#commandChanges').textContent(), /삭제 · old.js/);
  await host({ type: 'changes', summary: '구형 폴더 삭제', files: [{ id: 'folder-preview', path: 'old-assets', action: 'delete', directory: true, size: 123 }], review: true, forcedReview: ['old-assets'], token: 'folder-token' });
  assert.match(await page.locator('#changeFiles .deleted-file').textContent(), /D · 폴더 삭제.*old-assets/);
});
