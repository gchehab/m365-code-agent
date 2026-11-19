'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EditorActions, diagnosticKey } = require('../src/editor-actions');
const { WorkspaceStore } = require('../src/workspace');
const { resolveTask } = require('../src/task');
const { buildPrompt } = require('../src/protocol');

class Range {
  constructor(start, end, endLine, endCharacter) {
    this.start = typeof start === 'number' ? { line: start, character: end } : { ...start };
    this.end = typeof start === 'number' ? { line: endLine, character: endCharacter } : { ...end };
  }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
  intersection(other) {
    const compare = (a, b) => a.line - b.line || a.character - b.character;
    const start = compare(this.start, other.start) > 0 ? this.start : other.start;
    const end = compare(this.end, other.end) < 0 ? this.end : other.end;
    return compare(start, end) <= 0 ? new Range(start, end) : undefined;
  }
}
class Kind {
  constructor(value) { this.value = value; }
  append(value) { return new Kind(this.value + '.' + value); }
  contains(other) { return other.value === this.value || other.value.startsWith(this.value + '.'); }
}
async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'm365-editor-'));
  t.after(async () => { assert.equal(path.dirname(root), temp); await fs.rm(root, { recursive: true, force: true }); });
  const uri = name => ({ scheme: 'file', fsPath: path.join(root, name), toString() { return 'file:///' + this.fsPath.replace(/\\/g, '/'); } });
  const source = 'const first = 1;\nconst broken = unknownName;\nconst last = 3;\n';
  await fs.writeFile(path.join(root, 'sample.js'), source);
  await fs.writeFile(path.join(root, 'other.js'), 'other content');
  const document = { uri: uri('sample.js'), version: 1, isClosed: false, isDirty: false, languageId: 'javascript', lineCount: 4,
    getText(range) { return range ? source.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : source; },
    offsetAt(position) { return source.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character; },
    validateRange(range) { return new Range(range.start, { line: range.end.line, character: Math.min(range.end.character, source.split('\n')[range.end.line].length) }); },
  };
  const editor = { document, selection: new Range(1, 6, 1, 12) };
  const diagnostics = [{ range: new Range(1, 15, 1, 26), message: 'Cannot find unknownName', severity: 0, source: 'test', code: 123 }];
  const folder = { uri: { scheme: 'file', fsPath: root }, name: 'fixture' };
  const started = [], contexts = [], focused = [], registered = new Map();
  const vscode = {
    Range, CodeActionKind: { QuickFix: new Kind('quickfix') }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
    Uri: { parse(value) { return [document.uri, uri('other.js')].find(item => item.toString() === value); } },
    workspace: { isTrusted: true, getWorkspaceFolder: value => value?.scheme === 'file' && value.fsPath.startsWith(root + path.sep) ? folder : undefined,
      async openTextDocument() { return document; } },
    window: { activeTextEditor: editor, visibleTextEditors: [editor], async showInputBox() { return '이름을 명확하게 바꿔줘.'; }, showErrorMessage() {} },
    commands: { async executeCommand(name) { focused.push(name); }, registerCommand(name, callback) { registered.set(name, callback); return { dispose() {} }; } },
    languages: { getDiagnostics: () => diagnostics, registerCodeActionsProvider(_selector, provider, metadata) { registered.set('provider', { provider, metadata }); return { dispose() {} }; } },
  };
  const store = await new WorkspaceStore(root).initialize();
  const host = { async workspaceStore() { return store; }, async start(message) { started.push(message); contexts.push(await actions.context(message.editorTarget, store)); } };
  const actions = new EditorActions(host, vscode);
  return { root, actions, vscode, host, started, contexts, focused, editor, document, diagnostics, store, registered };
}

test('selection commands capture exact code, keep explain/review read-only and default edits to review', async t => {
  const f = await fixture(t);
  for (const [action, mode] of [['explain', 'ask'], ['review', 'ask'], ['edit', 'agent']]) {
    await f.actions.selection(action);
    const request = f.started.at(-1), context = f.contexts.at(-1);
    assert.equal(resolveTask(request.task).mode, mode);
    if (action === 'review') assert.equal(resolveTask(request.task).intent, 'review');
    assert.equal(context.content, 'broken');
    assert.equal(context.path, 'sample.js');
    assert.deepEqual(context.range, { startLine: 2, startColumn: 7, endLine: 2, endColumn: 13 });
    assert.equal(request.review, true);
    assert.equal(request.autoApprove, false);
    assert.equal(request.unlimitedRounds, false);
  }
  assert.equal(f.store.ledger.size, 0);
  assert.equal(f.store.editReads.size, 0);
  f.vscode.window.visibleTextEditors.unshift({ document: f.document, selection: new Range(0, 0, 0, 5) });
  await f.actions.selection('explain', f.document.uri);
  assert.equal(f.contexts.at(-1).content, 'broken', 'split editors of the same file use the active selection');
});

