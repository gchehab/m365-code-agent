'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { parseReply, buildPrompt } = require('../src/protocol');
const { conversationUrl, historyMessages, mergeHistory } = require('../src/web-history');
const { renderMarkdown } = require('../src/markdown');
const { CopilotBrowser } = require('../src/browser');
const { ConversationController } = require('../src/conversations');

test('equivalent JSON widgets are deduplicated without hiding distinct edits', () => {
  const file = { path: 'a.js', action: 'edit', baseHash: 'abc', edits: [{ oldText: 'one', newText: 'two' }] };
  const first = { requestId: 'same', kind: 'changes', summary: '요약 1', files: [file] };
  const second = { files: [{ edits: [{ newText: 'two', oldText: 'one' }], baseHash: 'abc', action: 'edit', path: 'a.js' }], summary: '요약 2', kind: 'changes', requestId: 'same' };
  assert.equal(parseReply(JSON.stringify(first) + '\n' + JSON.stringify(second), 'same').kind, 'changes');
  second.files[0].edits[0].newText = 'three';
  assert.throws(() => parseReply(JSON.stringify(first) + '\n' + JSON.stringify(second), 'same'), { code: 'AMBIGUOUS_REPLY' });
  assert.throws(() => parseReply('{"requestId":"same","kind":"changes","files":[null]}', 'same'), { code: 'INVALID_REPLY_SCHEMA' });
});

test('web conversation URLs retain only restorable conversation identifiers', () => {
  assert.deepEqual(conversationUrl('https://m365.cloud.microsoft/chat?threadId=a&access_token=SECRET&auth=b&agentId=c#token'), { url: 'https://m365.cloud.microsoft/chat?threadId=a&agentId=c', restorable: true });
  assert.equal(conversationUrl('https://m365.cloud.microsoft/chat').restorable, false);
  assert.equal(conversationUrl('https://copilot.cloud.microsoft/conversations/a').restorable, true);
});

test('web history collapses protocol rounds, preserves repeated turns, and never imports actions', () => {
  const prompt = buildPrompt({ id: 'turn', task: '프로젝트 분석', workspace: 'test' });
  const turns = [
    { role: 'user', text: prompt },
    { role: 'assistant', text: '{"requestId":"turn","kind":"tools","calls":[{"name":"read_file","path":"a.js"}]}' },
    { role: 'user', text: prompt },
    { role: 'assistant', text: '{"requestId":"turn","kind":"done","message":"분석 결과"}' },
    { role: 'user', text: '더 설명해줘' }, { role: 'assistant', text: '설명입니다' },
    { role: 'user', text: '더 설명해줘' }, { role: 'assistant', text: '설명입니다' }
  ];
  const imported = historyMessages(turns);
  assert.deepEqual(imported.map(event => event.text), ['프로젝트 분석', '분석 결과', '더 설명해줘', '설명입니다', '더 설명해줘', '설명입니다']);
  assert.equal(new Set(imported.map(event => event.webId)).size, 6);
  const local = [{ type: 'message', role: 'user', text: '프로젝트 분석' }, { type: 'tool', id: 'read', label: 'read_file' }, { type: 'message', role: 'assistant', text: '분석 결과' }];
  const merged = mergeHistory(local, imported);
  assert.equal(merged.length, 7);
  assert.deepEqual(mergeHistory(merged, imported), merged);
  assert.equal(merged[1].type, 'tool');
  const proposed = historyMessages([{ role: 'assistant', text: '{"requestId":"change","kind":"changes","summary":"제안","files":[{"action":"create","path":"never.js","content":"secret"}]}' }]);
  assert.equal(proposed[0].text, '제안');
  assert.equal(JSON.stringify(proposed).includes('never.js'), false);
});

