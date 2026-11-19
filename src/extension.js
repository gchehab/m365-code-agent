'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { setInterval, clearInterval } = require('node:timers');
const { WorkspaceStore } = require('./workspace');
const { CopilotBrowser } = require('./browser');
const { CodingAgent } = require('./agent');
const { CommandRunner } = require('./terminal');
const { renderWebview } = require('./view');
const { inspectProject } = require('./project');
const { resolveTask } = require('./task');
const { decorate, decorateHistory } = require('./markdown');
const { mergeHistory } = require('./web-history');
const { t, setLanguage, getLanguage, getLanguagePack, getAvailableLanguages } = require('./i18n');

const { ConversationController } = require('./conversations');
const { ModelController } = require('./models');
const { ChangeController } = require('./changes');
const { BrowserPanel } = require('./browser-panel');
const { ResponsePanel } = require('./response-panel');
const { connectionError, environmentDiagnostics } = require('./connection');
const { EditorActions } = require('./editor-actions');
const { McpBridge } = require('./mcp');
const { registerModelProvider } = require('./model-provider');
const { prepareAttachments, attachmentKind, attachmentExtensions } = require('./attachments');

class AgentView {
  constructor(context) {
    this.context = context;
    this.config = () =>
      vscode.workspace.getConfiguration?.('m365Agent') || { get: (_key, fallback) => fallback };
    this.syncLanguageFromConfig(false);
    this.conversations = new ConversationController(this, vscode);
    this.models = new ModelController(this);
    this.changes = new ChangeController(this, vscode);
    this.browserPanel = new BrowserPanel(this, vscode);
    this.responsePanel = new ResponsePanel(this, vscode);
    this.editorActions = new EditorActions(this, vscode);
    this.mcpBridge = new McpBridge(this, vscode);
    this.sessions = context.workspaceState.get('sessions', []);
    this.sessionId = context.workspaceState.get('activeSession');
    this.events = this.sessions.find((session) => session.id === this.sessionId)?.events || [];
    this.webUrl = this.sessions.find((session) => session.id === this.sessionId)?.webUrl;
    this.newWebChat =
      !this.webUrl || Boolean(this.sessions.find((session) => session.id === this.sessionId)?.newWebChat);
    this.modelChoices = [];
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
    this.syncTimer = setInterval(() => {
      this.syncWeb(false).catch(() => {});
    }, 5000);
    this.syncTimer.unref();
  }
  syncLanguageFromConfig(notify = false) {
    const configured = vscode.workspace.getConfiguration?.('m365Agent')?.get?.('language');
    if (typeof configured === 'string' && configured.trim()) setLanguage(configured);
    if (notify) this.broadcastLanguage();
  }
  i18nState() {
    const pack = getLanguagePack();
    return {
      code: pack.code,
      htmlLang: pack.htmlLang,
      dateLocale: pack.dateLocale,
      ui: pack.ui,
      availableLanguages: getAvailableLanguages(),
    };
  }
  broadcastLanguage() {
    this.view?.webview.postMessage({ type: 'language', i18n: this.i18nState() });
    this.browserPanel.refreshLanguage();
    this.responsePanel.render();
  }
  async changeLanguage(code, persistConfig = true) {
    const resolved = setLanguage(code);
    if (persistConfig) {
      try {
        await this.config().update?.(
          'language',
          resolved,
          vscode.ConfigurationTarget?.Global ?? true,
        );
      } catch {
        /* Proceed with in-memory language selection when config persistence is unavailable. */
      }
    }
    this.broadcastLanguage();
    this.post({
      type: 'status',
      text: t('statusLanguageChanged', { language: getLanguagePack(resolved).label }),
    });
  }
  async selectLanguage() {
    const current = getLanguage();
    const picks = getAvailableLanguages().map((item) => ({
      label: item.label,
      description: item.code === current ? `${item.code} (active)` : item.code,
      code: item.code,
    }));
    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: t('pickLanguagePlaceholder'),
    });
    if (picked) await this.changeLanguage(picked.code, true);
  }
  post(event) {
    if (event.type === 'progress') this.progress = event;
    if (event.type === 'idle') this.progress = null;
    if (['message', 'tool'].includes(event.type)) {
      const existing =
        event.type === 'tool'
          ? this.events.findIndex((item) => item.type === 'tool' && item.id === event.id)
          : -1;
      if (existing >= 0) this.events[existing] = event;
      else this.events.push(event);
      this.events = this.events.slice(-100);
      this.saveSession();
    }
    const request = this.events.findLast((item) => item.type === 'message' && item.role === 'user')?.text;
    this.view?.webview.postMessage(decorate(event, request));
    if (event.type === 'status') this.output.appendLine(event.text);
  }
  saveSession() {
    return this.conversations.saveSession();
  }
  state() {
    return {
      type: 'history',
      i18n: this.i18nState(),
      sessionId: this.sessionId,
      events: decorateHistory(this.events),
      running:
        this.starting || this.switchingBrowser || this.sessionSwitching || Boolean(this.agent?.running),
      attachments: this.attachments,
      undo: this.checkpoints.length > 0,
      pending: this.pending?.viewData,
      workspace: this.workspaceInfo,
      webUrl: this.webUrl,
      models: this.modelChoices,
      selectedModel: this.selectedModel,
      progress: this.progress,
      executionPolicy: this.executionPolicy,
      sessions: this.conversations.summaries(),
    };
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    const nonce = crypto.randomBytes(18).toString('base64');
    const resource = (name) =>
      view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    view.webview.html = renderWebview({
      nonce,
      cspSource: view.webview.cspSource,
      resource,
      lang: getLanguage(),
    });
    view.webview.onDidReceiveMessage(
      (message) =>
        this.handle(message).catch((error) => {
          this.post({ type: 'message', role: 'system', text: error.message });
          if (!this.starting && !this.agent?.running) this.post({ type: 'idle' });
          this.post({ type: 'status', text: error.message, error: true });
        }),
      undefined,
      this.context.subscriptions,
    );
  }
  async rootFolder() {
    if (!vscode.workspace.isTrusted) throw new Error(t('errTrustedWorkspaceOnly'));
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error(t('errOpenFolderFirst'));
    if (this.folder && !folders.some((folder) => folder.uri.toString() === this.folder.uri.toString()))
      this.folder = null;
    const folder =
      this.folder ||
      (folders.length === 1
        ? folders[0]
        : await vscode.window
            .showQuickPick(
              folders.map((value) => ({ label: value.name, value })),
              { placeHolder: t('pickWorkspacePlaceholder') },
            )
            .then((pick) => pick?.value));
    if (!folder) throw new Error(t('errProjectSelectionCancelled'));
    if (folder.uri.scheme !== 'file') throw new Error(t('errLocalWindowsProjectOnly'));
    this.folder = folder;
    return folder;
  }
  async workspaceStore(folder) {
    return new WorkspaceStore(
      folder.uri.fsPath,
      async (target) =>
        vscode.workspace.textDocuments
          .find((document) => document.uri.scheme === 'file' && document.uri.fsPath === target)
          ?.getText(),
      { maxFileBytes: this.config().get('maxFileSizeMB', 16) * 1024 * 1024 },
    ).initialize();
  }
  async checkWorkspace() {
    if (this.starting || this.agent?.running) throw new Error(t('errCheckAfterTask'));
    this.starting = true;
    this.stopRequested = false;
    this.post({ type: 'busy' });
    let probe, handle;
    try {
      const folder = await this.rootFolder();
      const store = await this.workspaceStore(folder);
      const project = await inspectProject(
        store,
        t('projectSourceAnalysisTask'),
        this.config().get('maxPromptCharacters'),
        (event) => this.post(event),
        () => this.stopRequested,
      );
      if (this.stopRequested) throw new Error(t('errCheckStopped'));
      const target = (await store.resolve('.m365-agent-check-' + crypto.randomUUID() + '.tmp', true)).target;
      handle = await fs.open(target, 'wx');
      probe = target;
      await handle.writeFile('M365 Code Agent workspace access check', 'utf8');
      await handle.close();
      handle = null;
      if ((await fs.readFile(target, 'utf8')) !== 'M365 Code Agent workspace access check')
        throw new Error(t('errTempWriteVerificationFailed'));
      this.workspaceInfo = { name: folder.name, path: store.root, read: project.read, writable: true };
      this.post({ type: 'workspace', ...this.workspaceInfo });
      this.post({
        type: 'message',
        role: 'system',
        text: t('msgWorkspaceCheckResult', {
          root: store.root,
          discovered: project.discovered,
          read: project.read,
        }),
      });
    } finally {
      try {
        await handle?.close();
        if (probe) await fs.unlink(probe);
      } finally {
        this.starting = false;
        this.post({ type: 'idle' });
      }
    }
  }
  async ensureBrowser() {
    let stage = 'panel';
    const config = this.config();
    const embedded = (this.browserViewOverride || config.get('browserView', 'editor')) === 'editor';
    const profile = path.join(this.context.globalStorageUri.fsPath, 'edge-profile');
    try {
      if (embedded) this.browserPanel.show();
      stage = 'profile';
      if (!this.browser) {
        await fs.mkdir(profile, { recursive: true });
        this.browser = new CopilotBrowser({
          profile,
          url: config.get('copilotUrl'),
          channel: config.get('browserChannel'),
          embedded: (this.browserViewOverride || config.get('browserView', 'editor')) === 'editor',
          composerSelector: config.get('composerSelector'),
          sendButtonSelector: config.get('sendButtonSelector'),
          responseSelector: config.get('responseSelector'),
          timeoutSeconds: config.get('responseTimeoutSeconds'),
          loginTimeoutSeconds: config.get('loginTimeoutSeconds', 600),
          modelButtonSelector: config.get('modelButtonSelector'),
          attachmentInputSelector: config.get('attachmentInputSelector'),
          attachmentScopeSelector: config.get('attachmentScopeSelector'),
          attachmentButtonSelector: config.get('attachmentButtonSelector'),
          attachmentReadySelector: config.get('attachmentReadySelector'),
          attachmentErrorSelector: config.get('attachmentErrorSelector'),
          attachmentTimeoutMs: config.get('attachmentTimeoutSeconds', 120) * 1000,
          onConversation: (info) => {
            if (info.restorable) {
              this.webUrl = info.url;
              this.saveSession();
              this.post({ type: 'webConversation', url: info.url });
            }
          },
        });
      }
      stage = 'launch';
      await this.browser.connect();
      this.lastConnectionFailure = null;
    } catch (error) {
      const failure = connectionError(error, stage, {
        profile,
        channel: config.get('browserChannel', 'msedge'),
        embedded,
      });
      this.lastConnectionFailure = failure.connectionFailure;
      this.output.appendLine(
        JSON.stringify({ type: 'connectionFailure', ...this.lastConnectionFailure }, null, 2),
      );
      this.output.show(true);
      this.browserPanel.notice(failure.message);
      throw failure;
    }
    return this.browser;
  }
  async connect() {
    if (this.switchingBrowser) throw new Error(t('errReconnectAfterBrowserSwitch'));
    await this.ensureBrowser();
    const result = await this.browser.diagnostics();
    this.post({
      type: 'message',
      role: 'system',
      text: t('msgCopilotBrowserConnected', { title: result.title, url: result.url }),
    });
  }
  async showBrowser() {
    if (this.switchingBrowser) return;
    const browser = await this.ensureBrowser();
    if ((this.browserViewOverride || this.config().get('browserView', 'editor')) === 'editor')
      this.browserPanel.show(false);
    else await browser.page.bringToFront();
  }
  async switchBrowserView(mode) {
    if (!['editor', 'external'].includes(mode) || this.switchingBrowser) return;
    this.switchingBrowser = true;
    this.post({ type: 'busy' });
    try {
      await this.stop();
      await this.currentRun?.catch(() => {});
      this.browserPanel.dispose();
      await this.browser?.close();
      this.browser = null;
      this.browserViewOverride = mode;
      await this.ensureBrowser();
      this.post({
        type: 'status',
        text: mode === 'editor' ? t('statusConnectedVscodeBrowser') : t('statusSwitchedExternalBrowser'),
      });
    } finally {
      this.switchingBrowser = false;
      this.post({ type: 'idle' });
    }
  }
  async newChat() {
    return this.conversations.newChat();
  }
  async showHistory() {
    return this.conversations.showHistory();
  }
  async syncWeb(manual = true) {
    return this.conversations.syncWeb(manual);
  }
  async refreshModels() {
    return this.models.refreshModels();
  }
  async chooseModel(id) {
    return this.models.chooseModel(id);
  }
  async attachFiles() {
    if (this.starting || this.agent?.running || this.sessionSwitching) return;
    const folder = await this.rootFolder();
    const sessionId = this.sessionId;
    const store = await new WorkspaceStore(folder.uri.fsPath).initialize();
    const listing = await store.listFiles(1000);
    const picks = await vscode.window.showQuickPick(
      listing.files.map((label) => ({ label, picked: this.attachments.includes(label) })),
      { canPickMany: true, placeHolder: t('pickAttachFilesPlaceholder') },
    );
    if (
      !picks ||
      this.sessionId !== sessionId ||
      this.starting ||
      this.agent?.running ||
      this.sessionSwitching
    )
      return;
    if (picks.length > 5) throw new Error(t('errMaxFiveFiles'));
    const external = this.attachments.filter((file) => path.isAbsolute(file));
    const selected = new Map();
    for (const file of [...external, ...picks.map((pick) => pick.label)]) {
      const absolute = path.resolve(folder.uri.fsPath, file);
      const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
      if (!selected.has(key)) selected.set(key, file);
    }
    if (selected.size > 5) throw new Error(t('errMaxFiveFilesWithMedia'));
    this.attachments = [...selected.values()];
    this.view?.webview.postMessage({ type: 'attachments', files: this.attachments });
  }
  async attachLocalFiles() {
    if (this.starting || this.agent?.running || this.sessionSwitching) return;
    const folder = await this.rootFolder();
    const sessionId = this.sessionId;
    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: t('openDialogAttachLabel'),
      title: t('openDialogAttachTitle'),
      filters: { [t('openDialogAttachFilter')]: Object.values(attachmentExtensions).flat() },
    });
    if (
      !files ||
      this.sessionId !== sessionId ||
      this.starting ||
      this.agent?.running ||
      this.sessionSwitching
    )
      return;
    if (files.some((file) => file.scheme !== 'file')) throw new Error(t('errSelectLocalFile'));
    const selectedByPath = new Map();
    for (const file of [...this.attachments, ...files.map((file) => file.fsPath)]) {
      const target = path.resolve(folder.uri.fsPath, file);
      const key = process.platform === 'win32' ? target.toLowerCase() : target;
      if (!selectedByPath.has(key)) selectedByPath.set(key, file);
    }
    const selected = [...selectedByPath.values()];
    if (selected.length > 5) throw new Error(t('errMaxFiveFiles'));
    this.attachments = selected;
    this.view?.webview.postMessage({ type: 'attachments', files: this.attachments });
  }
  async diagnostics() {
    const config = this.config();
    const environment = await environmentDiagnostics({
      profile: path.join(this.context.globalStorageUri.fsPath, 'edge-profile'),
      channel: config.get('browserChannel', 'msedge'),
      embedded: (this.browserViewOverride || config.get('browserView', 'editor')) === 'editor',
      version: require('../package.json').version,
      vscodeVersion: vscode.version,
    });
    this.output.appendLine(
      JSON.stringify(
        {
          type: 'connectionEnvironment',
          ...environment,
          lastFailure: this.lastConnectionFailure || this.browser?.lastConnectionFailure || null,
        },
        null,
        2,
      ),
    );
    this.output.show(true);
    const executable =
      environment.defaultExecutableFound === null
        ? t('diagExecNotChecked')
        : environment.defaultExecutableFound
          ? t('diagExecFound')
          : t('diagExecNotFound');
    const writable = environment.profileWritable ? t('diagProfileWritable') : t('diagProfileFailed');
    const recentFailure = this.lastConnectionFailure
      ? t('diagRecentFailure', {
          code: this.lastConnectionFailure.code,
          stage: this.lastConnectionFailure.stage,
        })
      : '';
    const profileError = environment.profileError ? '\n' + environment.profileError : '';
    this.post({
      type: 'message',
      role: 'system',
      text: t('msgEnvironmentDiagnostics', {
        version: environment.version,
        platform: environment.platform,
        architecture: environment.architecture,
        channel: environment.channel,
        display: environment.display,
        executable,
        writable,
        recentFailure,
        profileError,
      }),
    });
    // Diagnostics must remain usable when launch/profile/panel creation failed.
    if (!this.browser?.page || this.browser.page.isClosed()) return;
    let data;
    try {
      data = await this.browser.diagnostics({ connect: false });
    } catch (error) {
      this.output.appendLine(connectionError(error, 'diagnostics', this.browser.options || {}).message);
      return;
    }
    this.output.appendLine(JSON.stringify(data, null, 2));
    this.output.show();
    const sendDetail = data.lastSend
      ? t('diagSendDetail', {
          characters: data.lastSend.characters,
          observed: data.lastSend.observedCharacters ?? '?',
          maxLength: data.lastSend.maxLength ?? t('diagNotShown'),
        })
      : '';
    this.post({
      type: 'message',
      role: 'system',
      text: t('msgConnectionDiagnostics', {
        url: data.url,
        composer: data.composer,
        frames: data.frames,
        stage: data.lastSend?.stage || t('diagNone'),
        sendDetail,
      }),
    });
    if (data.lastResponse) {
      const response = data.lastResponse;
      const stage =
        {
          'not-submitted': t('diagStageNotSubmitted'),
          waiting: t('diagStageWaiting'),
          'json-incomplete': t('diagStageJsonIncomplete'),
          'json-conflict': t('diagStageJsonConflict'),
          'json-confirmed': t('diagStageJsonConfirmed'),
          complete: t('diagStageComplete'),
        }[response.stage] || response.stage;
      this.post({
        type: 'message',
        role: 'system',
        text: t('msgResponseDiagnostics', {
          stage,
          candidates: response.candidates || 0,
          matchingRequestId: response.matchingRequestId || 0,
          parsed: response.parsed ? t('diagExecFound') : t('diagExecNotFound'),
          generating: response.generating ? t('diagGeneratingActive') : t('diagGeneratingIdle'),
          sources: response.sources?.join(', ') || t('diagNone'),
          parseError: response.parseError ? t('diagParseError', { error: response.parseError }) : '',
        }),
      });
    }
  }
  async stop() {
    this.stopRequested = true;
    this.mcpBridge.cancel();
    this.conversations.invalidate();
    this.runner.stop();
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve(false);
    }
    if (this.agent) await this.agent.stop();
    if (this.browser && !this.agent?.running) await this.browser.stop();
    this.post({ type: 'status', text: t('statusStopRequested') });
  }
  async start(message) {
    if (this.currentRun || this.switchingBrowser) throw new Error(t('errTaskOrBrowserSwitchActive'));
    const job = this.runTask(message);
    this.currentRun = job;
    try {
      return await job;
    } finally {
      if (this.currentRun === job) this.currentRun = null;
    }
  }
  async runTask(message) {
    if (this.starting || this.sessionSwitching || this.agent?.running)
      throw new Error(t('errTaskOrSessionSwitchActive'));
    this.starting = true;
    this.taskId = crypto.randomUUID();
    this.conversations.invalidate();
    this.stopRequested = false;
    this.executionPolicy = {
      autoApprove: message.autoApprove === true,
      review: Boolean(message.review),
      unlimitedRounds: message.unlimitedRounds === true,
    };
    this.post({ type: 'busy', policy: this.executionPolicy });
    let errorMessage;
    try {
      const folder = message.editorTarget
        ? this.editorActions.folder(message.editorTarget)
        : await this.rootFolder();
      const targetStore = message.editorTarget ? await this.workspaceStore(folder) : null;
      if (message.editorTarget) await this.editorActions.context(message.editorTarget, targetStore);
      const browser = await this.ensureBrowser();
      if (this.stopRequested) throw new Error(t('errTaskStopped'));
      const store = targetStore || (await this.workspaceStore(folder));
      this.workspaceInfo = { name: folder.name, path: store.root };
      this.post({ type: 'workspace', ...this.workspaceInfo });
      const contextFiles = [];
      const uploadPaths = [];
      if (message.editorTarget)
        contextFiles.push(await this.editorActions.context(message.editorTarget, store));
      const editor = vscode.window.activeTextEditor;
      if (message.includeEditor && editor && editor.document.uri.scheme === 'file') {
        const relative = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/');
        try {
          const file = await store.readFile(relative);
          const selection = editor.selection.isEmpty
            ? file.content
            : editor.document.getText(editor.selection);
          if (!editor.selection.isEmpty || selection.length > 10000) {
            store.ledger.delete(file.path);
            store.editReads.delete(file.path);
          }
          if (selection.length <= 10000)
            contextFiles.push({
              path: file.path,
              hash: file.hash,
              selectionOnly: !editor.selection.isEmpty,
              content: selection,
            });
          else
            this.post({
              type: 'message',
              role: 'system',
              text: t('msgLargeOpenFileOmitted'),
            });
        } catch {
          /* Outside-root or ignored files are not attached. */
        }
      }
      for (const relative of message.editorTarget ? [] : this.attachments) {
        if (attachmentKind(relative)) {
          const target = path.isAbsolute(relative) ? relative : (await store.resolve(relative)).target;
          uploadPaths.push(target);
          continue;
        }
        if (contextFiles.some((file) => file.path === relative && !file.selectionOnly)) continue;
        const file = await store.readFile(relative);
        if (file.content.length > 10000) {
          store.ledger.delete(file.path);
          store.editReads.delete(file.path);
          contextFiles.push({ path: relative, omitted: t('omittedLargeFileNote') });
        } else contextFiles.push(file);
      }
      if (JSON.stringify(contextFiles).length > 24000) throw new Error(t('errAttachmentContextTooLarge'));
      const prepared = await prepareAttachments(uploadPaths, {
        maxFileBytes: this.config().get('attachmentMaxFileSizeMB', 64) * 1024 * 1024,
        maxTotalBytes: this.config().get('attachmentMaxTotalSizeMB', 100) * 1024 * 1024,
        cancelled: () => this.stopRequested,
        onStatus: (text) => this.post({ type: 'status', text }),
      });
      const { task, mode, intent } = resolveTask(message.task);
      const autoApprove = message.autoApprove === true;
      const unlimitedRounds = message.unlimitedRounds === true;
      if (this.stopRequested) throw new Error(t('errTaskStopped'));
      this.saveSession();
      if (browser.waitForComposer && browser.context) {
        browser.cancelled = false;
        await browser.waitForComposer((text) => this.post({ type: 'status', text }));
        if (this.stopRequested) throw new Error(t('errTaskStopped'));
        await this.conversations.prepareWeb();
        const snapshot = await browser.readConversation();
        if (!this.webUrl || snapshot.url === this.webUrl) {
          this.events = mergeHistory(this.events, snapshot.messages);
          if (snapshot.restorable) this.webUrl = snapshot.url;
          this.saveSession();
          this.view?.webview.postMessage(this.state());
        }
      }
      if (this.stopRequested) throw new Error(t('errTaskStopped'));
      if (message.editorTarget) {
        contextFiles[0] = await this.editorActions.context(message.editorTarget, store);
      }
      const mcp = this.mcpBridge.createSession(store.root, mode);
      this.executionPolicy.mcpRequiresApproval = Boolean(mcp);
      this.post({ type: 'busy', policy: this.executionPolicy });
      this.agent = new CodingAgent({
        mcp,
        store,
        transport: browser,
        emit: (event) => this.post(event),
        mode,
        intent,
        autoApprove,
        unlimitedRounds,
        conversation: this.events.filter(
          (event) => event.type === 'message' && ['user', 'assistant'].includes(event.role),
        ),
        maxRounds: this.config().get('maxRounds'),
        maxPromptCharacters: this.config().get('maxPromptCharacters'),
        initialPaths: message.editorTarget ? [contextFiles[0].path] : undefined,
        attachments: prepared.uploads,
        attachmentContext: prepared.context,
        runCommand: (command) => this.runCommand(command, folder.uri.fsPath, autoApprove),
        approveAndApply: (changes, summary) =>
          this.stageAndApply(store, changes, summary, Boolean(message.review), autoApprove),
      });
      await this.agent.run(task, JSON.stringify(contextFiles));
    } catch (error) {
      errorMessage = error.message;
      this.post({ type: 'message', role: 'system', text: error.message });
    } finally {
      this.starting = false;
      this.executionPolicy = null;
      this.mcpBridge.active?.dispose();
      this.post({ type: 'idle' });
      this.post({
        type: 'runResult',
        clientRequestId: message.clientRequestId,
        task: message.task,
        success: !errorMessage,
      });
      this.post({
        type: 'status',
        text: errorMessage || t('statusCompletedNextRequest'),
        error: Boolean(errorMessage),
      });
    }
  }
  async runCommand(command, root, autoApprove = false) {
    return this.changes.runCommand(command, root, autoApprove === true);
  }
  async stageAndApply(store, changes, summary, review, autoApprove = false) {
    return this.changes.stageAndApply(store, changes, summary, review, autoApprove === true);
  }
  async undo() {
    return this.changes.undo();
  }
  async handle(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') {
      this.view.webview.postMessage(this.state());
      return;
    }
    if (message.type === 'selectLanguage') return this.changeLanguage(message.language, true);
    if (message.type === 'showBrowser') return this.showBrowser();
    if (message.type === 'editorBrowser') return this.switchBrowserView('editor');
    if (message.type === 'syncWeb') return this.syncWeb();
    if (message.type === 'refreshModels') return this.refreshModels();
    if (message.type === 'selectModel') return this.chooseModel(message.id);
    if (message.type === 'copyCode') return this.copyText(message, this.view?.webview);
    if (message.type === 'openResponse') return this.responsePanel.show(message);
    if (message.type === 'openLink' && typeof message.url === 'string' && /^https?:\/\//i.test(message.url))
      return vscode.env.openExternal(vscode.Uri.parse(message.url));
    if (message.type === 'checkWorkspace') return this.checkWorkspace();
    if (message.type === 'history') return this.showHistory();
    if (message.type === 'listSessions') return this.conversations.publishList();
    if (message.type === 'openSession') return this.conversations.selectSession(message.id);
    if (message.type === 'renameSession') return this.conversations.manageSession('rename', message.id);
    if (message.type === 'deleteSession') return this.conversations.manageSession('delete', message.id);
    if (message.type === 'deleteAllSessions') return this.conversations.manageSession('deleteAll');
    if (message.type === 'attach') return this.attachFiles();
    if (message.type === 'attachLocal') return this.attachLocalFiles();
    if (message.type === 'removeAttachment' && !this.starting) {
      this.attachments = this.attachments.filter((file) => file !== message.path);
      this.view.webview.postMessage({ type: 'attachments', files: this.attachments });
      return;
    }
    if (message.type === 'undo') return this.undo();
    if (message.type === 'connect') return this.connect();
    if (message.type === 'newChat') return this.newChat();
    if (message.type === 'diagnostics') return this.diagnostics();
    if (message.type === 'mcpTools') return this.mcpBridge.select();
    if (message.type === 'run') return this.start({ ...message, editorTarget: undefined });
    if (message.type === 'stop') return this.stop();
    if (message.type === 'apply' || message.type === 'reject') {
      if (this.pending?.kind === 'changes' && message.token === this.pending.viewData.token) {
        const pending = this.pending;
        this.pending = null;
        pending.resolve(message.type === 'apply');
      }
      return;
    }
    if (message.type === 'approveCommand' || message.type === 'rejectCommand') {
      if (this.pending?.kind === 'command' && message.token === this.pending.viewData.token) {
        const pending = this.pending;
        this.pending = null;
        pending.resolve(message.type === 'approveCommand');
      }
      return;
    }
    if (message.type === 'preview') {
      if (typeof message.id !== 'string' || !this.previews.has(message.id + '-new')) return;
      const makeUri = (suffix) =>
        vscode.Uri.from({ scheme: 'm365-agent-preview', path: '/' + message.id + suffix });
      return vscode.commands.executeCommand(
        'vscode.diff',
        makeUri('-old'),
        makeUri('-new'),
        t('diffPreviewTitle'),
      );
    }
  }
  async copyText(message, target) {
    if (typeof message.text !== 'string' || message.text.length > 1024 * 1024) return;
    let success = false;
    try {
      await vscode.env.clipboard.writeText(message.text);
      success = true;
    } catch {
      /* Reply to the originating view without losing the conversation. */
    }
    target?.postMessage({ type: 'copyResult', id: message.id, success });
  }
  async dispose() {
    clearInterval(this.syncTimer);
    this.responsePanel.dispose();
    this.browserPanel.dispose();
    await this.stop();
    await this.currentRun?.catch(() => {});
    if (this.browser) await this.browser.close();
    this.output.dispose();
  }
}

