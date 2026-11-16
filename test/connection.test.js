'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { CopilotBrowser } = require('../src/browser');
const { connectionError, connectionFailure, environmentDiagnostics } = require('../src/connection');
const output = path.resolve(__dirname, '..', '.test-output');
const options = { url: 'https://m365.cloud.microsoft/chat', profile: 'test-profile', embedded: true };

function fakePage(url = 'about:blank') {
  return { current: url, closed: false, navigations: 0, url() { return this.current; }, isClosed() { return this.closed; }, setDefaultTimeout() {}, frames() { return []; }, async goto(value) { this.navigations++; this.current = value; } };
}
function fakeContext(pages) {
  const context = new EventEmitter();
  context.pages = () => pages.filter(page => !page.closed);
  context.newPage = async () => { const page = fakePage(); pages.push(page); return page; };
  return context;
}

test('connection failures identify startup causes without exposing profile paths or authentication query tokens', () => {
  for (const [message, stage, code] of [
    ["Chromium distribution 'msedge' is not found", 'launch', 'BROWSER_NOT_FOUND'],
    ['ProcessSingleton profile in use', 'launch', 'PROFILE_IN_USE'],
    ['EPERM: operation not permitted', 'launch', 'BROWSER_ACCESS_DENIED'],
    ['ENOTDIR profile', 'profile', 'PROFILE_ACCESS_FAILED'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'navigation', 'BROWSER_CERTIFICATE_FAILED'],
    ['net::ERR_PROXY_CONNECTION_FAILED', 'navigation', 'BROWSER_PROXY_FAILED'],
    ['page.goto: Timeout 60000ms exceeded', 'navigation', 'BROWSER_NAVIGATION_TIMEOUT'],
  ]) assert.equal(connectionFailure(new Error(message), stage, options).code, code);
  const error = connectionError(new Error('goto https://login.microsoftonline.com/common?code=DO_NOT_LEAK#SECRET in test-profile'), 'navigation', options);
  assert.equal(error.connectionFailure.stage, 'navigation');
  assert.doesNotMatch(JSON.stringify(error.connectionFailure), /DO_NOT_LEAK|SECRET|test-profile/);
  const launch = connectionFailure(new Error('Target closed\n[error] blocked test-profile https://example.test/?code=DO_NOT_LEAK#SECRET'), 'launch', options);
  assert.equal(launch.browserLog.length, 1); assert.doesNotMatch(JSON.stringify(launch), /DO_NOT_LEAK|SECRET|test-profile/);
});

test('a failed launch retains an actionable failure instead of reporting a connected browser', async t => {
  t.mock.method(chromium, 'launchPersistentContext', async () => { throw new Error("Chromium distribution 'msedge' is not found"); });
  const browser = new CopilotBrowser(options);
  await assert.rejects(browser.connect(), { code: 'BROWSER_NOT_FOUND' });
  assert.equal(browser.context, null); assert.equal(browser.lastConnectionFailure.stage, 'launch');
  assert.equal(browser.connecting, null);
});

test('navigation retry reuses the launched context and actually retries a failed page load', async t => {
  const page = fakePage(), context = fakeContext([page]); let launches = 0;
  page.goto = async value => { page.navigations++; page.current = value; if (page.navigations === 1) throw new Error('net::ERR_NAME_NOT_RESOLVED'); };
  t.mock.method(chromium, 'launchPersistentContext', async () => { launches++; return context; });
  const browser = new CopilotBrowser(options);
  await assert.rejects(browser.connect(), { code: 'BROWSER_NAVIGATION_FAILED' });
  assert.equal(browser.context, context); assert.equal(browser.lastConnectionFailure.stage, 'navigation');
  await browser.connect(); assert.equal(page.navigations, 2); assert.equal(launches, 1);
  assert.equal(browser.connectionStage, 'ready'); assert.equal(browser.lastConnectionFailure, null);
});

test('reconnect preserves a surviving sign-in page and reuses an empty live context without relaunching its profile', async t => {
  t.mock.method(chromium, 'launchPersistentContext', async () => { throw new Error('unexpected relaunch'); });
  const closed = fakePage(); closed.closed = true;
  const auth = fakePage('https://login.microsoftonline.com/common');
  const browser = new CopilotBrowser(options); browser.context = fakeContext([closed, auth]); browser.page = closed;
  await browser.connect(); assert.equal(browser.page, auth); assert.equal(auth.navigations, 0);
  browser.context = fakeContext([]); browser.page = null;
  await browser.connect(); assert.equal(browser.page.navigations, 1);
});

test('a late close event from an old context cannot discard the new connection', async t => {
  const old = fakeContext([fakePage()]), current = fakeContext([fakePage()]); let calls = 0;
  t.mock.method(chromium, 'launchPersistentContext', async () => ++calls === 1 ? old : current);
  const browser = new CopilotBrowser(options); await browser.connect();
  browser.context = null; browser.page = null; await browser.connect();
  old.emit('close'); assert.equal(browser.context, current); assert.equal(browser.connectionStage, 'ready');
});

test('offline environment diagnosis reports storage failure and never requires a browser process', async t => {
  await fs.mkdir(output, {recursive:true}); const root = await fs.mkdtemp(path.join(output, 'connection-env-'));
  t.after(async () => { assert.equal(path.dirname(root), output); await fs.rm(root, {recursive:true, force:true}); });
  await fs.writeFile(path.join(root, 'blocked'), 'keep');
  const failed = await environmentDiagnostics({profile:path.join(root, 'blocked', 'profile'), version:'test'});
  assert.equal(failed.profileWritable, false); assert.match(failed.profileError, /ENOTDIR|EEXIST/);
  const writable = path.join(root, 'writable');
  assert.equal((await environmentDiagnostics({profile:writable, version:'test'})).profileWritable, true);
  assert.deepEqual(await fs.readdir(writable), []);
  assert.equal(await fs.readFile(path.join(root, 'blocked'), 'utf8'), 'keep');
});

test('persistent Edge connection starts and reuses one isolated profile against a local Copilot fixture', async t => {
  await fs.mkdir(output, {recursive:true}); const root = await fs.mkdtemp(path.join(output, 'connection-edge-'));
  const browser = new CopilotBrowser({...options,profile:path.join(root,'profile')});
  t.after(async () => { await browser.close(); assert.equal(path.dirname(root), output); await fs.rm(root, {recursive:true,force:true}); });
  const launch = chromium.launchPersistentContext.bind(chromium); let calls = 0;
  t.mock.method(chromium, 'launchPersistentContext', async (...args) => {
    calls++; const context = await launch(...args);
    await context.route('https://m365.cloud.microsoft/**', route => route.fulfill({contentType:'text/html',body:'<title>Local Copilot</title><textarea id="userInput"></textarea>'}));
    return context;
  });
  await browser.connect(); const context = browser.context; await browser.connect();
  assert.equal(calls, 1); assert.equal(browser.context, context);
  assert.equal((await browser.diagnostics({connect:false})).title, 'Local Copilot');
});