test('Markdown formats text and blocks raw HTML, script links and remote images', () => {
  const html = renderMarkdown('# 결과\n\n|파일|결과|\n|-|-|\n|a.js|완료|\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![private](https://remote.test/track)');
  assert.match(html, /<h1>결과<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /language-js/);
  assert.equal(/<script|<img|href="javascript:/i.test(html), false);
});

test('Edge preserves a queued request across login, retries only an unsent hydration reset, and imports visible history', async t => {
  const edge = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => edge.close());
  const body = `<!doctype html><meta charset="utf-8"><textarea id="userInput"></textarea><button id="send">보내기</button><main id="turns"></main><script>
    window.sends=0;window.fills=0;
    document.querySelector('textarea').addEventListener('input', e => {if(e.target.value){window.fills++;if(window.resetFirst&&window.fills===1)e.target.value='';}});
    document.querySelector('#send').onclick=()=>{window.sends++;const input=document.querySelector('textarea');const id=input.value.match(/Current requestId: ([^\\s]+)/)[1];input.value='';const reply=document.createElement('pre');reply.dataset.messageAuthorRole='assistant';reply.textContent=JSON.stringify({requestId:id,kind:'done',message:'완료'});document.querySelector('main').append(reply);history.replaceState(null,'','/chat?threadId=thread-1&access_token=DO_NOT_KEEP');};
  </script>`;
  async function fixture(login = false) {
    const context = await edge.newContext();
    t.after(() => context.close());
    await context.route('https://m365.cloud.microsoft/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
    await context.route('https://login.microsoftonline.com/**', route => route.fulfill({ contentType: 'text/html', body: '<input type="password" value="untouched">' }));
    const page = await context.newPage();
    await page.goto(login ? 'https://login.microsoftonline.com/test' : 'https://m365.cloud.microsoft/chat');
    const transport = new CopilotBrowser({ timeoutSeconds: 3, composerStableMs: 50, readinessPollMs: 30, responseStableMs: 50, inputSettleTimeoutMs: 120, loginTimeoutMs: 3000 });
    transport.context = context; transport.page = page;
    return transport;
  }
  await t.test('login in a new tab automatically resumes the original request exactly once', async () => {
    const transport = await fixture(true), auth = transport.page, statuses = [];
    const pending = transport.request('Current requestId: login\n최초 요청', 'login', text => statuses.push(text));
    await auth.waitForTimeout(200);
    const chat = await transport.context.newPage();
    await chat.goto('https://m365.cloud.microsoft/chat');
    assert.equal((await pending).message, '완료');
    assert.equal(await auth.locator('input').inputValue(), 'untouched');
    assert.equal(await chat.evaluate(() => window.sends), 1);
    assert.equal(statuses.some(text => /로그인/.test(text)), true);
    assert.equal(transport.conversationInfo().url, 'https://m365.cloud.microsoft/chat?threadId=thread-1');
  });
  await t.test('a pre-submit hydration reset is retried and sends once', async () => {
    const transport = await fixture();
    await transport.page.evaluate(() => { window.resetFirst = true; });
    assert.equal((await transport.request('Current requestId: hydration', 'hydration')).kind, 'done');
    assert.equal(await transport.page.evaluate(() => window.fills), 2);
    assert.equal(await transport.page.evaluate(() => window.sends), 1);
  });
  await t.test('login wait can be cancelled without touching authentication inputs', async () => {
    const transport = await fixture(true);
    await assert.rejects(transport.request('Current requestId: cancel', 'cancel', () => { transport.cancelled = true; }), /중지/);
    assert.equal(await transport.page.locator('input').inputValue(), 'untouched');
  });
  await t.test('model choices come from the visible menu, including its More submenu', async () => {
    const transport = await fixture();
    await transport.page.evaluate(() => {
      const trigger = document.createElement('button'); trigger.textContent = '모델'; trigger.setAttribute('aria-haspopup', 'menu');
      const menu = document.createElement('div'); menu.hidden = true;
      const auto = document.createElement('button'); auto.setAttribute('role', 'menuitemradio'); auto.textContent = 'Auto';
      const more = document.createElement('button'); more.setAttribute('role', 'menuitem'); more.setAttribute('aria-haspopup', 'menu'); more.textContent = 'More';
      const sub = document.createElement('div'); sub.hidden = true;
      const claude = document.createElement('button'); claude.setAttribute('role', 'menuitemradio'); claude.textContent = 'Claude Test';
      menu.append(auto, more); sub.append(claude); document.body.append(trigger, menu, sub);
      trigger.onclick = () => { menu.hidden = false; sub.hidden = true; };
      more.onclick = () => { menu.hidden = true; sub.hidden = false; };
      claude.onclick = () => { window.chosen = 'Claude Test'; sub.hidden = true; };
      document.addEventListener('keydown', e => { if(e.key === 'Escape'){menu.hidden=true;sub.hidden=true;} });
    });
    const models = await transport.models();
    assert.deepEqual(models.map(model => model.label), ['Auto', 'More › Claude Test']);
    await transport.selectModel(models[1].id);
    assert.equal(await transport.page.evaluate(() => window.chosen), 'Claude Test');
    await assert.rejects(transport.selectModel('made-up-model'), /표시된 모델만/);
  });
  await t.test('only role-identified current conversation turns are imported; no actions execute', async () => {
    const transport = await fixture();
    await transport.page.evaluate(() => {
      history.replaceState(null, '', '/chat?threadId=manual&auth=SECRET');
      document.querySelector('main').innerHTML = '<div data-message-author-role="user">웹 질문</div><div data-message-author-role="assistant">웹 답변</div>';
    });
    const result = await transport.readConversation();
    assert.deepEqual(result.messages.map(event => event.text), ['웹 질문', '웹 답변']);
    assert.equal(result.url, 'https://m365.cloud.microsoft/chat?threadId=manual');
    assert.equal(await transport.page.evaluate(() => window.sends), 0);
  });
  await t.test('switching web history cannot erase a manually written browser draft', async () => {
    const transport = await fixture();
    await transport.page.locator('textarea').fill('작성 중인 웹 질문');
    const controller = new ConversationController({ async ensureBrowser() { return transport; } }, {});
    await assert.rejects(controller.openWeb('https://m365.cloud.microsoft/chat?threadId=another'), /작성 중인 내용/);
    assert.equal(await transport.page.locator('textarea').inputValue(), '작성 중인 웹 질문');
    assert.equal(transport.page.url(), 'https://m365.cloud.microsoft/chat');
  });
});
