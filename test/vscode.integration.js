'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { digest } = require('../src/workspace');

async function run() {
  const extension = vscode.extensions.getExtension('jhoon-dev.m365-code-agent');
  assert.ok(extension, 'extension is loaded');
  const { provider } = await extension.activate();
  await vscode.commands.executeCommand('m365Agent.chat.focus');
  for (let tries = 0; !provider.view && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(provider.view, 'sidebar webview is created');
  assert.match(provider.view.webview.html, /Content-Security-Policy/);
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const original = 'exports.average = values => values.reduce((a,b)=>a+b,0)/values.length;\n';
  await fs.writeFile(path.join(root, 'src', 'average.js'), original);
  let round = 0;
  const updated = 'exports.average = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;\n';
  provider.browser = {
    async connect() {}, async stop() {}, async close() {},
    async request(prompt, requestId) {
      round++;
      if (round === 1) return { requestId, kind: 'tools', calls: [{ name: 'read_file', path: 'src/average.js' }] };
      if (round === 2) return { requestId, kind: 'changes', summary: '평균 함수 수정 및 테스트 생성', files: [
        { path: 'src/average.js', action: 'replace', baseHash: digest(original), content: updated },
        { path: 'test/average.test.js', action: 'create', baseHash: null, content: "const assert = require('node:assert/strict');\nconst {average} = require('../src/average');\nassert.equal(average([]), null);\nassert.equal(average([1,2,3]),2);\n" }
      ]};
      return { requestId, kind: 'done', message: '실제 VS Code 편집 적용 검증 완료.' };
    }
  };
  await provider.start({ task: '빈 배열의 평균은 null로 반환하고 회귀 테스트도 생성해줘.', includeEditor: false, review: false });
  assert.equal(await fs.readFile(path.join(root, 'src', 'average.js'), 'utf8'), updated);
  assert.match(await fs.readFile(path.join(root, 'test', 'average.test.js'), 'utf8'), /average\(\[\]\)/);
  assert.equal(round, 3);
  assert.equal(vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === path.join(root, 'src', 'average.js')).isDirty, false);

  // Unsaved edits must never be overwritten by a model proposal.
  const document = await vscode.workspace.openTextDocument(path.join(root, 'src', 'average.js'));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(0, 0), '// user unsaved edit\n');
  await vscode.workspace.applyEdit(edit);
  const current = document.getText();
  const store = await new (require('../src/workspace').WorkspaceStore)(root, async () => current).initialize();
  const file = await store.readFile('src/average.js');
  const changes = await store.prepareChanges([{ path: file.path, action: 'replace', baseHash: file.hash, content: 'bad overwrite' }]);
  await assert.rejects(provider.stageAndApply(store, changes, 'must reject', false), /저장하지 않은/);
  assert.equal(document.getText(), current);
  await document.save();
  const { chromium } = require(path.join(extension.extensionPath, 'node_modules', 'playwright-core'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<meta charset="utf-8"><textarea id="userInput"></textarea>');
    await page.locator('#userInput').fill('확장 호스트에서 Edge 자동 입력');
    assert.equal(await page.locator('#userInput').inputValue(), '확장 호스트에서 Edge 자동 입력');
  } finally { await browser.close(); }
  const report = { ok: true, checks: ['extension activation', 'sidebar webview', 'file read', 'existing-file modification', 'nested new-file creation', 'save to disk', 'dirty-file protection', 'Edge launch/input inside VS Code extension host'], version: vscode.version };
  await fs.writeFile(path.join(root, 'vscode-test-result.json'), JSON.stringify(report, null, 2));
}
module.exports = { run };
