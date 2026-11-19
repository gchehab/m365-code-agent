// @ts-check
'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { resolveTask } = require('./task');
const { t } = require('./i18n');
/** @typedef {import('vscode').TextDocument} TextDocument */
/** @typedef {{document: TextDocument, version: number, range: import('vscode').Range, diagnostic?: import('vscode').Diagnostic, diagnosticId?: string}} EditorTarget */
/** @typedef {{starting?: boolean, switchingBrowser?: boolean, sessionSwitching?: boolean, currentRun?: unknown, agent?: {running: boolean} | null, workspaceStore(folder: import('vscode').WorkspaceFolder): Promise<import('./workspace').WorkspaceStore>, start(message: Record<string, unknown>): Promise<void>}} EditorHost */

/** @param {import('vscode').Diagnostic} diagnostic */
function diagnosticKey(diagnostic) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        message: diagnostic.message,
        severity: diagnostic.severity,
        source: diagnostic.source,
        code: typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
        range: diagnostic.range,
      }),
    )
    .digest('hex');
}

class EditorActions {
  /** @param {EditorHost} host @param {typeof import('vscode')} vscode */
  constructor(host, vscode) {
    this.host = host;
    this.vscode = vscode;
    this.preparing = false;
  }
  assertIdle() {
    if (
      this.host.starting ||
      this.host.currentRun ||
      this.host.switchingBrowser ||
      this.host.sessionSwitching ||
      this.host.agent?.running
    )
      throw new Error(t('errRunEditorActionAfterTask'));
  }
  /** @param {EditorTarget} target */
  folder(target) {
    if (!this.vscode.workspace.isTrusted) throw new Error(t('errTrustedWorkspaceOnly'));
    const document = target.document;
    if (document.isClosed || document.version !== target.version)
      throw new Error(t('errTargetCodeChanged'));
    const folder = this.vscode.workspace.getWorkspaceFolder(document.uri);
    if (document.uri.scheme !== 'file' || !folder || folder.uri.scheme !== 'file')
      throw new Error(t('errRunInLocalProjectFile'));
    return folder;
  }
  /** @param {EditorTarget} target @param {import('./workspace').WorkspaceStore} store */
  async context(target, store) {
    this.folder(target);
    const document = target.document;
    const relative = path.relative(store.root, document.uri.fsPath).replace(/\\/g, '/');
    await store.resolve(relative);
    this.folder(target);
    const diagnostic = target.diagnostic;
    if (
      diagnostic &&
      (diagnosticKey(diagnostic) !== target.diagnosticId ||
        !this.vscode.languages
          .getDiagnostics(document.uri)
          .some((item) => diagnosticKey(item) === target.diagnosticId))
    )
      throw new Error(t('errDiagnosticChangedOrGone'));
    const range = target.range;
    const size = document.offsetAt(range.end) - document.offsetAt(range.start);
    return {
      path: relative,
      language: document.languageId,
      selectionOnly: true,
      range: {
        startLine: range.start.line + 1,
        startColumn: range.start.character + 1,
        endLine: range.end.line + 1,
        endColumn: range.end.character + 1,
      },
      ...(size <= 10000
        ? { content: document.getText(range) }
        : { omitted: t('omittedLargeSelectionNote') }),
      ...(diagnostic
        ? {
            diagnostics: [
              {
                message: diagnostic.message.slice(0, 2000),
                truncated: diagnostic.message.length > 2000,
                severity: diagnostic.severity,
                source: diagnostic.source?.slice(0, 200),
                code: String(
                  typeof diagnostic.code === 'object' ? diagnostic.code.value : (diagnostic.code ?? ''),
                ).slice(0, 200),
                startLine: diagnostic.range.start.line + 1,
                startColumn: diagnostic.range.start.character + 1,
                endLine: diagnostic.range.end.line + 1,
                endColumn: diagnostic.range.end.character + 1,
              },
            ],
          }
        : {}),
    };
  }
  /** @param {EditorTarget} target @param {string} task */
  async submit(target, task) {
    this.assertIdle();
    const folder = this.folder(target);
    if (resolveTask(task).mode === 'agent' && target.document.isDirty)
      throw new Error(t('errSaveFileBeforeEdit'));
    await this.context(target, await this.host.workspaceStore(folder));
    await this.vscode.commands.executeCommand('m365Agent.chat.focus');
    this.assertIdle();
    await this.host.start({
      task,
      editorTarget: target,
      includeEditor: false,
      review: true,
      autoApprove: false,
      unlimitedRounds: false,
    });
  }
  /** @param {'explain' | 'review' | 'edit'} action @param {import('vscode').Uri} [resource] */
  async selection(action, resource) {
    this.assertIdle();
    if (this.preparing) throw new Error(t('errPreparingAnotherEditorAction'));
    const active = this.vscode.window.activeTextEditor;
    const editor =
      resource && active?.document.uri.toString() !== resource.toString()
        ? this.vscode.window.visibleTextEditors.find(
            (item) => item.document.uri.toString() === resource.toString(),
          )
        : active;
    if (!editor || editor.selection.isEmpty) throw new Error(t('errSelectCodeFirst'));
    /** @type {EditorTarget} */
    const target = {
      document: editor.document,
      version: editor.document.version,
      range: new this.vscode.Range(editor.selection.start, editor.selection.end),
    };
    const folder = this.folder(target);
    const relative = path.relative(folder.uri.fsPath, target.document.uri.fsPath).replace(/\\/g, '/');
    const label = t('selectionLabel', {
      path: relative,
      startLine: target.range.start.line + 1,
      startColumn: target.range.start.character + 1,
      endLine: target.range.end.line + 1,
      endColumn: target.range.end.character + 1,
    });
    this.preparing = true;
    try {
      let task;
      if (action === 'edit') {
        const instruction = await this.vscode.window.showInputBox({
          title: t('editSelectionTitle'),
          prompt: t('editSelectionPrompt'),
          placeHolder: t('editSelectionPlaceholder'),
          validateInput: (value) =>
            value.trim().length > 6000 ? t('errEditInstructionMax6000') : undefined,
        });
        if (!instruction?.trim()) return;
        const parsed = resolveTask(instruction.trim());
        const prefix =
          parsed.intent === 'review'
            ? '/review'
            : parsed.mode === 'ask'
              ? '/ask'
              : parsed.mode === 'plan'
                ? '/plan'
                : '/agent';
        task = `${prefix} ${label}: ${parsed.task}`;
      } else
        task =
          action === 'explain'
            ? t('taskExplainSelection', { label })
            : t('taskReviewSelection', { label });
      await this.submit(target, task);
    } finally {
      this.preparing = false;
    }
  }
  /** @param {unknown} argument */
  async fixDiagnostic(argument) {
    this.assertIdle();
    if (this.preparing) throw new Error(t('errPreparingAnotherEditorAction'));
    if (!this.vscode.workspace.isTrusted) throw new Error(t('errTrustedWorkspaceOnly'));
    if (
      !argument ||
      typeof argument !== 'object' ||
      !('uri' in argument) ||
      !('version' in argument) ||
      !('key' in argument) ||
      typeof argument.uri !== 'string' ||
      typeof argument.version !== 'number' ||
      typeof argument.key !== 'string'
    )
      throw new Error(t('errSelectDiagnosticFromLightbulb'));
    const uri = this.vscode.Uri.parse(argument.uri);
    if (uri.scheme !== 'file' || !this.vscode.workspace.getWorkspaceFolder(uri))
      throw new Error(t('errRunInLocalProjectFile'));
    const document = await this.vscode.workspace.openTextDocument(uri);
    const diagnostic = this.vscode.languages
      .getDiagnostics(uri)
      .find((item) => diagnosticKey(item) === argument.key);
    if (!diagnostic || diagnostic.severity > this.vscode.DiagnosticSeverity.Warning)
      throw new Error(t('errDiagnosticChangedOrGone'));
    const range = new this.vscode.Range(
      Math.max(0, diagnostic.range.start.line - 4),
      0,
      Math.min(
        document.lineCount - 1,
        Math.min(diagnostic.range.end.line + 4, diagnostic.range.start.line + 115),
      ),
      Number.MAX_SAFE_INTEGER,
    );
    const target = {
      document,
      version: argument.version,
      range: document.validateRange(range),
      diagnostic,
      diagnosticId: argument.key,
    };
    const folder = this.folder(target);
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    await this.submit(target, t('taskFixDiagnostic', { path: relative }));
  }
  /** @param {TextDocument} document @param {import('vscode').Range} range @param {import('vscode').CodeActionContext} context @param {import('vscode').CancellationToken} token */
  provideCodeActions(document, range, context, token) {
    const kind = this.vscode.CodeActionKind.QuickFix.append('m365Agent');
    if (
      token.isCancellationRequested ||
      !this.vscode.workspace.isTrusted ||
      document.uri.scheme !== 'file' ||
      !this.vscode.workspace.getWorkspaceFolder(document.uri) ||
      (context.only && !context.only.contains(kind))
    )
      return [];
    return context.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.severity <= this.vscode.DiagnosticSeverity.Warning &&
          diagnostic.range.intersection(range),
      )
      .slice(0, 5)
      .map((diagnostic) => {
        const action = new this.vscode.CodeAction(
          t('codeActionFixTitle', { message: diagnostic.message.replace(/\s+/g, ' ').slice(0, 80) }),
          kind,
        );
        action.diagnostics = [diagnostic];
        action.command = {
          command: 'm365Agent.fixDiagnostic',
          title: action.title,
          arguments: [
            { uri: document.uri.toString(), version: document.version, key: diagnosticKey(diagnostic) },
          ],
        };
        return action;
      });
  }
  register() {
    /** @param {() => Promise<void>} job */
    const handle = async (job) => {
      try {
        await job();
      } catch (error) {
        void this.vscode.window.showErrorMessage(error.message);
      }
    };
    return [
      .../** @type {const} */ (['explain', 'review', 'edit']).map((action) =>
        this.vscode.commands.registerCommand(`m365Agent.${action}Selection`, (resource) =>
          handle(() => this.selection(action, resource)),
        ),
      ),
      this.vscode.commands.registerCommand('m365Agent.fixDiagnostic', (argument) =>
        handle(() => this.fixDiagnostic(argument)),
      ),
      this.vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, this, {
        providedCodeActionKinds: [this.vscode.CodeActionKind.QuickFix.append('m365Agent')],
      }),
    ];
  }
}
module.exports = { EditorActions, diagnosticKey };
