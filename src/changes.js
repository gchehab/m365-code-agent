// @ts-check
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { digest } = require('./workspace');
const { requiresReview } = require('./policy');
const { t } = require('./i18n');
/** @typedef {import('../types/contracts').PreparedChange} PreparedChange */
/** @typedef {import('./workspace').WorkspaceStore} WorkspaceStore */
/** @param {string} target */
async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

class ChangeController {
  /** @param {import('../types/contracts').ChangeHost} host @param {typeof import('vscode')} vscode */
  constructor(host, vscode) {
    this.host = host;
    this.vscode = vscode;
  }
  /** @param {PreparedChange[]} changes */
  assertNoDirtyDeletions(changes) {
    for (const change of changes.filter((change) => change.action === 'delete')) {
      const target = path.resolve(change.target).toLowerCase();
      if (
        (this.vscode.workspace?.textDocuments || []).some((document) => {
          const filename =
            document.uri.scheme === 'file' ? path.resolve(document.uri.fsPath).toLowerCase() : '';
          return (
            document.isDirty &&
            (filename === target || (change.directory && filename.startsWith(target + path.sep)))
          );
        })
      )
        throw new Error(t('errDirtyFileDeleteOrRestore', { path: change.path }));
    }
  }
  /** @param {WorkspaceStore} store @param {PreparedChange[]} changes */
  recordCheckpoint(store, changes) {
    const host = this.host;
    host.checkpoints.push({ store, changes });
    for (const change of changes) {
      change.taskId = host.taskId;
      host.changedFiles.set(store.root.toLowerCase() + '\0' + change.path.toLowerCase(), {
        root: store.root,
        path: change.path,
        action: change.action,
        id: change.previewId,
        taskId: host.taskId,
      });
    }
    host.checkpoints = host.checkpoints.slice(-20);
    host.post({ type: 'undoState', available: true });
  }
  /** @param {WorkspaceStore} store @param {PreparedChange[]} changes */
  async preservePartialDeletes(store, changes) {
    /** @type {PreparedChange[]} */
    const missing = [];
    for (const change of changes.filter((change) => change.action === 'delete')) {
      try {
        await store.resolve(change.path, true);
        if (!(await exists(change.target))) missing.push(change);
        else if (change.directory) {
          const stat = await fs.stat(change.target);
          if (
            !stat.isDirectory() ||
            `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== change.directorySnapshot.identity
          ) {
            missing.push(change);
            continue;
          }
          const files = [],
            directories = [];
          for (const file of change.directorySnapshot.files) {
            const resolved = await store.resolve(file.path, true);
            if (!(await exists(resolved.target))) files.push(file);
          }
          for (const name of change.directorySnapshot.directories) {
            const resolved = await store.resolve(name, true);
            if (!(await exists(resolved.target))) directories.push(name);
          }
          if (files.length || directories.length)
            missing.push({
              ...change,
              partialDirectory: true,
              directorySnapshot: { ...change.directorySnapshot, files, directories },
            });
        }
      } catch (error) {
        this.host.output?.appendLine(
          t('logDeleteCheckFailed', { path: change.path, message: error.message }),
        );
      }
    }
    if (missing.length) this.recordCheckpoint(store, missing);
    return missing.length;
  }
  /** @param {string} command @param {string} root */
  async runCommand(command, root, autoApprove = false) {
    const host = this.host;
    if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\0\r\n]/.test(command))
      throw new Error(t('errInvalidCommandFormat'));
    if (host.stopRequested) throw new Error(t('errTaskStopped'));
    const approved =
      autoApprove === true ||
      (await new Promise((resolve) => {
        const changedFiles = [...host.changedFiles.values()]
          .filter((file) => path.resolve(file.root).toLowerCase() === path.resolve(root).toLowerCase())
          .map((file) => ({
            path: file.path,
            action: file.action,
            id: host.previews.has(file.id + '-new') ? file.id : null,
            sensitive: requiresReview(file.path),
            currentTask: file.taskId === host.taskId,
          }));
        const viewData = { type: 'commandApproval', command, root, changedFiles, token: crypto.randomUUID() };
        host.pending = { kind: 'command', resolve, viewData };
        host.post(viewData);
      }));
    if (autoApprove !== true) {
      host.pending = null;
      host.post({ type: 'approvalClosed' });
    }
    if (!approved || host.stopRequested)
      return { approved: false, message: t('msgCommandRejectedByUser') };
    if (autoApprove === true)
      host.post({
        type: 'message',
        role: 'system',
        text: t('msgAutoApprovedCommand', { command, root }),
      });
    host.output.appendLine(`\n> ${command}\n${root}`);
    host.output.show(true);
    host.runner.encoding = host.config().get('commandOutputEncoding', 'utf8');
    return host.runner.run(command, root, (text) => host.output.append(text));
  }
  /** @param {WorkspaceStore} store @param {PreparedChange[]} changes @param {string} summary @param {boolean} review */
  async stageAndApply(store, changes, summary, review, autoApprove = false) {
    const host = this.host;
    const vscode = this.vscode;
    this.assertNoDirtyDeletions(changes);
    const forcedReview =
      autoApprove === true
        ? []
        : changes
            .filter((change) => change.action === 'delete' || requiresReview(change.path))
            .map((change) => change.path);
    review = autoApprove !== true && (review || forcedReview.length > 0);
    for (const change of changes) {
      const id = crypto.randomUUID();
      change.previewId = id;
      host.previews.set(id + '-old', change.original);
      host.previews.set(id + '-new', change.content);
      if (host.previews.size > 200) {
        const oldest = host.previews.keys().next().value;
        if (oldest !== undefined) host.previews.delete(oldest);
      }
    }
    const viewData = {
      type: 'changes',
      summary,
      files: changes.map((change) => ({
        path: change.path,
        action: change.action,
        id: change.previewId,
        binary: change.action === 'delete' && !change.directory ? change.binary : undefined,
        directory: change.directory === true,
        size:
          change.action === 'delete'
            ? change.directory
              ? change.directorySnapshot.size
              : change.originalBytes.length
            : undefined,
      })),
      review,
      autoApproved: autoApprove === true,
      forcedReview,
      token: crypto.randomUUID(),
    };
    if (review) {
      host.post({
        type: 'status',
        text: t('statusWaitingChangeApproval', { count: changes.length }),
      });
      const approved = await new Promise((resolve) => {
        host.pending = { kind: 'changes', resolve, changes, viewData };
        host.post(viewData);
      });
      host.pending = null;
      host.post({ type: 'reviewClosed' });
      if (!approved || host.stopRequested || host.agent?.cancelled) return false;
    } else host.post(viewData);
    if (host.stopRequested || host.agent?.cancelled) return false;
    await store.verifyChanges(changes, () => !!(host.stopRequested || host.agent?.cancelled));
    const edit = new vscode.WorkspaceEdit();
    const documents = [];
    /** @type {string[]} */
    const directoryDeletes = [];
    let hasFileEdits = false;
    for (const change of changes) {
      const uri = vscode.Uri.file(change.target);
      if (change.action === 'delete') {
        if (change.directory) {
          // Delete only the observed entries, then empty directories. A new,
          // unobserved child makes the directory removal fail instead of being lost.
          for (const file of change.directorySnapshot.files)
            edit.deleteFile(vscode.Uri.file((await store.resolve(file.path)).target), {
              recursive: false,
              ignoreIfNotExists: false,
            });
          directoryDeletes.push(...change.directorySnapshot.directories);
          hasFileEdits ||= change.directorySnapshot.files.length > 0;
        } else edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: false });
      } else if (change.action === 'create') {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(change.target)));
        edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), change.content);
      } else {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) throw new Error(t('errUnsavedChangesSaveFirst', { path: change.path }));
        if (digest(document.getText()) !== change.expectedHash)
          throw new Error(t('errFileModified', { path: change.path }));
        edit.replace(
          uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          change.content,
        );
      }
      if (!change.directory) hasFileEdits = true;
      documents.push({ uri, change });
    }
    await store.verifyChanges(changes, () => !!(host.stopRequested || host.agent?.cancelled));
    if (host.stopRequested || host.agent?.cancelled) return false;
    this.assertNoDirtyDeletions(changes);
    let applied, applyError;
    try {
      applied = !hasFileEdits || (await vscode.workspace.applyEdit(edit, { isRefactoring: false }));
      // VS Code prevalidates all deletions in a single edit. A parent must be
      // removed in a later edit, after its observed children are actually gone.
      for (const depth of [...new Set(directoryDeletes.map((name) => name.split('/').length))].sort(
        (a, b) => b - a,
      )) {
        if (!applied) break;
        if (host.stopRequested || host.agent?.cancelled) throw new Error(t('errTaskStopped'));
        this.assertNoDirtyDeletions(changes);
        const directoryEdit = new vscode.WorkspaceEdit();
        for (const name of directoryDeletes.filter((name) => name.split('/').length === depth))
          directoryEdit.deleteFile(vscode.Uri.file((await store.resolve(name)).target), {
            recursive: false,
            ignoreIfNotExists: false,
          });
        applied = await vscode.workspace.applyEdit(directoryEdit, { isRefactoring: false });
      }
    } catch (error) {
      applied = false;
      applyError = error;
    }
    if (!applied) {
      const partial = await this.preservePartialDeletes(store, changes);
      /** @type {Error & { code?: string }} */
      const error = new Error(
        partial ? t('errVscodeApplyFailedPartial', { partial }) : t('errVscodeApplyFailed'),
        { cause: applyError },
      );
      if (partial) error.code = 'PARTIAL_DELETE';
      throw error;
    }
    this.recordCheckpoint(store, changes);
    const failed = [];
    for (const { uri, change } of documents) {
      if (change.action === 'delete') {
        change.appliedHash = null;
        change.diskHash = null;
        if (await exists(change.target)) throw new Error(t('errDeleteNotConfirmed', { path: change.path }));
        continue;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (!(await document.save())) failed.push(path.basename(uri.fsPath));
      change.appliedHash = digest(document.getText());
      change.diskHash = await fs
        .readFile(uri.fsPath, 'utf8')
        .then(digest)
        .catch(() => null);
    }
    if (failed.length) throw new Error(t('errAppliedButSaveFailed', { files: failed.join(', ') }));
    const deleted = changes.filter((change) => change.action === 'delete').length;
    host.post({
      type: 'message',
      role: 'system',
      text: t('msgChangesApplied', {
        autoPrefix: autoApprove === true ? t('msgChangesAppliedAutoPrefix') : '',
        count: changes.length,
        deleteNote: deleted ? t('msgChangesAppliedDeleted', { deleted }) : t('msgChangesAppliedSaved'),
      }),
    });
    host.post({ type: 'applied' });
    return true;
  }
  async undo() {
    const host = this.host;
    const vscode = this.vscode;
    if (host.starting || host.agent?.running) throw new Error(t('errUndoAfterTask'));
    const checkpoint = host.checkpoints.at(-1);
    if (!checkpoint) return;
    const edit = new vscode.WorkspaceEdit();
    const saves = [];
    const restores = [];
    const restoreDirectories = [];
    let editNeeded = false;
    this.assertNoDirtyDeletions(checkpoint.changes);
    for (const change of checkpoint.changes) {
      await checkpoint.store.resolve(change.path, change.action === 'delete');
      const uri = vscode.Uri.file(change.target);
      if (change.action === 'delete') {
        if ((!change.directory || !change.partialDirectory) && (await exists(change.target)))
          throw new Error(t('errPathRecreatedAfterDelete', { path: change.path }));
        if (change.directory) {
          if (change.partialDirectory) {
            const stat = await fs.stat(change.target);
            if (
              !stat.isDirectory() ||
              `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== change.directorySnapshot.identity
            )
              throw new Error(t('errFolderChangedAfterPartialDelete', { path: change.path }));
          }
          for (const name of change.directorySnapshot.directories) {
            const resolved = await checkpoint.store.resolve(name, true);
            if (await exists(resolved.target))
              throw new Error(t('errPathRecreatedAfterDelete', { path: name }));
            restoreDirectories.push({ path: name, target: resolved.target });
          }
          for (const file of change.directorySnapshot.files) {
            const resolved = await checkpoint.store.resolve(file.path, true);
            if (await exists(resolved.target))
              throw new Error(t('errPathRecreatedAfterDelete', { path: file.path }));
            edit.createFile(vscode.Uri.file(resolved.target), {
              overwrite: false,
              ignoreIfExists: false,
              contents: file.bytes,
            });
            restores.push({ path: file.path, target: resolved.target });
            editNeeded = true;
          }
        } else {
          edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: change.originalBytes });
          restores.push(change);
          editNeeded = true;
        }
        continue;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (
        document.isDirty ||
        digest(document.getText()) !== change.appliedHash ||
        digest(await fs.readFile(change.target, 'utf8')) !== change.diskHash
      )
        throw new Error(t('errCannotUndoSubsequentEdits', { path: change.path }));
      if (change.action === 'create') edit.deleteFile(uri, { recursive: false });
      else {
        edit.replace(
          uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          change.original,
        );
        saves.push(uri);
      }
      editNeeded = true;
    }
    for (const directory of restoreDirectories.sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length,
    )) {
      await checkpoint.store.resolve(directory.path, true);
      if (await exists(directory.target))
        throw new Error(t('errPathRecreatedAfterDelete', { path: directory.path }));
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory.target));
      await checkpoint.store.resolve(directory.path);
    }
    for (const change of restores) {
      await checkpoint.store.resolve(change.path, true);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(change.target)));
      await checkpoint.store.resolve(change.path, true);
      if (await exists(change.target))
        throw new Error(t('errPathRecreatedAfterDelete', { path: change.path }));
    }
    this.assertNoDirtyDeletions(checkpoint.changes);
    if (editNeeded && !(await vscode.workspace.applyEdit(edit))) throw new Error(t('errUndoApplyFailed'));
    host.checkpoints.pop();
    for (const change of checkpoint.changes) {
      const key = checkpoint.store.root.toLowerCase() + '\0' + change.path.toLowerCase();
      const previous = [...host.checkpoints]
        .reverse()
        .filter((item) => item.store.root === checkpoint.store.root)
        .flatMap((item) => item.changes)
        .find((item) => item.path === change.path);
      if (previous)
        host.changedFiles.set(key, {
          root: checkpoint.store.root,
          path: previous.path,
          action: previous.action,
          id: previous.previewId,
          taskId: previous.taskId,
        });
      else host.changedFiles.delete(key);
    }
    for (const uri of saves)
      if (!(await (await vscode.workspace.openTextDocument(uri)).save()))
        throw new Error(t('errUndoSaveFailed'));
    host.post({
      type: 'message',
      role: 'system',
      text: t('msgUndoCompleted'),
    });
    host.post({ type: 'undoState', available: host.checkpoints.length > 0 });
  }
}
module.exports = { ChangeController };