function activate(context) {
  const provider = new AgentView(context);
  const modelProvider = registerModelProvider(context, vscode);
  context.subscriptions.push(...provider.editorActions.register());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('m365Agent.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('m365-agent-preview', {
      provideTextDocumentContent: (uri) => provider.previews.get(uri.path.slice(1)) || '',
    }),
  );
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('m365Agent.language')) provider.syncLanguageFromConfig(true);
      }),
    );
  }
  const command = (name, fn) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, () =>
        Promise.resolve(fn()).catch((error) => vscode.window.showErrorMessage(error.message)),
      ),
    );
  command('m365Agent.open', async () => {
    // Restore only this extension's view/container, including saved pre-upgrade placements.
    await vscode.commands.executeCommand('m365Agent.chat.resetViewLocation');
    await vscode.commands.executeCommand('workbench.view.extension.m365Agent.resetViewContainerLocation');
    return vscode.commands.executeCommand('m365Agent.chat.focus');
  });
  command('m365Agent.connect', () => provider.connect());
  command('m365Agent.showBrowser', () => provider.showBrowser());
  command('m365Agent.editorBrowser', () => provider.switchBrowserView('editor'));
  command('m365Agent.newChat', () => provider.newChat());
  command('m365Agent.stop', () => provider.stop());
  command('m365Agent.diagnostics', () => provider.diagnostics());
  command('m365Agent.checkWorkspace', () => provider.checkWorkspace());
  command('m365Agent.syncWeb', () => provider.syncWeb());
  command('m365Agent.refreshModels', () => provider.refreshModels());
  command('m365Agent.mcpTools', () => provider.mcpBridge.select());
  command('m365Agent.selectLanguage', () => provider.selectLanguage());
  context.subscriptions.push({
    dispose: () => {
      provider.dispose().catch(() => {});
    },
  });
  return { provider, modelProvider };
}
module.exports = { activate };
