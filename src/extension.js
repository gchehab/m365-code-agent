'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { WorkspaceStore, digest } = require('./workspace');
const { CopilotBrowser } = require('./browser');
const { CodingAgent } = require('./agent');

class AgentView {
  constructor(context) {
    this.context = context;
    this.events = [];
    this.browser = null;
    this.agent = null;
    this.pending = null;
    this.previews = new Map();
    this.output = vscode.window.createOutputChannel('M365 Code Agent');
    this.config = () => vscode.workspace.getConfiguration('m365Agent');
  }
  post(event) {
    if (event.type === 'message') {
      this.events.push(event);
      this.events = this.events.slice(-100);
    }
    this.view?.webview.postMessage(event);
    if (event.type === 'status') this.output.appendLine(event.text);
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const nonce = crypto.randomBytes(18).toString('base64');
    const resource = name => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    view.webview.html = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('view.css')}"></head><body>
<header><h2>M365 Code Agent</h2><p>프로젝트에서 읽고 수정하고, Copilot과 자동으로 대화합니다.</p></header>
<div class="toolbar"><button id="connect">Copilot 연결</button><button id="newChat">새 대화</button><button id="diagnostics">진단</button></div>
<div id="messages" aria-live="polite"></div><div id="status" role="status">최초 한 번 Copilot 연결 후 회사 계정으로 로그인하세요.</div>
<section id="changes" hidden><strong id="changeTitle">변경 미리보기</strong><div id="changeFiles"></div><div class="toolbar"><button id="apply">적용</button><button id="reject">취소</button></div></section>
<form id="form"><label for="task">개발 요청</label><textarea id="task" rows="5" placeholder="예: 평균 계산 함수가 빈 배열을 처리하도록 수정하고 테스트 파일도 만들어줘."></textarea>
<label class="option"><input type="checkbox" id="includeEditor" checked> 열린 파일 또는 선택 영역 포함</label>
<label class="option"><input type="checkbox" id="review">파일 수정 전 미리보기 확인</label>
<div class="toolbar"><button id="run" type="submit">작업 시작</button><button id="stop" type="button" disabled>중지</button></div></form>
<p class="hint">브라우저 추가 확장과 클립보드는 사용하지 않습니다. 첫 로그인·MFA와 세션 만료 시 재로그인은 직접 진행하세요.</p>
<script nonce="${nonce}" src="${resource('view.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage(message => this.handle(message).catch(error => {
      this.post({ type: 'message', role: 'system', text: error.message });
      this.post({ type: 'idle' });
    }), undefined, this.context.subscriptions);
  }
  async rootFolder() {
    if (!vscode.workspace.isTrusted) throw new Error('신뢰할 수 있는 프로젝트에서만 실행할 수 있습니다.');
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error('먼저 VS Code에서 작업할 폴더를 여세요.');
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(folders.map(value => ({ label: value.name, value })), { placeHolder: '이번 작업의 프로젝트 폴더를 선택하세요.' }).then(pick => pick?.value);
    if (!folder) throw new Error('프로젝트 선택을 취소했습니다.');
    if (folder.uri.scheme !== 'file') throw new Error('이 버전은 같은 Windows PC의 로컬 프로젝트만 지원합니다.');
    return folder;
  }
  async ensureBrowser() {
    if (!this.browser) {
      const config = this.config();
      const profile = path.join(this.context.globalStorageUri.fsPath, 'edge-profile');
      await fs.mkdir(profile, { recursive: true });
      this.browser = new CopilotBrowser({
        profile, url: config.get('copilotUrl'), channel: config.get('browserChannel'),
        composerSelector: config.get('composerSelector'), sendButtonSelector: config.get('sendButtonSelector'),
        responseSelector: config.get('responseSelector'), timeoutSeconds: config.get('responseTimeoutSeconds')
      });
    }
    try { await this.browser.connect(); }
    catch (error) {
      throw new Error(`M365 연결 실패: ${error.message}\nPC에 Edge가 설치되어 있고 회사 정책에서 브라우저 자동화가 허용되는지 확인하세요.`);
    }
    return this.browser;
  }
  async connect() {
    await this.ensureBrowser();
    const result = await this.browser.diagnostics();
    this.post({ type: 'message', role: 'system', text: `전용 브라우저 연결: ${result.title}\n${result.url}\n회사 계정 로그인 후 대화 화면에서 작업을 시작하세요.` });
  }
  async newChat() {
    if (this.agent?.running) throw new Error('진행 중인 작업을 먼저 중지하세요.');
    const browser = await this.ensureBrowser();
    await browser.newChat();
    this.post({ type: 'message', role: 'system', text: 'Copilot에서 새 대화를 열었습니다.' });
  }
  async diagnostics() {
    const browser = await this.ensureBrowser();
    const data = await browser.diagnostics();
    this.output.appendLine(JSON.stringify(data, null, 2));
    this.output.show();
    this.post({ type: 'message', role: 'system', text: `연결 진단\n주소: ${data.url}\n입력창: ${data.composer}\n페이지 프레임: ${data.frames}` });
  }
  async stop() {
    if (this.pending) { const pending = this.pending; this.pending = null; pending.resolve(false); }
    if (this.agent) await this.agent.stop();
    this.post({ type: 'status', text: '중지 요청됨. 이후 응답은 파일에 적용하지 않습니다.' });
  }
  async start(message) {
    if (this.agent?.running) throw new Error('이미 실행 중입니다.');
    const folder = await this.rootFolder();
    const browser = await this.ensureBrowser();
    const store = await new WorkspaceStore(folder.uri.fsPath, async target => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      return document.getText();
    }).initialize();
    let extraContext = '';
    const editor = vscode.window.activeTextEditor;
    if (message.includeEditor && editor && editor.document.uri.scheme === 'file') {
      const relative = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/');
      try {
        const file = await store.readFile(relative);
        const selection = editor.selection.isEmpty ? file.content : editor.document.getText(editor.selection);
        if (!editor.selection.isEmpty || selection.length > 10000) store.ledger.delete(file.path);
        if (selection.length <= 10000) extraContext = JSON.stringify({ path: file.path, hash: file.hash, selectionOnly: !editor.selection.isEmpty, content: selection });
        else this.post({ type: 'message', role: 'system', text: '열린 파일이 커서 자동 첨부를 생략했습니다. 에이전트가 필요한 파일을 요청합니다.' });
      } catch { /* Outside-root or ignored files are not attached. */ }
    }
    this.post({ type: 'busy' });
    this.agent = new CodingAgent({ store, transport: browser, emit: event => this.post(event),
      maxRounds: this.config().get('maxRounds'), maxPromptCharacters: this.config().get('maxPromptCharacters'),
      approveAndApply: (changes, summary) => this.stageAndApply(store, changes, summary, Boolean(message.review)) });
    try { await this.agent.run(message.task, extraContext); }
    catch (error) { this.post({ type: 'message', role: 'system', text: error.message }); }
    finally { this.post({ type: 'idle' }); }
  }
  async stageAndApply(store, changes, summary, review) {
    for (const [index, change] of changes.entries()) {
      const id = crypto.randomUUID();
      change.previewId = id;
      this.previews.set(id + '-old', change.original);
      this.previews.set(id + '-new', change.content);
      if (this.previews.size > 200) this.previews.delete(this.previews.keys().next().value);
    }
    this.post({ type: 'changes', summary, files: changes.map(change => ({ path: change.path, action: change.action, id: change.previewId })), review });
    if (review) {
      const approved = await new Promise(resolve => { this.pending = { resolve, changes }; });
      this.pending = null;
      if (!approved || this.agent.cancelled) return false;
    }
    if (this.agent.cancelled) return false;
    await store.verifyChanges(changes);
    const edit = new vscode.WorkspaceEdit();
    const documents = [];
    for (const change of changes) {
      const uri = vscode.Uri.file(change.target);
      if (change.action === 'create') {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(change.target)));
        edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), change.content);
      } else {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) throw new Error(`저장하지 않은 변경이 있는 파일입니다. 먼저 저장 후 다시 요청하세요: ${change.path}`);
        if (digest(document.getText()) !== change.expectedHash) throw new Error(`파일이 변경되었습니다: ${change.path}`);
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), change.content);
      }
      documents.push(uri);
    }
    await store.verifyChanges(changes);
    if (this.agent.cancelled) return false;
    if (!await vscode.workspace.applyEdit(edit, { isRefactoring: false })) throw new Error('VS Code가 변경 적용을 거부했습니다. 편집기에서 파일 상태를 확인하세요.');
    const failed = [];
    for (const uri of documents) {
      const document = await vscode.workspace.openTextDocument(uri);
      if (!await document.save()) failed.push(path.basename(uri.fsPath));
    }
    if (failed.length) throw new Error(`편집기에 적용했지만 저장하지 못한 파일이 있습니다: ${failed.join(', ')}. 직접 확인하세요.`);
    this.post({ type: 'message', role: 'system', text: `${changes.length}개 파일을 적용하고 저장했습니다. 테스트는 실행하지 않았습니다.` });
    this.post({ type: 'applied' });
    return true;
  }
  async handle(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') { this.view.webview.postMessage({ type: 'history', events: this.events, running: Boolean(this.agent?.running) }); return; }
    if (message.type === 'connect') return this.connect();
    if (message.type === 'newChat') return this.newChat();
    if (message.type === 'diagnostics') return this.diagnostics();
    if (message.type === 'run') return this.start(message);
    if (message.type === 'stop') return this.stop();
    if (message.type === 'apply' || message.type === 'reject') {
      if (this.pending) { const pending = this.pending; this.pending = null; pending.resolve(message.type === 'apply'); }
      return;
    }
    if (message.type === 'preview') {
      if (typeof message.id !== 'string' || !this.previews.has(message.id + '-new')) return;
      const makeUri = suffix => vscode.Uri.from({ scheme: 'm365-agent-preview', path: '/' + message.id + suffix });
      return vscode.commands.executeCommand('vscode.diff', makeUri('-old'), makeUri('-new'), 'M365 Agent · 변경 미리보기');
    }
  }
  async dispose() { await this.stop(); if (this.browser) await this.browser.close(); this.output.dispose(); }
}

function activate(context) {
  const provider = new AgentView(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('m365Agent.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('m365-agent-preview', {
    provideTextDocumentContent: uri => provider.previews.get(uri.path.slice(1)) || ''
  }));
  const command = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, () => Promise.resolve(fn()).catch(error => vscode.window.showErrorMessage(error.message))));
  command('m365Agent.open', () => vscode.commands.executeCommand('m365Agent.chat.focus'));
  command('m365Agent.connect', () => provider.connect());
  command('m365Agent.newChat', () => provider.newChat());
  command('m365Agent.stop', () => provider.stop());
  command('m365Agent.diagnostics', () => provider.diagnostics());
  context.subscriptions.push({ dispose: () => { provider.dispose().catch(() => {}); } });
  return { provider };
}
module.exports = { activate };
