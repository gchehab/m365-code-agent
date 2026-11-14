'use strict';
const crypto = require('node:crypto');
const { validateCopilotUrl } = require('./browser');
const { conversationUrl, mergeHistory } = require('./web-history');
const { readComposer } = require('./composer');

class ConversationController {
  constructor(host, vscode) { this.host = host; this.vscode = vscode; this.revision = 0; }
  invalidate() { this.revision++; }
  async protectWebDraft(browser) {
    if (browser.generationActive && await browser.generationActive()) throw new Error('웹에서 응답을 생성 중입니다. 완료 후 대화를 전환하세요.');
    if (!browser.getComposer) return;
    let composer;
    try { composer = await browser.getComposer(); } catch { return; /* Authentication/loading screen. */ }
    if ((await readComposer(composer.locator)).text.trim()) throw new Error('웹 입력창에 작성 중인 내용이 있어 대화를 전환하지 않았습니다. 초안을 먼저 정리하세요.');
  }
  async openWeb(url) {
    const host = this.host;
    const browser = await host.ensureBrowser();
    if (conversationUrl(browser.page.url()).url !== url) {
      await this.protectWebDraft(browser);
      await browser.page.goto(validateCopilotUrl(url), { waitUntil: 'domcontentloaded' });
    }
    return browser;
  }
  async prepareWeb() {
    const host = this.host, browser = host.browser;
    const revision = this.revision, sessionId = host.sessionId;
    if (host.webUrl) await this.openWeb(host.webUrl);
    else if (host.newWebChat) {
      await this.protectWebDraft(browser);
      await browser.newChat();
      await browser.waitForComposer(text => host.post({ type: 'status', text }));
    }
    if (host.stopRequested || this.revision !== revision || host.sessionId !== sessionId) throw new Error('작업을 중지했습니다.');
    host.newWebChat = false;
  }
  saveSession() {
    const host = this.host;
    if (!host.sessionId) host.sessionId = crypto.randomUUID();
    const session = { id: host.sessionId, title: host.events.find(event => event.role === 'user')?.text.slice(0, 70) || '새 대화', updated: Date.now(), events: host.events, webUrl: host.webUrl, newWebChat: Boolean(host.newWebChat) };
    host.sessions = [session, ...host.sessions.filter(item => item.id !== session.id)].slice(0, 20);
    host.context.workspaceState.update('sessions', host.sessions);
    host.context.workspaceState.update('activeSession', host.sessionId);
  }
  async newChat() {
    const host = this.host;
    if (host.starting || host.sessionSwitching || host.agent?.running) throw new Error('진행 중인 작업을 먼저 중지하세요.');
    this.invalidate();
    host.saveSession();
    host.sessionId = crypto.randomUUID();
    host.events = [];
    host.webUrl = undefined;
    host.newWebChat = true;
    host.attachments = [];
    host.saveSession();
    host.view?.webview.postMessage(host.state());
    host.post({ type: 'status', text: '새 대화 · 작업을 입력하세요.' });
  }
  async showHistory() {
    const host = this.host;
    const vscode = this.vscode;
    if (host.starting || host.sessionSwitching || host.agent?.running) return;
    this.invalidate(); host.sessionSwitching = true; host.stopRequested = false;
    host.post({ type: 'busy' });
    try {
      const selected = await vscode.window.showQuickPick(host.sessions.filter(session => session.events.length).map(session => ({ label: session.title, description: new Date(session.updated).toLocaleString(), session })), { placeHolder: '이어서 작업할 대화' });
      if (!selected || host.stopRequested) return;
      if (selected.session.webUrl) await this.openWeb(selected.session.webUrl);
      if (host.stopRequested) return;
      host.saveSession();
      host.sessionId = selected.session.id;
      host.events = selected.session.events;
      host.webUrl = selected.session.webUrl;
      host.newWebChat = !host.webUrl;
      host.saveSession();
    } finally { host.sessionSwitching = false; host.view?.webview.postMessage(host.state()); host.post({ type: 'idle' }); }
  }
  async syncWeb(manual = true) {
    const host = this.host;
    if (host.starting || host.sessionSwitching || host.agent?.running || host.syncing) return;
    if (host.newWebChat) { if (manual) host.post({ type: 'status', text: '이 대화는 첫 요청을 보내면 새 웹 대화와 연결됩니다.' }); return; }
    if (!host.browser?.page || host.browser.page.isClosed() || !host.browser.readConversation) { if (manual) throw new Error('먼저 Copilot을 연결하고 웹 대화를 여세요.'); return; }
    host.syncing = true;
    const sessionId = host.sessionId, revision = this.revision, browser = host.browser, page = browser.page;
    const pageUrl = page.url ? conversationUrl(page.url()).url : undefined;
    try {
      if (!manual && !host.view?.visible) return;
      const snapshot = await host.browser.readConversation();
      if (host.starting || host.sessionSwitching || host.agent?.running || host.newWebChat || host.sessionId !== sessionId || this.revision !== revision || host.browser !== browser || browser.page !== page || page.isClosed() || (pageUrl && conversationUrl(page.url()).url !== pageUrl)) return;
      if (host.webUrl && !snapshot.restorable) { if (manual) host.post({ type: 'status', text: '웹 대화 주소가 아직 정해지지 않았습니다. 웹에서 대화를 시작한 뒤 동기화하세요.' }); return; }
      const previousUrl = host.webUrl;
      if (snapshot.restorable && host.webUrl !== snapshot.url) {
        const session = host.sessions.find(session => session.webUrl === snapshot.url);
        if (session) { host.sessionId = session.id; host.events = session.events; }
        else if (host.webUrl) { host.saveSession(); host.sessionId = crypto.randomUUID(); host.events = []; }
        host.webUrl = snapshot.url;
      }
      const merged = mergeHistory(host.events, snapshot.messages);
      const changed = JSON.stringify(merged) !== JSON.stringify(host.events);
      host.events = merged;
      if (changed || previousUrl !== host.webUrl) host.saveSession();
      if (changed || previousUrl !== host.webUrl || manual) host.view?.webview.postMessage(host.state());
      if (manual) host.post({ type: 'status', text: snapshot.messages.length ? `웹 대화 동기화 · ${snapshot.messages.length}개 메시지 확인` : '웹 대화 메시지 영역을 읽지 못했습니다. 현재 로컬 기록은 유지했습니다.' });
    } finally { host.syncing = false; }
  }
}
module.exports = { ConversationController };
