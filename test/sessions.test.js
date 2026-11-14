'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationController } = require('../src/conversations');
const { ChangeController } = require('../src/changes');

function fixture() {
  let url = 'https://m365.cloud.microsoft/chat?threadId=a', next = 'b';
  const page = { url: () => url, isClosed: () => false, async goto(value) { url = value; } };
  let newPages = 0;
  const host = {
    sessionId: 'a', events: [{ type: 'message', role: 'user', text: 'A' }], webUrl: url,
    sessions: ['a', 'b'].map(id => ({ id, title: id, updated: Date.now(), events: [{ type: 'message', role: 'user', text: id.toUpperCase() }], webUrl: 'https://m365.cloud.microsoft/chat?threadId=' + id })),
    webPages: new Map(), context: { workspaceState: { update() {} } }, view: { visible: true, webview: { postMessage() {} } },
    browser: { page, context: { async newPage() { newPages++; return page; } }, async readConversation() { return { url, restorable: true, messages: [] }; } },
    post() {}, state: () => ({}), async ensureBrowser() { return this.browser; }
  };
  const controller = new ConversationController(host, { window: { async showQuickPick(items) { return items.find(item => item.session.id === next); } } });
  host.saveSession = () => controller.saveSession();
  return { host, controller, choose: value => { next = value; }, newPages: () => newPages };
}

test('repeated history switches reuse one tab and discard closed page references', async () => {
  const { host, controller, choose, newPages } = fixture();
  host.webPages.set('closed', { isClosed: () => true });
  for (let i = 0; i < 12; i++) {
    const id = i % 2 ? 'a' : 'b'; choose(id);
    await controller.showHistory();
    assert.equal(host.sessionId, id);
    assert.equal(host.webPages.size, 1);
    assert.equal(host.webPages.has('closed'), false);
  }
  assert.equal(newPages(), 0);
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
