'use strict';
const { randomBytes } = require('node:crypto');
const { setInterval, clearInterval } = require('node:timers');
const { BrowserScreen } = require('./browser-screen');

function renderBrowserPanel(nonce, source, resource) {
  return `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${source}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${resource('browser.css')}"></head><body><header><nav aria-label="브라우저 탐색"><button id="back" title="뒤로" aria-label="뒤로">←</button><button id="forward" title="앞으로" aria-label="앞으로">→</button><button id="reload" title="새로 고침" aria-label="새로 고침">↻</button></nav><select id="pages" aria-label="브라우저 탭"></select><button id="reconnect">다시 연결</button><button id="external" title="진행 중인 작업을 중지하고 외부 브라우저로 전환합니다.">외부 브라우저로 전환</button></header><div id="address"></div><div id="notice" role="status">Copilot 연결 중… 로그인은 아래 화면에서 직접 진행하세요.</div><main id="viewport"><canvas id="screen" aria-label="Copilot 브라우저 화면"></canvas><input type="password" id="keyboard" aria-label="브라우저 키보드 입력" autocomplete="off" autocapitalize="off" spellcheck="false"><div id="empty">브라우저 화면을 연결하고 있습니다…</div></main><script nonce="${nonce}" src="${resource('browser-view.js')}"></script></body></html>`;
}

class BrowserPanel {
  constructor(host, vscode) { this.host = host; this.vscode = vscode; }
  show(preserveFocus = true) {
    const vscode = this.vscode;
    if (this.panel) { this.panel.reveal(undefined, preserveFocus); return; }
    const panel = vscode.window.createWebviewPanel('m365Agent.browser', 'M365 Copilot 브라우저', { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.host.context.extensionUri, 'media')] });
    this.panel = panel; this.ready = false;
    const resource = name => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.host.context.extensionUri, 'media', name));
    panel.webview.html = renderBrowserPanel(randomBytes(18).toString('base64'), panel.webview.cspSource, resource);
    panel.webview.onDidReceiveMessage(message => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'ready') { this.ready = true; this.resume(); return; }
      if (message.type === 'external') { this.host.switchBrowserView('external').catch(() => this.notice('외부 브라우저 전환에 실패했습니다. 연결 설정을 확인하세요.')); return; }
      if (message.type === 'reconnect') { this.host.ensureBrowser().catch(() => this.notice('연결하지 못했습니다. M365 Agent의 연결 진단을 확인하세요.')); return; }
      this.screen?.handle(message).catch(() => this.notice('브라우저 동작을 완료하지 못했습니다. 화면 상태를 확인한 뒤 다시 시도하세요.'));
    });
    panel.onDidChangeViewState(() => { if (this.panel === panel) { if (panel.visible) this.resume(); else this.pause(); } });
    panel.onDidDispose(() => { if (this.panel === panel) { this.panel = null; this.ready = false; this.pause(); } });
  }
  notice(text) { this.panel?.webview.postMessage({ type: 'browserNotice', text }); }
  resume() {
    if (!this.ready || !this.panel?.visible || this.screen) return;
    const screen = new BrowserScreen(() => this.host.browser, event => { if (this.screen === screen && this.panel?.visible) this.panel.webview.postMessage(event); });
    this.screen = screen;
    this.panel.webview.postMessage({ type: 'requestResize' });
    this.timer = setInterval(() => { screen.update().catch(() => {}); }, 350); this.timer.unref();
    screen.update().catch(() => {});
  }
  pause() { clearInterval(this.timer); this.timer = null; const screen = this.screen; this.screen = null; screen?.dispose().catch(() => {}); }
  dispose() { this.pause(); this.ready = false; this.panel?.dispose(); this.panel = null; }
}
module.exports = { BrowserPanel, renderBrowserPanel };
