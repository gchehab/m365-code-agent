'use strict';
const { randomBytes } = require('node:crypto');
const { renderMarkdown } = require('./markdown');
const { getLanguagePack } = require('./i18n');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderResponse({ text, nonce, cspSource, resource, lang }) {
  const pack = getLanguagePack(lang);
  const s = pack.ui;
  const i18nPayload = JSON.stringify({
    code: pack.code,
    dateLocale: pack.dateLocale,
    ui: s,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="${escapeHtml(pack.htmlLang)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('view.css')}">
</head>
<body class="reader wrap-code">
<header class="reader-header">
<strong>${escapeHtml(s.responsePanelTitle)}</strong>
<button id="copyResponse">${escapeHtml(s.copyAnswer)}</button>
<label>
<input id="wrapCode" type="checkbox" checked>${escapeHtml(s.wrapCode)}</label>
<button id="fontSmaller" aria-label="${escapeHtml(s.fontSmaller)}">A−</button>
<output id="fontSize">14</output>
<button id="fontLarger" aria-label="${escapeHtml(s.fontLarger)}">A+</button>
</header>
<main class="reader-content markdown">${renderMarkdown(text)}</main>
<script nonce="${nonce}">window.M365_I18N = ${i18nPayload};</script>
<script nonce="${nonce}" src="${resource('reading.js')}">
</script>
<script nonce="${nonce}" src="${resource('response-view.js')}">
</script>
</body>
</html>`;
}

class ResponsePanel {
  constructor(host, vscode) {
    this.host = host;
    this.vscode = vscode;
  }
  show(message) {
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 1024 * 1024) return;
    const vscode = this.vscode;
    const pack = getLanguagePack();
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        'm365Agent.response',
        pack.ui.responsePanelTitle,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(this.host.context.extensionUri, 'media')],
        },
      );
      this.panel = panel;
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = null;
          this.text = '';
        }
      });
      panel.webview.onDidReceiveMessage((value) => {
        if (this.panel !== panel || !value) return;
        if (value.type === 'ready') panel.webview.postMessage({ type: 'readingSettings', ...this.settings });
        if (value.type === 'copyResponse') this.host.copyText({ ...value, text: this.text }, panel.webview);
        if (value.type === 'copyCode') this.host.copyText(value, panel.webview);
        if (value.type === 'openLink' && typeof value.url === 'string' && /^https?:\/\//i.test(value.url))
          vscode.env.openExternal(vscode.Uri.parse(value.url));
      });
    } else {
      this.panel.title = pack.ui.responsePanelTitle;
      this.panel.reveal();
    }
    this.text = message.text;
    this.settings = {
      readingSize: Number.isFinite(message.readingSize)
        ? Math.min(18, Math.max(12, message.readingSize))
        : 14,
      wrapCode: message.wrapCode !== false,
    };
    this.render();
  }
  render() {
    if (!this.panel || !this.text) return;
    const pack = getLanguagePack();
    this.panel.title = pack.ui.responsePanelTitle;
    const resource = (name) =>
      this.panel.webview.asWebviewUri(
        this.vscode.Uri.joinPath(this.host.context.extensionUri, 'media', name),
      );
    this.panel.webview.html = renderResponse({
      text: this.text,
      nonce: randomBytes(18).toString('base64'),
      cspSource: this.panel.webview.cspSource,
      resource,
    });
  }
  dispose() {
    this.panel?.dispose();
    this.panel = null;
    this.text = '';
  }
}
module.exports = { ResponsePanel, renderResponse };
