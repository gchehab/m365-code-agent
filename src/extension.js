'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { WorkspaceStore, digest } = require('./workspace');
const { CopilotBrowser } = require('./browser');
const { CodingAgent } = require('./agent');
const { CommandRunner } = require('./terminal');
const { requiresReview } = require('./policy');
const { renderWebview } = require('./view');

class AgentView {
  constructor(context) {
    this.context = context;
    this.sessions = context.workspaceState.get('sessions', []);
    this.sessionId = context.workspaceState.get('activeSession');
    this.events = this.sessions.find(session => session.id === this.sessionId)?.events || [];
    this.attachments = [];
    this.checkpoints = [];
    this.changedFiles = new Map();
    this.runner = new CommandRunner();
    this.starting = false;
    this.browser = null;
    this.agent = null;
    this.pending = null;
    this.previews = new Map();
    this.output = vscode.window.createOutputChannel('M365 Code Agent');
    this.config = () => vscode.workspace.getConfiguration('m365Agent');
  }
  post(event) {
    if (['message', 'tool'].includes(event.type)) {
      const existing = event.type === 'tool' ? this.events.findIndex(item => item.type === 'tool' && item.id === event.id) : -1;
      if (existing >= 0) this.events[existing] = event;
      else this.events.push(event);
      this.events = this.events.slice(-100);
      this.saveSession();
    }
    this.view?.webview.postMessage(event);
    if (event.type === 'status') this.output.appendLine(event.text);
  }
  saveSession() {
    if (!this.sessionId) this.sessionId = crypto.randomUUID();
    const session = { id: this.sessionId, title: this.events.find(event => event.role === 'user')?.text.slice(0, 70) || '새 대화', updated: Date.now(), events: this.events };
    this.sessions = [session, ...this.sessions.filter(item => item.id !== session.id)].slice(0, 20);
    this.context.workspaceState.update('sessions', this.sessions);
    this.context.workspaceState.update('activeSession', this.sessionId);
  }
  state() {
    return { type: 'history', events: this.events, running: this.starting || Boolean(this.agent?.running), attachments: this.attachments, undo: this.checkpoints.length > 0, pending: this.pending?.viewData };
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const nonce = crypto.randomBytes(18).toString('base64');
    const resource = name => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    view.webview.html = renderWebview({ nonce, cspSource: view.webview.cspSource, resource });
    view.webview.onDidReceiveMessage(message => this.handle(message).catch(error => {
      this.post({ type: 'message', role: 'system', text: error.message });
      if (!this.starting && !this.agent?.running) this.post({ type: 'idle' });
      this.post({ type: 'status', text: error.message, error: true });
    }), undefined, this.context.subscriptions);
  }
  async rootFolder() {
    if (!vscode.workspace.isTrusted) throw new Error('신뢰할 수 있는 프로젝트에서만 실행할 수 있습니다.');
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error('먼저 VS Code에서 작업할 폴더를 여세요.');
    const folder = this.folder || (folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(folders.map(value => ({ label: value.name, value })), { placeHolder: '이번 작업의 프로젝트 폴더를 선택하세요.' }).then(pick => pick?.value));
    if (!folder) throw new Error('프로젝트 선택을 취소했습니다.');
    if (folder.uri.scheme !== 'file') throw new Error('이 버전은 같은 Windows PC의 로컬 프로젝트만 지원합니다.');
    this.folder = folder;
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
      throw new Error(`M365 연결 실패: ${error.message}\nPC에 Edge가 설치되어 있고 회사 정책에서 브라우저 자동화가 허용되는지 확인하세요.`, { cause: error });
    }
    return this.browser;
  }
  async connect() {
    await this.ensureBrowser();
    const result = await this.browser.diagnostics();
    this.post({ type: 'message', role: 'system', text: `전용 브라우저 연결: ${result.title}\n${result.url}\n회사 계정 로그인 후 대화 화면에서 작업을 시작하세요.` });
  }
  async newChat() {
    if (this.starting || this.agent?.running) throw new Error('진행 중인 작업을 먼저 중지하세요.');
    this.saveSession();
    this.sessionId = crypto.randomUUID();
    this.events = [];
    this.attachments = [];
    this.saveSession();
    this.view?.webview.postMessage(this.state());
    this.post({ type: 'status', text: '새 대화 · 작업을 입력하세요.' });
  }
  async showHistory() {
    if (this.starting || this.agent?.running) return;
    const selected = await vscode.window.showQuickPick(this.sessions.filter(session => session.events.length).map(session => ({ label: session.title, description: new Date(session.updated).toLocaleString(), session })), { placeHolder: '이어서 작업할 대화' });
    if (!selected) return;
    this.sessionId = selected.session.id;
    this.events = selected.session.events;
    this.saveSession();
    this.view?.webview.postMessage(this.state());
  }
  async attachFiles() {
    if (this.starting || this.agent?.running) return;
    const folder = await this.rootFolder();
    const store = await new WorkspaceStore(folder.uri.fsPath).initialize();
    const listing = await store.listFiles(1000);
    const picks = await vscode.window.showQuickPick(listing.files.map(label => ({ label, picked: this.attachments.includes(label) })), { canPickMany: true, placeHolder: '첨부할 파일 선택 (최대 5개)' });
    if (!picks) return;
    if (picks.length > 5) throw new Error('파일은 최대 5개까지 첨부할 수 있습니다.');
    this.attachments = picks.map(pick => pick.label);
    this.view?.webview.postMessage({ type: 'attachments', files: this.attachments });
  }
  async diagnostics() {
    const browser = await this.ensureBrowser();
    const data = await browser.diagnostics();
    this.output.appendLine(JSON.stringify(data, null, 2));
    this.output.show();
    this.post({ type: 'message', role: 'system', text: `연결 진단\n주소: ${data.url}\n입력창: ${data.composer}\n페이지 프레임: ${data.frames}\n최근 전송: ${data.lastSend?.stage || '없음'}${data.lastSend ? `\n입력: 요청 ${data.lastSend.characters}자 / 확인 ${data.lastSend.observedCharacters ?? '?'}자 / 한도 ${data.lastSend.maxLength ?? '미표시'}` : ''}` });
  }
  async stop() {
    this.stopRequested = true;
    this.runner.stop();
    if (this.pending) { const pending = this.pending; this.pending = null; pending.resolve(false); }
    if (this.agent) await this.agent.stop();
    this.post({ type: 'status', text: '중지 요청됨. 이후 응답은 파일에 적용하지 않습니다.' });
  }
  async start(message) {
    if (this.starting || this.agent?.running) throw new Error('이미 실행 중입니다.');
    this.starting = true;
    this.stopRequested = false;
    this.post({ type: 'busy' });
    let errorMessage;
    try {
      const folder = await this.rootFolder();
      const browser = await this.ensureBrowser();
      if (this.stopRequested) throw new Error('작업을 중지했습니다.');
      const store = await new WorkspaceStore(folder.uri.fsPath, async target => {
        const document = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && document.uri.fsPath === target);
        return document ? document.getText() : new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(target));
      }).initialize();
      const contextFiles = [];
      const editor = vscode.window.activeTextEditor;
      if (message.includeEditor && editor && editor.document.uri.scheme === 'file') {
        const relative = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/');
        try {
          const file = await store.readFile(relative);
          const selection = editor.selection.isEmpty ? file.content : editor.document.getText(editor.selection);
          if (!editor.selection.isEmpty || selection.length > 10000) { store.ledger.delete(file.path); store.editReads.delete(file.path); }
          if (selection.length <= 10000) contextFiles.push({ path: file.path, hash: file.hash, selectionOnly: !editor.selection.isEmpty, content: selection });
          else this.post({ type: 'message', role: 'system', text: '열린 파일이 커서 자동 첨부를 생략했습니다. 에이전트가 필요한 파일을 요청합니다.' });
        } catch { /* Outside-root or ignored files are not attached. */ }
      }
      for (const relative of this.attachments) {
        if (contextFiles.some(file => file.path === relative && !file.selectionOnly)) continue;
        const file = await store.readFile(relative);
        if (file.content.length > 10000) { store.ledger.delete(file.path); store.editReads.delete(file.path); contextFiles.push({ path: relative, omitted: '큰 파일입니다. read_file의 줄 범위로 읽으세요.' }); }
        else contextFiles.push(file);
      }
      if (JSON.stringify(contextFiles).length > 24000) throw new Error('첨부 문맥이 큽니다. 첨부 파일 수를 줄이세요.');
      let task = message.task;
      let mode = ['ask', 'plan', 'agent'].includes(message.mode) ? message.mode : 'agent';
      if (/^\/plan(?:\s|$)/i.test(task)) { mode = 'plan'; task = task.replace(/^\/plan\s*/i, '') || '현재 프로젝트의 개선 계획을 세워줘.'; }
      if (/^\/review(?:\s|$)/i.test(task)) { mode = 'ask'; task = '버그와 회귀 위험을 중심으로 코드를 검토하고 파일과 근거를 알려줘. ' + task.replace(/^\/review\s*/i, ''); }
      if (/^\/test(?:\s|$)/i.test(task)) { mode = 'agent'; task = '프로젝트의 테스트 방법을 확인하고 필요한 테스트를 실행해서 실제 결과를 알려줘. ' + task.replace(/^\/test\s*/i, ''); }
      if (this.stopRequested) throw new Error('작업을 중지했습니다.');
      this.agent = new CodingAgent({ store, transport: browser, emit: event => this.post(event),
        mode, conversation: this.events.filter(event => event.type === 'message' && ['user', 'assistant'].includes(event.role)),
        maxRounds: this.config().get('maxRounds'), maxPromptCharacters: this.config().get('maxPromptCharacters'),
        runCommand: command => this.runCommand(command, folder.uri.fsPath),
        approveAndApply: (changes, summary) => this.stageAndApply(store, changes, summary, Boolean(message.review)) });
      await this.agent.run(task, JSON.stringify(contextFiles));
    } catch (error) { errorMessage = error.message; this.post({ type: 'message', role: 'system', text: error.message }); }
    finally {
      this.starting = false;
      this.post({ type: 'idle' });
      this.post({ type: 'status', text: errorMessage || '완료 · 다음 요청을 이어서 입력하세요.', error: Boolean(errorMessage) });
    }
  }
  async runCommand(command, root) {
    if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\0\r\n]/.test(command)) throw new Error('명령 형식이 올바르지 않습니다.');
    if (this.stopRequested) throw new Error('작업을 중지했습니다.');
    const approved = await new Promise(resolve => {
      const changedFiles = [...this.changedFiles.values()].filter(file => path.resolve(file.root).toLowerCase() === path.resolve(root).toLowerCase()).map(file => ({ path: file.path, id: this.previews.has(file.id + '-new') ? file.id : null, sensitive: requiresReview(file.path) }));
      const viewData = { type: 'commandApproval', command, root, changedFiles, token: crypto.randomUUID() };
      this.pending = { kind: 'command', resolve, viewData };
      this.post(viewData);
    });
    this.pending = null;
    this.post({ type: 'approvalClosed' });
    if (!approved || this.stopRequested) return { approved: false, message: '사용자가 실행을 거절했습니다. 다시 요청하지 마세요.' };
    this.output.appendLine(`\n> ${command}\n${root}`);
    this.output.show(true);
    this.runner.encoding = this.config().get('commandOutputEncoding', 'utf8');
    return this.runner.run(command, root, text => this.output.append(text));
  }
  async stageAndApply(store, changes, summary, review) {
    const forcedReview = changes.filter(change => requiresReview(change.path)).map(change => change.path);
    review = review || forcedReview.length > 0;
    for (const change of changes) {
      const id = crypto.randomUUID();
      change.previewId = id;
      this.previews.set(id + '-old', change.original);
      this.previews.set(id + '-new', change.content);
      if (this.previews.size > 200) this.previews.delete(this.previews.keys().next().value);
    }
    const viewData = { type: 'changes', summary, files: changes.map(change => ({ path: change.path, action: change.action, id: change.previewId })), review, forcedReview, token: crypto.randomUUID() };
    if (review) {
      const approved = await new Promise(resolve => { this.pending = { kind: 'changes', resolve, changes, viewData }; this.post(viewData); });
      this.pending = null;
      this.post({ type: 'reviewClosed' });
      if (!approved || this.agent?.cancelled) return false;
    } else this.post(viewData);
    if (this.agent?.cancelled) return false;
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
    if (this.agent?.cancelled) return false;
    if (!await vscode.workspace.applyEdit(edit, { isRefactoring: false })) throw new Error('VS Code가 변경 적용을 거부했습니다. 편집기에서 파일 상태를 확인하세요.');
    this.checkpoints.push({ store, changes });
    for (const change of changes) this.changedFiles.set(store.root.toLowerCase() + '\0' + change.path.toLowerCase(), { root: store.root, path: change.path, id: change.previewId });
    this.checkpoints = this.checkpoints.slice(-20);
    this.post({ type: 'undoState', available: true });
    const failed = [];
    for (const [index, uri] of documents.entries()) {
      const document = await vscode.workspace.openTextDocument(uri);
      if (!await document.save()) failed.push(path.basename(uri.fsPath));
      changes[index].appliedHash = digest(document.getText());
      changes[index].diskHash = await fs.readFile(uri.fsPath, 'utf8').then(digest).catch(() => null);
    }
    if (failed.length) throw new Error(`편집기에 적용했지만 저장하지 못한 파일이 있습니다: ${failed.join(', ')}. 직접 확인하세요.`);
    this.post({ type: 'message', role: 'system', text: `${changes.length}개 파일을 적용하고 저장했습니다. 테스트는 실행하지 않았습니다.` });
    this.post({ type: 'applied' });
    return true;
  }
  async undo() {
    if (this.starting || this.agent?.running) throw new Error('작업 완료 후 되돌릴 수 있습니다.');
    const checkpoint = this.checkpoints.at(-1);
    if (!checkpoint) return;
    const edit = new vscode.WorkspaceEdit();
    const saves = [];
    for (const change of checkpoint.changes) {
      await checkpoint.store.resolve(change.path);
      const uri = vscode.Uri.file(change.target);
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.isDirty || digest(document.getText()) !== change.appliedHash || digest(await fs.readFile(change.target, 'utf8')) !== change.diskHash) throw new Error(`이후 편집이 있어 되돌릴 수 없습니다: ${change.path}`);
      if (change.action === 'create') edit.deleteFile(uri, { recursive: false });
      else { edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), change.original); saves.push(uri); }
    }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('되돌리기를 적용하지 못했습니다.');
    this.checkpoints.pop();
    for (const change of checkpoint.changes) {
      const key = checkpoint.store.root.toLowerCase() + '\0' + change.path.toLowerCase();
      const previous = [...this.checkpoints].reverse().filter(item => item.store.root === checkpoint.store.root).flatMap(item => item.changes).find(item => item.path === change.path);
      if (previous) this.changedFiles.set(key, { root: checkpoint.store.root, path: previous.path, id: previous.previewId });
      else this.changedFiles.delete(key);
    }
    for (const uri of saves) if (!await (await vscode.workspace.openTextDocument(uri)).save()) throw new Error('되돌린 내용을 저장하지 못했습니다. 편집기를 확인하세요.');
    this.post({ type: 'message', role: 'system', text: '마지막 파일 변경을 되돌렸습니다. 터미널에서 발생한 변경은 포함하지 않습니다.' });
    this.post({ type: 'undoState', available: this.checkpoints.length > 0 });
  }
  async handle(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') { this.view.webview.postMessage(this.state()); return; }
    if (message.type === 'history') return this.showHistory();
    if (message.type === 'attach') return this.attachFiles();
    if (message.type === 'removeAttachment' && !this.starting) { this.attachments = this.attachments.filter(file => file !== message.path); this.view.webview.postMessage({ type: 'attachments', files: this.attachments }); return; }
    if (message.type === 'undo') return this.undo();
    if (message.type === 'connect') return this.connect();
    if (message.type === 'newChat') return this.newChat();
    if (message.type === 'diagnostics') return this.diagnostics();
    if (message.type === 'run') return this.start(message);
    if (message.type === 'stop') return this.stop();
    if (message.type === 'apply' || message.type === 'reject') {
      if (this.pending?.kind === 'changes' && message.token === this.pending.viewData.token) { const pending = this.pending; this.pending = null; pending.resolve(message.type === 'apply'); }
      return;
    }
    if (message.type === 'approveCommand' || message.type === 'rejectCommand') {
      if (this.pending?.kind === 'command' && message.token === this.pending.viewData.token) { const pending = this.pending; this.pending = null; pending.resolve(message.type === 'approveCommand'); }
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
