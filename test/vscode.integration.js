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

  // Commands cannot run until the exact pending approval is accepted.
  const commandJob = provider.runCommand('node test/average.test.js', root);
  assert.ok(provider.pending.viewData.changedFiles.some(file => file.path === 'src/average.js'));
  assert.equal(provider.runner.child, undefined);
  await provider.handle({ type: 'approveCommand', token: 'stale-token' });
  assert.equal(provider.runner.child, undefined);
  await provider.handle({ type: 'approveCommand', token: provider.pending.viewData.token });
  assert.equal((await commandJob).exitCode, 0);
  const rejectedJob = provider.runCommand('echo should-not-run', root);
  await provider.handle({ type: 'rejectCommand', token: provider.pending.viewData.token });
  assert.equal((await rejectedJob).approved, false);

  // Undo restores existing files and removes only files created by the agent.
  await provider.undo();
  assert.equal(await fs.readFile(path.join(root, 'src', 'average.js'), 'utf8'), original);
  await assert.rejects(fs.access(path.join(root, 'test', 'average.test.js')));
  assert.ok(provider.context.workspaceState.get('sessions').some(session => session.events.some(event => event.role === 'user')));
  provider.browser.request = async prompt => {
    assert.match(prompt, /빈 배열의 평균/);
    return { kind: 'done', message: '이전 문맥 확인' };
  };
  await provider.start({ task: '앞의 작업을 설명해줘.', mode: 'ask', includeEditor: false });

  // Disabling normal review cannot bypass review of executable configuration.
  const { WorkspaceStore } = require('../src/workspace');
  const guardedStore = await new WorkspaceStore(root).initialize();
  const guardedChanges = await guardedStore.prepareChanges([{ path: 'package.json', action: 'create', baseHash: null, content: '{"scripts":{"test":"echo altered"}}\n' }]);
  let guardedJob = provider.stageAndApply(guardedStore, guardedChanges, '실행 설정 변경', false);
  assert.deepEqual(provider.pending.viewData.forcedReview, ['package.json']);
  await assert.rejects(fs.access(path.join(root, 'package.json')));
  await provider.handle({ type: 'reject', token: provider.pending.viewData.token });
  assert.equal(await guardedJob, false);
  guardedJob = provider.stageAndApply(guardedStore, guardedChanges, '실행 설정 변경', false);
  await provider.handle({ type: 'apply', token: provider.pending.viewData.token });
  assert.equal(await guardedJob, true);
  const inspectCommand = provider.runCommand('npm test', root);
  assert.ok(provider.pending.viewData.changedFiles.some(file => file.path === 'package.json' && file.sensitive && file.id));
  await provider.handle({ type: 'rejectCommand', token: provider.pending.viewData.token });
  assert.equal((await inspectCommand).approved, false);
  await provider.undo();
  await assert.rejects(fs.access(path.join(root, 'package.json')));

  // A large file is edited using a bounded read and an exact replacement anchor.
  const large = Array.from({ length: 1000 }, (_, i) => `const row${i} = "${'x'.repeat(60)}";`).join('\n');
  await fs.writeFile(path.join(root, 'src', 'large.js'), large);
  let largeRound = 0;
  provider.browser.request = async prompt => {
    if (++largeRound === 1) return { kind: 'tools', calls: [{ name: 'read_file', path: 'src/large.js', startLine: 501, lineCount: 4 }] };
    if (largeRound === 2) {
      assert.match(prompt, /const row500/); assert.ok(prompt.length < 12000);
      return { kind: 'changes', files: [{ path: 'src/large.js', action: 'edit', baseHash: digest(large), edits: [{ oldText: 'const row500 =', newText: 'const fixed500 =' }] }] };
    }
    return { kind: 'done', message: '큰 파일 부분 수정 완료' };
  };
  await provider.start({ task: 'row500만 고쳐줘.', mode: 'agent', includeEditor: false, review: false });
  assert.equal(await fs.readFile(path.join(root, 'src', 'large.js'), 'utf8'), large.replace('const row500 =', 'const fixed500 ='));
  assert.equal(largeRound, 3);

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
    // Exercise the complete provider -> browser -> rendered widget -> provider
    // path inside the extension host, without a real company account.
    const context = await browser.newContext();
    await context.route('https://m365.cloud.microsoft/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<textarea id="userInput"></textarea><button id="send">보내기</button><button disabled>Stop generating</button><main><section><div id="answer"></div></section></main><script>
document.querySelector('#send').onclick=()=>{const input=document.querySelector('textarea');const id=input.value.match(/Current requestId: ([^\\s]+)/)[1];input.value='';document.querySelector('#answer').textContent='JSON\\n복사\\n'+JSON.stringify({requestId:id,kind:'done',message:'실제 VS Code 자동 응답 수집 확인'});};
</script>` }));
    const chat = await context.newPage();
    await chat.goto('https://m365.cloud.microsoft/chat');
    const { CopilotBrowser } = require(path.join(extension.extensionPath, 'src', 'browser'));
    const transport = new CopilotBrowser({ timeoutSeconds: 7, responseStableMs: 100 });
    transport.context = context; transport.page = chat; provider.browser = transport;
    await provider.start({ task: '응답 수집을 확인해줘.', mode: 'ask', includeEditor: false });
    assert.equal(transport.lastResponse.stage, 'complete');
    assert.ok(provider.events.some(event => event.role === 'assistant' && event.text === '실제 VS Code 자동 응답 수집 확인'));
  } finally { await browser.close(); }
  const report = { ok: true, checks: ['extension activation', 'sidebar webview', 'file read', 'existing-file modification', 'nested new-file creation', 'save to disk', 'command approval and rejection', 'changed-file command review', 'forced execution-config review', 'large-file partial edit', 'real generated test execution', 'checkpoint undo', 'persistent conversation', 'dirty-file protection', 'Edge launch/input inside VS Code extension host', 'automatic rendered-widget response collection inside VS Code'], version: vscode.version };
  await fs.writeFile(path.join(root, 'vscode-test-result.json'), JSON.stringify(report, null, 2));
}
module.exports = { run };
