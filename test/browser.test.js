'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { CopilotBrowser } = require('../src/browser');

async function browserFixture(t, options = {}) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('https://m365.cloud.microsoft/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><meta charset="utf-8"><body>
<main><textarea id="userInput" aria-label="Copilot에게 질문"></textarea><button id="send">보내기</button><div id="responses"></div></main>
<script>
function submit(){ const input=document.querySelector('textarea');const prompt=input.value; input.value='';
 const id=prompt.match(/Current requestId: ([^\\s]+)/)[1];
 const echo=document.createElement('pre');echo.textContent=prompt;document.querySelector('#responses').append(echo);
 setTimeout(()=>{const code=document.createElement('pre');code.textContent=JSON.stringify({requestId:id,kind:'done',message:'로컬 시뮬레이터 응답'});document.querySelector('#responses').append(code);},100);
}
document.querySelector('textarea').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit();}});
document.querySelector('#send').onclick=submit;
</script></body></html>` }));
  const page = await context.newPage();
  await page.goto('https://m365.cloud.microsoft/chat');
  const transport = new CopilotBrowser({ timeoutSeconds: 7, ...options });
  transport.context = context;
  transport.page = page;
  return transport;
}

test('automatic Edge DOM input and response extraction, without clipboard or extension', async t => {
  const transport = await browserFixture(t);
  const reply = await transport.request('Current requestId: fixture-123\nUse the structured protocol.', 'fixture-123');
  assert.equal(reply.kind, 'done');
  assert.equal(reply.message, '로컬 시뮬레이터 응답');
});

test('configured send button works and user draft is not overwritten', async t => {
  const transport = await browserFixture(t, { sendButtonSelector: '#send' });
  await transport.page.locator('textarea').fill('작성 중인 문장');
  await assert.rejects(transport.request('Current requestId: next', 'next'), /작성 중/);
  assert.equal(await transport.page.locator('textarea').inputValue(), '작성 중인 문장');
  await transport.page.locator('textarea').fill('');
  assert.equal((await transport.request('Current requestId: next', 'next')).kind, 'done');
});

test('browser cancellation does not return a model response', async t => {
  const transport = await browserFixture(t);
  await assert.rejects(transport.request('Current requestId: cancel', 'cancel', () => { transport.cancelled = true; }), /중지/);
  assert.equal(await transport.page.locator('textarea').inputValue(), '');
});
