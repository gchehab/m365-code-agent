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
// Regression fixture: Enter only inserts a newline, as on affected tenant UIs.
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
  assert.equal(transport.lastSend.stage, 'confirmed');
});

test('configured send button works and user draft is not overwritten', async t => {
  const transport = await browserFixture(t, { sendButtonSelector: '#send' });
  await transport.page.locator('textarea').fill('작성 중인 문장');
  await assert.rejects(transport.request('Current requestId: next', 'next'), /작성 중/);
  assert.equal(await transport.page.locator('textarea').inputValue(), '작성 중인 문장');
  await transport.page.locator('textarea').fill('');
  assert.equal((await transport.request('Current requestId: next', 'next')).kind, 'done');
});

test('a recognizable old agent protocol draft is recovered without requiring manual clearing', async t => {
  const transport = await browserFixture(t);
  await transport.page.locator('textarea').fill('You are a coding agent used from VS Code. Respond in Korean, using exactly one JSON object inside a fenced m365-agent block.\nCurrent requestId: 11111111-2222-3333-4444-555555555555\nRecent local tool results and conversation: []');
  assert.equal((await transport.request('Current requestId: recovered', 'recovered')).kind, 'done');
});

test('browser cancellation does not return a model response', async t => {
  const transport = await browserFixture(t);
  await assert.rejects(transport.request('Current requestId: cancel', 'cancel', () => { transport.cancelled = true; }), /중지/);
  assert.equal(await transport.page.locator('textarea').inputValue(), '');
});

test('a click without acknowledgement fails early and is never retried', async t => {
  const transport = await browserFixture(t, { sendAckTimeoutMs: 600 });
  await transport.page.evaluate(() => { window.clicks = 0; document.querySelector('#send').onclick = () => { window.clicks++; }; });
  await assert.rejects(transport.request('Current requestId: no-ack', 'no-ack'), /제출을 확인하지/);
  assert.equal(await transport.page.evaluate(() => window.clicks), 1);
  assert.equal(transport.lastSend.stage, 'unconfirmed');
});

test('disabled send button is awaited, and English accessible names are detected', async t => {
  const transport = await browserFixture(t);
  await transport.page.evaluate(() => {
    const button = document.querySelector('#send'); button.textContent = 'Send message'; button.disabled = true;
    document.querySelector('textarea').addEventListener('input', () => setTimeout(() => { button.disabled = false; }, 300));
  });
  assert.equal((await transport.request('Current requestId: delayed', 'delayed')).kind, 'done');
});

test('unavailable send button clears only the owned unsent draft', async t => {
  const transport = await browserFixture(t, { sendReadyTimeoutMs: 300 });
  await transport.page.locator('#send').evaluate(button => { button.disabled = true; });
  await assert.rejects(transport.request('Current requestId: disabled', 'disabled'), /활성화/);
  assert.equal(await transport.page.locator('textarea').inputValue(), '');
});

test('rich-text composer in a child frame sends without relying on Enter', async t => {
  const transport = await browserFixture(t);
  await transport.page.setContent('<iframe title="chat"></iframe>');
  const frame = transport.page.frames()[1];
  await frame.setContent('<div id="m365-chat-editor-target-element" contenteditable="true" role="textbox"></div><button aria-label="Submit prompt">↑</button><pre></pre>');
  await frame.evaluate(() => {
    document.querySelector('button').onclick = () => {
      const input = document.querySelector('[contenteditable]');
      const id = input.innerText.match(/Current requestId: ([^\s]+)/)[1];
      input.innerText = '';
      document.querySelector('pre').textContent = JSON.stringify({ requestId: id, kind: 'done', message: 'rich text okay' });
    };
  });
  const reply = await transport.request('Current requestId: rich\n다중 행 요청', 'rich');
  assert.equal(reply.message, 'rich text okay');
});

