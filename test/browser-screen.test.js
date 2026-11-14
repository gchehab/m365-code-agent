'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');
const { BrowserScreen, displayUrl } = require('../src/browser-screen');
const { CopilotBrowser } = require('../src/browser');

async function until(check, timeout = 7000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error('Test condition timed out'); await delay(25); } }

test('embedded browser displays the same page, accepts login input, follows popups and locks agent input', async t => {
  const edge = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await edge.newContext({ viewport: { width: 800, height: 600 } });
  await context.route('https://login.microsoftonline.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Mock sign in</title><input id="name"><button id="login" onclick="window.open(\'https://m365.cloud.microsoft/chat\')">Sign in</button>' }));
  await context.route('https://m365.cloud.microsoft/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<title>Mock Copilot</title><textarea id="userInput"></textarea><button id="send">보내기</button><pre></pre><script>document.querySelector('button').onclick=()=>{const input=document.querySelector('textarea');const id=input.value.match(/Current requestId: ([^\\s]+)/)[1];input.value='';setTimeout(()=>{document.querySelector('pre').textContent=JSON.stringify({requestId:id,kind:'done',message:'same-page response'});},1200);};</script>` }));
  const auth = await context.newPage(); await auth.goto('https://login.microsoftonline.com/test?code=DO_NOT_LEAK');
  const transport = new CopilotBrowser({ timeoutSeconds: 6, composerStableMs: 50, readinessPollMs: 30, responseStableMs: 50, loginTimeoutMs: 7000 });
  transport.context = context; transport.page = auth;
  let screen, frames = 0; const states = [];
  screen = new BrowserScreen(() => transport, event => {
    if (event.type === 'browserFrame') { frames++; queueMicrotask(() => screen.handle({ type: 'frameAck', id: event.id, token: event.token })); }
    else states.push(event);
  });
  t.after(async () => { await screen.dispose(); await edge.close(); });
  await screen.update(); await until(() => frames > 0);
  assert.equal(JSON.stringify(states).includes('DO_NOT_LEAK'), false);
  const pending = transport.request('Current requestId: embedded\nExplain the project.', 'embedded');
  async function click(page, selector) {
    const box = await page.locator(selector).boundingBox(), size = page.viewportSize();
    const point = { type: 'browserInput', token: screen.token, x: (box.x + box.width / 2) / size.width, y: (box.y + box.height / 2) / size.height, button: 'left' };
    await screen.handle({ ...point, action: 'down' }); await screen.handle({ ...point, action: 'up' });
  }
  await click(auth, '#name'); await screen.handle({ type: 'browserInput', token: screen.token, action: 'text', text: '한글 테스트' });
  assert.equal(await auth.locator('#name').inputValue(), '한글 테스트');
  await click(auth, '#login');
  await until(() => transport.lastSend?.stage === 'confirmed');
  await screen.update();
  assert.equal(screen.page, transport.page);
  await screen.handle({ type: 'browserInput', token: screen.token, action: 'text', text: 'must-not-enter-agent-composer' });
  assert.equal(await transport.page.locator('textarea').inputValue(), '');
  assert.equal((await pending).message, 'same-page response');
  await screen.update();
  assert.equal(states.filter(event => event.type === 'browserState').at(-1).locked, false);
  const oldToken = screen.token;
  await transport.page.goto('https://m365.cloud.microsoft/chat?auth=DO_NOT_LEAK');
  await screen.handle({ type: 'browserInput', token: oldToken, action: 'text', text: 'stale-input' });
  assert.equal(await transport.page.locator('textarea').inputValue(), '');
  await screen.update();
  assert.equal(displayUrl(transport.page.url()), 'https://m365.cloud.microsoft/chat');
});

test('frame delivery keeps only the latest pending frame and rejects acknowledgements from an old view', async () => {
  const delivered = [], screen = new BrowserScreen(() => null, event => delivered.push(event.id));
  screen.pending = { id: 1, token: 'one' }; screen.flush();
  screen.pending = { id: 2, token: 'two' }; screen.flush();
  screen.pending = { id: 3, token: 'three' }; screen.flush();
  assert.deepEqual(delivered, [1]);
  await screen.handle({ type: 'frameAck', id: 1, token: 'old-view' }); assert.deepEqual(delivered, [1]);
  await screen.handle({ type: 'frameAck', id: 1, token: 'one' }); assert.deepEqual(delivered, [1, 3]);
  await screen.dispose();
});