test('edit input cancellation, focus changes, stale versions and explicitly read-only instructions are respected', async t => {
  const f = await fixture(t);
  f.vscode.window.showInputBox = async () => undefined;
  await f.actions.selection('edit');
  assert.equal(f.started.length, 0);
  f.vscode.window.showInputBox = async () => {
    f.vscode.window.activeTextEditor = { document: { ...f.document, uri: { scheme: 'file', fsPath: path.join(f.root, 'other.js') } }, selection: new Range(0, 0, 0, 5) };
    return '수정하지 말고 원인을 설명해줘.';
  };
  await f.actions.selection('edit');
  assert.equal(f.contexts.at(-1).path, 'sample.js');
  assert.equal(resolveTask(f.started.at(-1).task).mode, 'ask');
  f.vscode.window.activeTextEditor = f.editor;
  f.vscode.window.showInputBox = async () => { f.document.version++; return '이름을 바꿔줘.'; };
  await assert.rejects(f.actions.selection('edit'), /변경/);
  assert.equal(f.started.length, 1);
});

test('busy, untrusted, excluded and dirty edit targets never start a request', async t => {
  const f = await fixture(t);
  f.host.starting = true;
  await assert.rejects(f.actions.selection('explain'), /진행 중/);
  f.host.starting = false;
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.actions.selection('explain'), /신뢰/);
  f.vscode.workspace.isTrusted = true;
  f.document.isDirty = true;
  await assert.rejects(f.actions.selection('edit'), /저장/);
  await f.actions.selection('explain');
  f.document.isDirty = false;
  await fs.writeFile(path.join(f.root, '.env'), 'secret');
  f.document.uri.fsPath = path.join(f.root, '.env');
  await assert.rejects(f.actions.selection('explain'), /제외/);
  assert.equal(f.started.length, 1);
});

test('quick fixes are cheap diagnostic-scoped commands with no eager edits or preferred auto-fix', async t => {
  const f = await fixture(t);
  f.actions.register();
  assert.ok(f.registered.has('m365Agent.explainSelection'));
  assert.equal(f.registered.get('provider').metadata.providedCodeActionKinds[0].value, 'quickfix.m365Agent');
  const context = { diagnostics: [...f.diagnostics,
    { ...f.diagnostics[0], severity: 1 }, { ...f.diagnostics[0], severity: 2 },
    { ...f.diagnostics[0], range: new Range(3, 0, 3, 0) }] };
  const actions = f.actions.provideCodeActions(f.document, new Range(1, 18, 1, 18), context, { isCancellationRequested: false });
  assert.equal(actions.length, 2);
  assert.equal(actions[0].command.command, 'm365Agent.fixDiagnostic');
  assert.equal(actions[0].edit, undefined);
  assert.equal(actions[0].isPreferred, undefined);
  assert.equal(f.started.length, 0);
  assert.equal(f.actions.provideCodeActions(f.document, f.editor.selection, { ...context, only: new Kind('source') }, { isCancellationRequested: false }).length, 0);
  assert.equal(f.actions.provideCodeActions(f.document, f.editor.selection, context, { isCancellationRequested: true }).length, 0);
});

test('diagnostic execution forwards real diagnostics and rejects stale or resolved targets', async t => {
  const f = await fixture(t);
  const argument = { uri: f.document.uri.toString(), version: f.document.version, key: diagnosticKey(f.diagnostics[0]) };
  await f.actions.fixDiagnostic(argument);
  assert.equal(resolveTask(f.started[0].task).mode, 'agent');
  const context = f.contexts[0];
  assert.match(context.content, /unknownName/);
  assert.equal(context.diagnostics[0].message, f.diagnostics[0].message);
  assert.equal(context.diagnostics[0].startLine, 2);
  const originalMessage = f.diagnostics[0].message;
  f.diagnostics[0].message = 'A changed diagnostic from the same provider';
  await assert.rejects(f.actions.context(f.started[0].editorTarget, f.store), /진단/);
  f.diagnostics[0].message = originalMessage;
  f.document.version++;
  await assert.rejects(f.actions.fixDiagnostic(argument), /変更|변경/);
  f.document.version--;
  f.diagnostics.length = 0;
  await assert.rejects(f.actions.fixDiagnostic(argument), /진단/);
  assert.equal(f.started.length, 1);
});

test('context reduction retains the selected range and diagnostic instead of turning a quick fix into a generic request', () => {
  const range = { startLine: 241, startColumn: 7, endLine: 242, endColumn: 10 };
  const prompt = buildPrompt({ id: 'diagnostic-budget', task: '선택한 오류를 수정해줘.', workspace: 'fixture',
    extraContext: [{ path: 'sample.js', range, content: 'x'.repeat(12000),
      diagnostics: [{ message: 'Unknown variable', severity: 0, startLine: 241, startColumn: 7 }] }], maxCharacters: 5000 });
  const context = JSON.parse(prompt.split('DATA: ')[1]).context[0];
  assert.deepEqual(context.range, range);
  assert.equal(context.diagnostics[0].message, 'Unknown variable');
  assert.equal(context.content, undefined);
  assert.ok(context.omitted);
});
