'use strict';
const { randomBytes } = require('node:crypto');
const { setInterval, clearInterval } = require('node:timers');
const { BrowserScreen } = require('./browser-screen');
const { getLanguagePack, t } = require('./i18n');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBrowserPanel(nonce, source, resource, lang) {
  const pack = getLanguagePack(lang);
  const s = pack.ui;
  const i18nPayload = JSON.stringify({
    code: pack.code,
    htmlLang: pack.htmlLang,
    ui: s,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="${escapeHtml(pack.htmlLang)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${source}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${resource('browser.css')}">
</head>
<body>
<header>
<nav id="browserNav" aria-label="${escapeHtml(s.browserNavAriaLabel)}">
<button id="back" title="${escapeHtml(s.browserBack)}" aria-label="${escapeHtml(s.browserBack)}">←</button>
<button id="forward" title="${escapeHtml(s.browserForward)}" aria-label="${escapeHtml(s.browserForward)}">→</button>
<button id="reload" title="${escapeHtml(s.browserReload)}" aria-label="${escapeHtml(s.browserReload)}">↻</button>
</nav>
<select id="pages" aria-label="${escapeHtml(s.browserTabsAriaLabel)}">
</select>
<button id="reconnect">${escapeHtml(s.browserReconnect)}</button>
<button id="external" title="${escapeHtml(s.browserExternalTitle)}">${escapeHtml(s.browserExternal)}</button>
</header>
<div id="address">
</div>
<div id="notice" role="status">${escapeHtml(s.browserInitialNotice)}</div>
<main id="viewport">
<canvas id="screen" aria-label="${escapeHtml(s.browserCanvasAriaLabel)}">
</canvas>
<input type="password" id="keyboard" aria-label="${escapeHtml(s.browserKeyboardAriaLabel)}" autocomplete="off" autocapitalize="off" spellcheck="false">
<div id="empty">${escapeHtml(s.browserEmptyConnecting)}</div>
</main>
<script nonce="${nonce}">window.M365_I18N = ${i18nPayload};</script>
<script nonce="${nonce}" src="${resource('browser-view.js')}">
</script>
</body>
</html>`;
}

class BrowserPanel {
  constructor(host, vscode) {
    this.host = host;
    this.vscode = vscode;
  }
  show(preserveFocus = true) {
    const vscode = this.vscode;
    const pack = getLanguagePack();
    if (this.panel) {
      this.panel.title = pack.ui.browserPanelTitle;
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'm365Agent.browser',
      pack.ui.browserPanelTitle,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.host.context.extensionUri, 'media')],
      },
    );
    this.panel = panel;
    this.ready = false;
    const resource = (name) =>
      panel.webview.asWebviewUri(vscode.Uri.joinPath(this.host.context.extensionUri, 'media', name));
    panel.webview.html = renderBrowserPanel(
      randomBytes(18).toString('base64'),
      panel.webview.cspSource,
      resource,
    );
    panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'ready') {
        this.ready = true;
        this.resume();
        return;
      }
      if (message.type === 'external') {
        this.host
          .switchBrowserView('external')
          .catch(() => this.notice(t('browserSwitchExternalFailed')));
        return;
      }
      if (message.type === 'reconnect') {
        this.host
          .ensureBrowser()
          .catch(() => this.notice(t('browserReconnectFailed')));
        return;
      }
      this.screen
        ?.handle(message)
        .catch(() => this.notice(t('browserActionFailed')));
    });
    panel.onDidChangeViewState(() => {
      if (this.panel === panel) {
        if (panel.visible) this.resume();
        else this.pause();
      }
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = null;
        this.ready = false;
        this.pause();
      }
    });
  }
  refreshLanguage() {
    if (!this.panel) return;
    const pack = getLanguagePack();
    this.panel.title = pack.ui.browserPanelTitle;
    this.panel.webview.postMessage({
      type: 'language',
      i18n: { code: pack.code, htmlLang: pack.htmlLang, ui: pack.ui },
    });
  }
  notice(text) {
    this.panel?.webview.postMessage({ type: 'browserNotice', text });
  }
  resume() {
    if (!this.ready || !this.panel?.visible || this.screen) return;
    const screen = new BrowserScreen(
      () => this.host.browser,
      (event) => {
        if (this.screen === screen && this.panel?.visible) this.panel.webview.postMessage(event);
      },
    );
    this.screen = screen;
    this.panel.webview.postMessage({ type: 'requestResize' });
    this.timer = setInterval(() => {
      screen.update().catch(() => {});
    }, 350);
    this.timer.unref();
    screen.update().catch(() => {});
  }
  pause() {
    clearInterval(this.timer);
    this.timer = null;
    const screen = this.screen;
    this.screen = null;
    screen?.dispose().catch(() => {});
  }
  dispose() {
    this.pause();
    this.ready = false;
    this.panel?.dispose();
    this.panel = null;
  }
}
module.exports = { BrowserPanel, renderBrowserPanel };
