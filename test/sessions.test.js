'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationController } = require('../src/conversations');
const { ChangeController } = require('../src/changes');

function fixture() {
  let url = 'https://m365.cloud.microsoft/chat?threadId=a', next = 'b';
  const page = { url: () => url, isClosed: () => false, async goto(value) { url = value; } };
  let newPages = 0, newChats = 0;
  const host = {
    sessionId: 'a', events: [{ type: 'message', role: 'user', text: 'A' }], webUrl: url,
    sessions: ['a', 'b'].map(id => ({ id, title: id, updated: Date.now(), events: [{ type: 'message', role: 'user', text: id.toUpperCase() }], webUrl: 'https://m365.cloud.microsoft/chat?threadId=' + id })),
    context: { workspaceState: { update() {} } }, view: { visible: true, webview: { postMessage() {} } },
    browser: { page, context: { async newPage() { newPages++; return page; } }, async newChat() { newChats++; url = 'https://m365.cloud.microsoft/chat'; }, async waitForComposer() {}, async readConversation() { return { url, restorable: true, messages: [] }; } },
    post() {}, state: () => ({}), async ensureBrowser() { return this.browser; }
  };
  const controller = new ConversationController(host, { window: { async showQuickPick(items) { return items.find(item => item.session.id === next); } } });
  host.saveSession = () => controller.saveSession();
  return { host, controller, choose: value => { next = value; }, navigate: value => { url = value; }, newPages: () => newPages, newChats: () => newChats };
}

test('repeated history switches reuse the browser active tab without a separate page cache', async () => {
  const { host, controller, choose, newPages } = fixture();
  const page = host.browser.page;
  for (let i = 0; i < 12; i++) {
    const id = i % 2 ? 'a' : 'b'; choose(id);
    await controller.showHistory();
    assert.equal(host.sessionId, id);
    assert.equal(host.browser.page, page);
  }
  assert.equal(newPages(), 0);
});

test('new chat prepares the same tab once and links its first conversation without old messages', async () => {
  const { host, controller, navigate, newChats, newPages } = fixture();
  const page = host.browser.page;
  await controller.newChat();
  const id = host.sessionId;
  assert.notEqual(id, 'a'); assert.equal(host.newWebChat, true);
  assert.ok(host.sessions.find(session => session.id === 'a').events.some(event => event.text === 'A'));
  await controller.syncWeb();
  assert.deepEqual(host.events, []);
  await controller.prepareWeb();
  assert.equal(host.browser.page, page); assert.equal(newChats(), 1); assert.equal(newPages(), 0);
  assert.equal(host.newWebChat, false);
  const url = 'https://m365.cloud.microsoft/chat?threadId=new'; navigate(url);
  host.browser.readConversation = async () => ({ url, restorable: true, messages: [{ type: 'message', role: 'user', text: '첫 요청', webId: 'first' }] });
  await controller.syncWeb();
  assert.equal(host.sessionId, id); assert.equal(host.webUrl, url);
  assert.deepEqual(host.events.map(event => event.text), ['첫 요청']);
  await controller.prepareWeb(); assert.equal(newChats(), 1);
});

test('new chat remains pending if web generation blocks preparation and can be retried', async () => {
  const { host, controller, newChats } = fixture();
  await controller.newChat();
  host.browser.generationActive = async () => true;
  await assert.rejects(controller.prepareWeb(), /생성 중/);
  assert.equal(host.newWebChat, true); assert.equal(newChats(), 0);
  host.browser.generationActive = async () => false;
  await controller.prepareWeb();
  assert.equal(host.newWebChat, false); assert.equal(newChats(), 1);
});

test('cancelling while the new chat composer loads cannot mark the task ready', async () => {
  const { host, controller } = fixture();
  await controller.newChat();
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  host.browser.waitForComposer = () => new Promise(resolve => { finish = resolve; entered(); });
  const preparing = controller.prepareWeb();
  await started;
  host.stopRequested = true; controller.invalidate(); finish();
  await assert.rejects(preparing, /중지/);
  assert.equal(host.newWebChat, true);
});

test('a pending sync cannot overwrite a history selection, including switching away and back', async () => {
  const { host, controller, choose } = fixture();
  let finish;
  host.browser.readConversation = () => new Promise(resolve => { finish = resolve; });
  const pending = controller.syncWeb();
  choose('b'); await controller.showHistory();
  choose('a'); await controller.showHistory();
  finish({ url: host.webUrl, restorable: true, messages: [{ type: 'message', role: 'assistant', text: 'STALE RESULT', webId: 'stale' }] });
  await pending;
  assert.equal(host.sessionId, 'a');
  assert.deepEqual(host.events.map(event => event.text), ['A']);
});

test('a pending sync cannot resurrect the previous conversation after New Chat', async () => {
  const { host, controller } = fixture();
  let finish;
  host.browser.readConversation = () => new Promise(resolve => { finish = resolve; });
  const pending = controller.syncWeb();
  await controller.newChat();
  const newId = host.sessionId;
  finish({ url: 'https://m365.cloud.microsoft/chat?threadId=a', restorable: true, messages: [{ type: 'message', role: 'user', text: 'OLD' }] });
  await pending;
  assert.equal(host.sessionId, newId); assert.deepEqual(host.events, []);
});

test('background sync does not read the browser while the sidebar is hidden', async () => {
  const { host, controller } = fixture(); let reads = 0;
  host.view.visible = false;
  host.browser.readConversation = async () => { reads++; };
  await controller.syncWeb(false);
  assert.equal(reads, 0);
});

test('command approval separates current-task changes from retained earlier changes', async () => {
  const host = { taskId: 'new', changedFiles: new Map([
    ['old', { root: 'C:/workspace', path: 'jest.config.js', id: 'old', taskId: 'old' }],
    ['new', { root: 'C:/workspace', path: 'src/main.js', id: 'new', taskId: 'new' }]
  ]), previews: new Map([['old-new', ''], ['new-new', '']]), post() {} };
  const changes = new ChangeController(host, {});
  const pending = changes.runCommand('npm test', 'C:/workspace');
  const files = host.pending.viewData.changedFiles;
  assert.equal(files.find(file => file.path === 'jest.config.js').currentTask, false);
  assert.equal(files.find(file => file.path === 'jest.config.js').sensitive, true);
  assert.equal(files.find(file => file.path === 'src/main.js').currentTask, true);
  host.pending.resolve(false);
  assert.equal((await pending).approved, false);
});
