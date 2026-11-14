'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { renderBrowserPanel } = require('../src/browser-panel');

test('browser editor UI renders frames, forwards Korean input once and stores no keyboard data', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const target = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await target.setContent('<h1>Mock Microsoft 365 Copilot</h1><p>Sign in to continue</p><input placeholder="Email"><button>Next</button>');
  const jpeg = (await target.screenshot({ type: 'jpeg', quality: 75 })).toString('base64');
  const page = await browser.newPage({ viewport: { width: 820, height: 650 } });
  const root = path.resolve(__dirname, '..');
  const html = renderBrowserPanel('screen-nonce', 'https://panel.test', name => 'https://panel.test/' + name);
  assert.equal(html.includes('<iframe'), false);
  await page.addInitScript(() => { window.sent = []; window.saved = []; window.acquireVsCodeApi = () => ({ postMessage: value => window.sent.push(value), setState: value => window.saved.push(value) }); });
  await page.route('https://panel.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: name ? await fs.readFile(path.join(root, 'media', name), 'utf8') : html });
  });
  await page.goto('https://panel.test');
  const host = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  await host({ type: 'browserState', connected: true, selected: 'one', url: 'https://m365.cloud.microsoft/chat', tabs: [{ id: 'one', title: 'M365 Copilot' }], locked: false });
  await host({ type: 'browserFrame', id: 1, token: 'current-view', data: jpeg });
  await page.waitForFunction(() => window.sent.some(message => message.type === 'frameAck'));
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'frameAck'))).token, 'current-view');
  await page.locator('canvas').click();
  assert.equal(await page.locator('#keyboard').getAttribute('type'), 'password');
  await page.locator('#keyboard').evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart')); element.value = '한글 입력';
    element.dispatchEvent(new InputEvent('input', { isComposing: true, inputType: 'insertCompositionText' }));
    element.dispatchEvent(new CompositionEvent('compositionend', { data: '한글 입력' }));
    element.dispatchEvent(new InputEvent('input', { isComposing: false, inputType: 'insertText' }));
  });
  const texts = await page.evaluate(() => window.sent.filter(message => message.action === 'text'));
  assert.deepEqual(texts.map(message => message.text), ['한글 입력']);
  assert.equal(await page.locator('#keyboard').inputValue(), ''); assert.deepEqual(await page.evaluate(() => window.saved), []);
  const before = await page.evaluate(() => window.sent.filter(message => message.type === 'browserInput').length);
  await host({ type: 'browserState', connected: true, selected: 'one', url: 'https://m365.cloud.microsoft/chat', tabs: [{ id: 'one', title: 'M365 Copilot' }], locked: true });
  await page.locator('canvas').click();
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'browserInput').length), before);
  await fs.mkdir(path.join(root, '.test-output'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.test-output/browser-editor-ui.png') });
});
