'use strict';
const crypto = require('node:crypto');
const { validateCopilotUrl } = require('./browser');
const { conversationUrl, mergeHistory } = require('./web-history');
const { readComposer } = require('./composer');
const { t } = require('./i18n');

class ConversationController {
  constructor(host, vscode) {
    this.host = host;
    this.vscode = vscode;
    this.revision = 0;
  }
  invalidate() {
    this.revision++;
  }
  async protectWebDraft(browser) {
    if (browser.generationActive && (await browser.generationActive()))
      throw new Error(t('errWebGeneratingSwitch'));
    if (!browser.getComposer) return;
    let composer;
    try {
      composer = await browser.getComposer();
    } catch {
      return; /* Authentication/loading screen. */
    }
    if ((await readComposer(composer.locator)).text.trim()) throw new Error(t('errWebDraftExistsSwitch'));
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
    const host = this.host,
      browser = host.browser;
    const revision = this.revision,
      sessionId = host.sessionId;
    if (host.webUrl) await this.openWeb(host.webUrl);
    else if (host.newWebChat) {
      await this.protectWebDraft(browser);
      await browser.newChat();
      await browser.waitForComposer((text) => host.post({ type: 'status', text }));
    }
    if (host.stopRequested || this.revision !== revision || host.sessionId !== sessionId)
      throw new Error(t('errTaskStopped'));
    host.newWebChat = false;
  }
  saveSession() {
    const host = this.host;
    if (!host.sessionId) host.sessionId = crypto.randomUUID();
    const customTitle = host.sessions.find((session) => session.id === host.sessionId)?.customTitle;
    const session = {
      id: host.sessionId,
      title:
        customTitle ||
        host.events.find((event) => event.role === 'user')?.text.slice(0, 70) ||
        t('defaultSessionTitle'),
      ...(customTitle ? { customTitle } : {}),
      updated: Date.now(),
      events: host.events,
      webUrl: host.webUrl,
      newWebChat: Boolean(host.newWebChat),
    };
    host.sessions = [session, ...host.sessions.filter((item) => item.id !== session.id)].slice(0, 20);
    host.context.workspaceState.update('sessions', host.sessions);
    host.context.workspaceState.update('activeSession', host.sessionId);
  }
  async newChat() {
    const host = this.host;
    if (host.starting || host.switchingBrowser || host.sessionSwitching || host.agent?.running)
      throw new Error(t('errStopTaskFirst'));
    this.invalidate();
    host.saveSession();
    host.sessionId = crypto.randomUUID();
    host.events = [];
    host.webUrl = undefined;
    host.newWebChat = true;
    host.attachments = [];
    host.saveSession();
    host.view?.webview.postMessage(host.state());
    host.post({ type: 'status', text: t('statusNewChatReady') });
  }
  async showHistory() {
    return this.selectSession(
      async () =>
        (
          await this.vscode.window.showQuickPick(
            this.summaries().map((item) => ({
              label: item.title,
              description: new Date(item.updated).toLocaleString(),
              id: item.id,
            })),
            { placeHolder: t('pickHistoryPlaceholder') },
          )
        )?.id,
    );
  }
  summaries() {
    const host = this.host;
    return host.sessions
      .filter((session) => session.events.length || session.customTitle)
      .map((session) => ({
        id: session.id,
        title: session.title,
        updated: session.updated,
        count: session.events.filter((event) => event.type === 'message').length,
        active: session.id === host.sessionId,
        linked: Boolean(session.webUrl),
      }));
  }
  publishList() {
    this.host.view?.webview.postMessage({ type: 'sessions', items: this.summaries() });
  }
  async selectSession(select) {
    const host = this.host;
    if (host.starting || host.switchingBrowser || host.sessionSwitching || host.agent?.running) return;
    this.invalidate();
    host.sessionSwitching = true;
    host.stopRequested = false;
    host.post({ type: 'busy' });
    try {
      const id = typeof select === 'function' ? await select() : select;
      const selected = host.sessions.find((session) => session.id === id);
      if (!selected || host.stopRequested) return;
      if (selected.webUrl) await this.openWeb(selected.webUrl);
      if (host.stopRequested) return;
      host.saveSession();
      host.sessionId = selected.id;
      host.events = selected.events;
      host.webUrl = selected.webUrl;
      host.newWebChat = !host.webUrl;
      host.saveSession();
    } finally {
      host.sessionSwitching = false;
      host.view?.webview.postMessage(host.state());
      host.post({ type: 'idle' });
    }
  }
  async manageSession(action, id) {
    const host = this.host,
      window = this.vscode.window;
    if (host.starting || host.switchingBrowser || host.sessionSwitching || host.agent?.running)
      throw new Error(t('errManageHistoryAfterTask'));
    if (!['rename', 'delete', 'deleteAll'].includes(action)) return;
    const session = host.sessions.find((item) => item.id === id);
    if (action !== 'deleteAll' && !session) return;
    this.invalidate();
    host.sessionSwitching = true;
    host.post({ type: 'busy' });
    const revision = this.revision;
    try {
      if (action === 'rename') {
        const title = await window.showInputBox({
          title: t('renameSessionTitle'),
          value: session.title,
          prompt: t('renameSessionPrompt'),
          validateInput: (value) =>
            !value.trim()
              ? t('errEnterTitle')
              : value.trim().length > 80
                ? t('errTitleMax80')
                : undefined,
        });
        if (title === undefined || this.revision !== revision) return;
        if (typeof title !== 'string' || !title.trim() || title.trim().length > 80)
          throw new Error(t('errTitleRange80'));
        session.title = session.customTitle = title.trim();
      } else {
        const targetIds = new Set(action === 'deleteAll' ? host.sessions.map((item) => item.id) : [id]);
        const label =
          action === 'deleteAll'
            ? t('confirmDeleteAllSessions')
            : t('confirmDeleteSession', { title: session.title });
        const deleteBtn = t('confirmDeleteButton');
        if (
          (await window.showWarningMessage(
            label,
            { modal: true, detail: t('confirmDeleteDetail') },
            deleteBtn,
          )) !== deleteBtn
        )
          return;
        if (this.revision !== revision) return;
        host.sessions = host.sessions.filter((item) => !targetIds.has(item.id));
        if (targetIds.has(host.sessionId)) {
          host.sessionId = crypto.randomUUID();
          host.events = [];
          host.webUrl = undefined;
          host.newWebChat = true;
          host.attachments = [];
          host.saveSession();
        }
      }
      await host.context.workspaceState.update('sessions', host.sessions);
      host.post({
        type: 'status',
        text: action === 'rename' ? t('statusSessionRenamed') : t('statusSessionDeleted'),
      });
    } finally {
      host.sessionSwitching = false;
      this.publishList();
      host.view?.webview.postMessage(host.state());
      host.post({ type: 'idle' });
    }
  }
  async syncWeb(manual = true) {
    const host = this.host;
    if (
      host.starting ||
      host.switchingBrowser ||
      host.sessionSwitching ||
      host.agent?.running ||
      host.syncing
    )
      return;
    if (host.newWebChat) {
      if (manual) host.post({ type: 'status', text: t('statusNewChatLinksOnFirstSend') });
      return;
    }
    if (!host.browser?.page || host.browser.page.isClosed() || !host.browser.readConversation) {
      if (manual) throw new Error(t('errConnectAndOpenWebFirst'));
      return;
    }
    host.syncing = true;
    const sessionId = host.sessionId,
      revision = this.revision,
      browser = host.browser,
      page = browser.page;
    const pageUrl = page.url ? conversationUrl(page.url()).url : undefined;
    try {
      if (!manual && !host.view?.visible) return;
      const snapshot = await host.browser.readConversation();
      if (
        host.starting ||
        host.switchingBrowser ||
        host.sessionSwitching ||
        host.agent?.running ||
        host.newWebChat ||
        host.sessionId !== sessionId ||
        this.revision !== revision ||
        host.browser !== browser ||
        browser.page !== page ||
        page.isClosed() ||
        (pageUrl && conversationUrl(page.url()).url !== pageUrl)
      )
        return;
      if (host.webUrl && !snapshot.restorable) {
        if (manual)
          host.post({
            type: 'status',
            text: t('statusWebUrlNotAssignedYet'),
          });
        return;
      }
      const previousUrl = host.webUrl;
      if (snapshot.restorable && host.webUrl !== snapshot.url) {
        const session = host.sessions.find((session) => session.webUrl === snapshot.url);
        if (session) {
          host.sessionId = session.id;
          host.events = session.events;
        } else if (host.webUrl) {
          host.saveSession();
          host.sessionId = crypto.randomUUID();
          host.events = [];
        }
        host.webUrl = snapshot.url;
      }
      const merged = mergeHistory(host.events, snapshot.messages);
      const changed = JSON.stringify(merged) !== JSON.stringify(host.events);
      host.events = merged;
      if (changed || previousUrl !== host.webUrl) host.saveSession();
      if (changed || previousUrl !== host.webUrl || manual) host.view?.webview.postMessage(host.state());
      if (manual)
        host.post({
          type: 'status',
          text: snapshot.messages.length
            ? t('statusWebSyncedCount', { count: snapshot.messages.length })
            : t('statusWebSyncReadFailed'),
        });
    } finally {
      host.syncing = false;
    }
  }
}
module.exports = { ConversationController };
