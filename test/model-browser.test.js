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
      document.querySelector('#new').onclick = () => { document.querySelector('#responses').textContent = ''; window.newChats++; history.replaceState({}, '', '/chat'); };
      const currentThread = () => new URL(location.href).searchParams.get('threadId');
      const restore = () => {
        for (const reply of JSON.parse(localStorage.getItem(currentThread()) || '[]')) {
          const code = document.createElement('pre'); code.textContent = reply; document.querySelector('#responses').append(code);
        }
      };
      restore();
      document.querySelector('#send').onclick = () => {
        const prompt = document.querySelector('textarea').value; document.querySelector('textarea').value = '';
        const id = prompt.match(/Current requestId: ([^\\s]+)/)[1];
        const data = JSON.parse(prompt.split('DATA: ')[1]); window.submissions.push(data);
        const hasResult = data.messages.some(message => message.content.some(part => part.type === 'tool_result'));
        const reply = { requestId:id, kind:'model', text:hasResult?'코드 확인 완료':'파일을 읽겠습니다.', toolCalls:hasResult?[]:[{id:'read-1',name:'native_read',input:{path:'main.js'}}] };
        if (!currentThread()) {
          const count = Number(localStorage.getItem('chatCount') || 0) + 1; localStorage.setItem('chatCount', count);
          history.replaceState({}, '', '/chat?threadId=fixture-' + count);
        }
        const old = JSON.parse(localStorage.getItem(currentThread()) || '[]'); old.push(JSON.stringify(reply)); localStorage.setItem(currentThread(), JSON.stringify(old));
        setTimeout(() => { const code = document.createElement('pre'); code.textContent = JSON.stringify(reply); document.querySelector('#responses').append(code); }, 80);
      };
    </script>` }));
  const page = await context.newPage(); await page.goto('https://m365.cloud.microsoft/chat');
  const transport = new CopilotBrowser({ timeoutSeconds: 8, responseStableMs: 50, composerStableMs: 50, loginTimeoutMs: 2000 });
  transport.context = context; transport.page = page;
  const tools = [{ name: 'native_read', description: 'Read', inputSchema: { type: 'object' } }];
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'main.js를 읽어줘' }] }];
  await transport.newChat();
  const first = await transport.request(protocol.buildModelPrompt('round-1', messages, { tools, required: true }, 12000), 'round-1', () => {}, protocol);
  assert.equal(first.toolCalls[0].name, 'native_read');
  protocol.validateCalls(first, tools, true, messages);
  messages.push({ role: 'assistant', content: [{ type: 'tool_call', ...first.toolCalls[0] }] });
  messages.push({ role: 'user', content: [{ type: 'tool_result', id: 'read-1', content: [{ type: 'text', text: 'exports.value = 1;\n' }] }] });
  const second = await transport.request(protocol.buildModelPrompt('round-2', messages, { tools, required: false }, 12000), 'round-2', () => {}, protocol);
  assert.equal(second.text, '코드 확인 완료');
  assert.deepEqual(second.toolCalls, []);
  assert.equal(await page.evaluate(() => window.newChats), 1);
  assert.equal(await page.evaluate(() => window.submissions.length), 2);
  const a = transport.conversationInfo().url;
  await transport.newChat();
  await transport.request(protocol.buildModelPrompt('other-chat', messages, { tools }, 12000), 'other-chat', () => {}, protocol);
  const b = transport.conversationInfo().url;
  assert.notEqual(a, b);
  await transport.resumeConversation(a);
  assert.equal(transport.conversationInfo().url, a);
  assert.equal(await page.locator('pre').count(), 2, 'A retains its two responses after visiting B');
  await page.locator('textarea').fill('manual unsent draft');
  await assert.rejects(transport.resumeConversation(b), /초안/);
  await assert.rejects(transport.newChat(), /초안/);
  assert.equal(transport.conversationInfo().url, a);
  await page.locator('textarea').fill('');
  await transport.resumeConversation(b);
  assert.equal(await page.locator('pre').count(), 1);
  assert.equal(await page.evaluate(() => Number(localStorage.getItem('chatCount'))), 2);
  await context.route('**/chat?threadId=missing', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="userInput"></textarea><script>history.replaceState({}, "", "/chat");</script>' }));
  await assert.rejects(transport.resumeConversation('https://m365.cloud.microsoft/chat?threadId=missing'), /복원되지/);
  assert.equal(await page.evaluate(() => Number(localStorage.getItem('chatCount'))), 2, 'redirected restoration never creates a replacement');
});
