'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { digest } = require('./workspace');
const { requiresReview } = require('./policy');

class ChangeController {
  constructor(host, vscode) { this.host = host; this.vscode = vscode; }
  async runCommand(command, root, autoApprove = false) {
    const host = this.host;
    if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\0\r\n]/.test(command)) throw new Error('명령 형식이 올바르지 않습니다.');
    if (host.stopRequested) throw new Error('작업을 중지했습니다.');
    const approved = autoApprove === true || await new Promise(resolve => {
      const changedFiles = [...host.changedFiles.values()].filter(file => path.resolve(file.root).toLowerCase() === path.resolve(root).toLowerCase()).map(file => ({ path: file.path, id: host.previews.has(file.id + '-new') ? file.id : null, sensitive: requiresReview(file.path), currentTask: file.taskId === host.taskId }));
      const viewData = { type: 'commandApproval', command, root, changedFiles, token: crypto.randomUUID() };
      host.pending = { kind: 'command', resolve, viewData };
      host.post(viewData);
    });
    if (autoApprove !== true) { host.pending = null; host.post({ type: 'approvalClosed' }); }
    if (!approved || host.stopRequested) return { approved: false, message: '사용자가 실행을 거절했습니다. 다시 요청하지 마세요.' };
    if (autoApprove === true) host.post({ type: 'message', role: 'system', text: `승인 없이 진행 · 명령 실행\n${command}\n작업 폴더: ${root}` });
    host.output.appendLine(`\n> ${command}\n${root}`);
    host.output.show(true);
    host.runner.encoding = host.config().get('commandOutputEncoding', 'utf8');
    return host.runner.run(command, root, text => host.output.append(text));
  }
  async stageAndApply(store, changes, summary, review, autoApprove = false) {
    const host = this.host;
    const vscode = this.vscode;
    const forcedReview = autoApprove === true ? [] : changes.filter(change => requiresReview(change.path)).map(change => change.path);
    review = autoApprove !== true && (review || forcedReview.length > 0);
    for (const change of changes) {
      const id = crypto.randomUUID();
      change.previewId = id;
      host.previews.set(id + '-old', change.original);
      host.previews.set(id + '-new', change.content);
      if (host.previews.size > 200) host.previews.delete(host.previews.keys().next().value);
    }
    const viewData = { type: 'changes', summary, files: changes.map(change => ({ path: change.path, action: change.action, id: change.previewId })), review, autoApproved: autoApprove === true, forcedReview, token: crypto.randomUUID() };
    if (review) {
      host.post({ type: 'status', text: `파일 ${changes.length}개 변경 승인 대기 · diff를 확인하고 적용을 누르세요.` });
      const approved = await new Promise(resolve => { host.pending = { kind: 'changes', resolve, changes, viewData }; host.post(viewData); });
      host.pending = null;
      host.post({ type: 'reviewClosed' });
      if (!approved || host.stopRequested || host.agent?.cancelled) return false;
    } else host.post(viewData);
    if (host.stopRequested || host.agent?.cancelled) return false;
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
    if (host.stopRequested || host.agent?.cancelled) return false;
    if (!await vscode.workspace.applyEdit(edit, { isRefactoring: false })) throw new Error('VS Code가 변경 적용을 거부했습니다. 편집기에서 파일 상태를 확인하세요.');
    host.checkpoints.push({ store, changes });
    for (const change of changes) { change.taskId = host.taskId; host.changedFiles.set(store.root.toLowerCase() + '\0' + change.path.toLowerCase(), { root: store.root, path: change.path, id: change.previewId, taskId: host.taskId }); }
    host.checkpoints = host.checkpoints.slice(-20);
    host.post({ type: 'undoState', available: true });
    const failed = [];
    for (const [index, uri] of documents.entries()) {
      const document = await vscode.workspace.openTextDocument(uri);
      if (!await document.save()) failed.push(path.basename(uri.fsPath));
      changes[index].appliedHash = digest(document.getText());
      changes[index].diskHash = await fs.readFile(uri.fsPath, 'utf8').then(digest).catch(() => null);
    }
    if (failed.length) throw new Error(`편집기에 적용했지만 저장하지 못한 파일이 있습니다: ${failed.join(', ')}. 직접 확인하세요.`);
    host.post({ type: 'message', role: 'system', text: `${autoApprove === true ? '승인 없이 진행 · ' : ''}${changes.length}개 파일을 적용하고 저장했습니다. 테스트는 실행하지 않았습니다.` });
    host.post({ type: 'applied' });
    return true;
  }
  async undo() {
    const host = this.host;
    const vscode = this.vscode;
    if (host.starting || host.agent?.running) throw new Error('작업 완료 후 되돌릴 수 있습니다.');
    const checkpoint = host.checkpoints.at(-1);
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
    host.checkpoints.pop();
    for (const change of checkpoint.changes) {
      const key = checkpoint.store.root.toLowerCase() + '\0' + change.path.toLowerCase();
      const previous = [...host.checkpoints].reverse().filter(item => item.store.root === checkpoint.store.root).flatMap(item => item.changes).find(item => item.path === change.path);
      if (previous) host.changedFiles.set(key, { root: checkpoint.store.root, path: previous.path, id: previous.previewId, taskId: previous.taskId });
      else host.changedFiles.delete(key);
    }
    for (const uri of saves) if (!await (await vscode.workspace.openTextDocument(uri)).save()) throw new Error('되돌린 내용을 저장하지 못했습니다. 편집기를 확인하세요.');
    host.post({ type: 'message', role: 'system', text: '마지막 파일 변경을 되돌렸습니다. 터미널에서 발생한 변경은 포함하지 않습니다.' });
    host.post({ type: 'undoState', available: host.checkpoints.length > 0 });
  }
}
module.exports = { ChangeController };