test('rich editor paragraphs, nonbreaking spaces and CSS layout do not cause false input errors', async t => {
  const transport = await browserFixture(t);
  const prompt = 'Current requestId: paragraphs\n\ndef hello():\n    print("a  b")';
  await transport.page.setContent('<div id="userInput" contenteditable="true" role="textbox" style="white-space:pre-wrap"></div><button disabled>보내기</button><pre></pre>');
  const { readComposer, matchesPrompt } = require('../src/composer');
  await transport.page.locator('#userInput').fill(prompt);
  const snapshot = await readComposer(transport.page.locator('#userInput'));
  assert.equal(matchesPrompt(snapshot, prompt), true);
  assert.notEqual(snapshot.visibleText, prompt); // Chromium inserts an extra rendered blank line.
  await transport.page.locator('#userInput').fill('');
  await transport.page.evaluate(prompt => {
    const input = document.querySelector('[contenteditable]');
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Simulate a framework re-render from committed editor state, rather
        // than copying innerText (which itself invents paragraph spacing).
        input.replaceChildren(...prompt.split('\n').map(line => {
          const p = document.createElement('p'); p.textContent = line.replace(/ /g, '\u00a0'); return p;
        }));
        input.style.whiteSpace = 'normal'; input.style.textTransform = 'uppercase';
        document.querySelector('button').disabled = false;
      }, 50);
    });
    document.querySelector('button').onclick = () => {
      const prompt = [...input.querySelectorAll('p')].map(p => p.textContent).join('\n').replace(/\u00a0/g, ' ');
      window.sentPrompt = prompt;
      const id = prompt.match(/Current requestId: ([^\s]+)/)[1];
      input.replaceChildren();
      document.querySelector('pre').textContent = JSON.stringify({ requestId: id, kind: 'done', message: 'paragraphs okay' });
    };
  }, prompt);
  const reply = await transport.request(prompt, 'paragraphs');
  assert.equal(reply.message, 'paragraphs okay');
  assert.equal(await transport.page.evaluate(() => window.sentPrompt), prompt);
});

test('native maxlength causes automatic prompt rebudgeting and exactly one Send click', async t => {
  const transport = await browserFixture(t);
  await transport.page.locator('textarea').evaluate(input => { input.maxLength = 4000; });
  await transport.page.evaluate(() => {
    window.clicks = 0;
    const button = document.querySelector('#send'); const submit = button.onclick;
    button.onclick = () => { window.clicks++; submit(); };
  });
  const { CodingAgent } = require('../src/agent');
  const agent = new CodingAgent({ store: { root: 'C:\\project', async listFiles() { return { files: [], truncated: false }; } }, transport, emit: () => {} });
  assert.equal((await agent.run('설명해줘', JSON.stringify([{ path: 'long.txt', content: 'x'.repeat(6000) }]))).status, 'done');
  assert.equal(transport.promptCharacterLimit, 4000);
  assert.equal(await transport.page.evaluate(() => window.clicks), 1);
});

test('silent truncation is identified before sending and the owned partial draft is cleaned', async t => {
  const transport = await browserFixture(t, { inputSettleTimeoutMs: 300 });
  await transport.page.evaluate(() => {
    document.querySelector('textarea').addEventListener('input', event => { event.target.value = event.target.value.slice(0, 3000); });
    window.clicks = 0; document.querySelector('#send').onclick = () => { window.clicks++; };
  });
  await assert.rejects(transport.request('Current requestId: cut\n' + 'x'.repeat(5000), 'cut'), error => error.code === 'PROMPT_LIMIT' && error.maxCharacters === 3000 && error.notSubmitted === true);
  assert.equal(await transport.page.locator('textarea').inputValue(), '');
  assert.equal(await transport.page.evaluate(() => window.clicks), 0);
  assert.equal(transport.lastSend.observedCharacters, 3000);
});

test('meaningful whitespace changes are refused without blaming length or clicking Send', async t => {
  const transport = await browserFixture(t, { inputSettleTimeoutMs: 300 });
  await transport.page.evaluate(() => {
    document.querySelector('textarea').addEventListener('input', event => { event.target.value = event.target.value.replace('    print', '  print'); });
    window.clicks = 0; document.querySelector('#send').onclick = () => { window.clicks++; };
  });
  await assert.rejects(transport.request('Current requestId: changed\ndef x():\n    print(1)', 'changed'), /길이 제한으로 단정하지/);
  assert.equal(await transport.page.evaluate(() => window.clicks), 0);
  assert.match(await transport.page.locator('textarea').inputValue(), /  print/);
});
