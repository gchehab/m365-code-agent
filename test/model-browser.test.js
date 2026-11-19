'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { CopilotBrowser } = require('../src/browser');
const protocol = require('../src/model-protocol');

test('model protocol uses real Edge DOM submission/extraction for a tool call and its result', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('https://m365.cloud.microsoft/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">
    <button id="new">New chat</button><textarea id="userInput"></textarea><button id="send">Send message</button><main id="responses"></main>
    <script>
      window.submissions = []; window.newChats = 0;
      document.querySelector('#new').onclick = () => { document.querySelector('#responses').textContent = ''; window.newChats++; };
      document.querySelector('#send').onclick = () => {
        const prompt = document.querySelector('textarea').value; document.querySelector('textarea').value = '';
        const id = prompt.match(/Current requestId: ([^\\s]+)/)[1];
        const data = JSON.parse(prompt.split('DATA: ')[1]); window.submissions.push(data);
        const hasResult = data.messages.some(message => message.content.some(part => part.type === 'tool_result'));
        const reply = { requestId:id, kind:'model', text:hasResult?'코드 확인 완료':'파일을 읽겠습니다.', toolCalls:hasResult?[]:[{id:'read-1',name:'native_read',input:{path:'main.js'}}] };
        setTimeout(() => { const code = document.createElement('pre'); code.textContent = JSON.stringify(reply); document.querySelector('#responses').append(code); }, 80);
      };
    </script>` }));
  const page = await context.newPage(); await page.goto('https://m365.cloud.microsoft/chat');
  const transport = new CopilotBrowser({ timeoutSeconds: 8, responseStableMs: 50, composerStableMs: 50 });
  transport.context = context; transport.page = page;
  const tools = [{ name: 'native_read', description: 'Read', inputSchema: { type: 'object' } }];
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'main.js를 읽어줘' }] }];
  await transport.newChat();
  const first = await transport.request(protocol.buildModelPrompt('round-1', messages, { tools, required: true }, 12000), 'round-1', () => {}, protocol);
  assert.equal(first.toolCalls[0].name, 'native_read');
  protocol.validateCalls(first, tools, true, messages);
  messages.push({ role: 'assistant', content: [{ type: 'tool_call', ...first.toolCalls[0] }] });
  messages.push({ role: 'user', content: [{ type: 'tool_result', id: 'read-1', content: [{ type: 'text', text: 'exports.value = 1;\n' }] }] });
  await transport.newChat();
  const second = await transport.request(protocol.buildModelPrompt('round-2', messages, { tools, required: false }, 12000), 'round-2', () => {}, protocol);
  assert.equal(second.text, '코드 확인 완료');
  assert.deepEqual(second.toolCalls, []);
  assert.equal(await page.evaluate(() => window.newChats), 2);
  assert.equal(await page.evaluate(() => window.submissions.length), 2);
});
