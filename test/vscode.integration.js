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
  assert.ok(extension.packageJSON.contributes.viewsContainers.secondarySidebar.some(container => container.id === 'm365Agent'));
  assert.equal(extension.packageJSON.contributes.viewsContainers.activitybar, undefined);
  assert.ok((await vscode.commands.getCommands(true)).includes('workbench.view.extension.m365Agent.resetViewContainerLocation'));
  await Promise.race([vscode.commands.executeCommand('m365Agent.open'), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('agent open timed out')), 20000))]);
  for (let tries = 0; !provider.view && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(provider.view, 'sidebar webview is created');
  // Simulate a saved old/custom placement, then restore just the agent via its open command.
  await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['m365Agent.chat'], destinationId: 'workbench.view.explorer' });
  await Promise.race([vscode.commands.executeCommand('m365Agent.open'), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('agent open timed out')), 20000))]);
  assert.equal(provider.view.visible, true, 'chat reopens after restoring its secondary-sidebar location');
  assert.match(provider.view.webview.html, /Content-Security-Policy/);
  await provider.handle({ type: 'openResponse', text: '## Readable response\n\n```js\nconst value = 1;\n```', readingSize: 16, wrapCode: true });
  assert.equal(provider.responsePanel.panel.viewType, 'm365Agent.response');
  assert.match(provider.responsePanel.panel.webview.html, /language-js/);
  const responsePanel = provider.responsePanel.panel;
  await provider.handle({ type: 'openResponse', text: 'Second answer' });
  assert.equal(provider.responsePanel.panel, responsePanel, 'reader reuses the editor tab');
  provider.responsePanel.dispose();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const original = 'exports.average = values => values.reduce((a,b)=>a+b,0)/values.length;\n';
  await fs.writeFile(path.join(root, 'src', 'average.js'), original);
  await provider.checkWorkspace();
  assert.equal(provider.workspaceInfo.writable, true);
  assert.ok(provider.workspaceInfo.read > 0);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.m365-agent-check-')), false);
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

  // Previously unrecognized wording must still reach real file editing tools.
  const readmePath = path.join(root, 'README.md');
  await fs.writeFile(readmePath, 'Before\n');
  let updateRound = 0;
  provider.browser.request = async () => {
    if (++updateRound === 1) return { kind: 'tools', calls: [{ name: 'read_file', path: 'README.md' }] };
    if (updateRound === 2) return { kind: 'changes', files: [{ path: 'README.md', action: 'edit', baseHash: digest('Before\n'), edits: [{ oldText: 'Before', newText: 'After' }] }] };
    return { kind: 'done', message: 'README 업데이트 완료' };
  };
  await provider.start({ task: 'README 업데이트해줘', includeEditor: false, review: false });
  assert.equal(await fs.readFile(readmePath, 'utf8'), 'After\n');
  assert.equal(provider.agent.mode, 'agent');
  const checkpointCount = provider.checkpoints.length;
  let explanationRequests = 0;
  provider.browser.request = async () => { explanationRequests++; return { kind: 'done', message: '이유 설명' }; };
  await provider.start({ task: '왜 수정이 필요한지 설명해줘', includeEditor: false, review: false });
  assert.equal(provider.agent.mode, 'ask');
  assert.equal(explanationRequests, 1);
  assert.equal(provider.checkpoints.length, checkpointCount);
  const previousChanges = provider.runCommand('npm test', root);
  assert.ok(provider.pending.viewData.changedFiles.some(file => file.path === 'README.md' && file.currentTask === false));
  await provider.handle({ type: 'rejectCommand', token: provider.pending.viewData.token });
  await previousChanges;
  await provider.undo();
  assert.equal(await fs.readFile(readmePath, 'utf8'), 'Before\n');

  // A stop received after browser preparation but before agent construction must
  // not be lost when the next CodingAgent would reset its cancellation state.
  let cancelledSends = 0;
  provider.browser.context = {};
  provider.browser.waitForComposer = async () => {};
  provider.browser.readConversation = async () => {
    await provider.stop();
    return { url: 'https://m365.cloud.microsoft/chat', restorable: false, messages: [] };
  };
  provider.browser.request = async () => { cancelledSends++; return { kind: 'done', message: '중지 후 실행되면 안 됩니다.' }; };
  await provider.start({ task: 'README 업데이트해줘', includeEditor: false, review: false });
  assert.equal(cancelledSends, 0);
  assert.equal(await fs.readFile(readmePath, 'utf8'), 'Before\n');
  delete provider.browser.context; delete provider.browser.waitForComposer; delete provider.browser.readConversation;
  provider.agent = null; provider.stopRequested = false;

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

  // Explicit automatic approval applies execution settings and runs a real command,
  // without a change/command approval prompt; it must not leak into the next request.
  const automaticEvents = [], originalPost = provider.post;
  provider.post = function (event) { automaticEvents.push(event); return originalPost.call(this, event); };
  let automaticRound = 0;
  provider.browser.request = async prompt => {
    assert.equal(provider.pending, null);
    assert.match(prompt, /commands run without approval prompts/);
    if (++automaticRound === 1) return { kind: 'changes', summary: '자동 승인 검증용 코드 및 실행 설정', files: [
      { path: 'package.json', action: 'create', baseHash: null, content: '{"scripts":{"test":"node src/automatic.js"}}\n' },
      { path: 'src/automatic.js', action: 'create', baseHash: null, content: "require('node:fs').writeFileSync('automatic-result.txt', 'ok');\n" }
    ] };
    if (automaticRound === 2) return { kind: 'tools', calls: [{ name: 'run_command', command: 'node src/automatic.js' }] };
    return { kind: 'done', message: '자동 승인으로 수정하고 검증했습니다.' };
  };
  try { await Promise.race([provider.start({ task: 'package.json과 샘플 코드를 만들고 검증 명령을 실행해줘.', review: true, autoApprove: true, includeEditor: false }), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('automatic approval waited for a prompt')), 20000))]); }
  finally { provider.post = originalPost; }
  assert.equal(await fs.readFile(path.join(root, 'automatic-result.txt'), 'utf8'), 'ok');
  assert.equal(automaticEvents.some(event => event.type === 'commandApproval' || (event.type === 'changes' && event.review)), false);
  assert.ok(automaticEvents.some(event => event.type === 'changes' && event.autoApproved));
  assert.equal(provider.agent.unlimitedRounds, false, 'automatic approval does not enable unlimited requests');
  assert.equal(provider.pending, null);
  const subsequentManual = provider.runCommand('echo manual-approval-required', root);
  assert.equal(provider.pending.kind, 'command');
  await provider.handle({ type: 'rejectCommand', token: provider.pending.viewData.token });
  assert.equal((await subsequentManual).approved, false);
  await provider.undo();
  await assert.rejects(fs.access(path.join(root, 'package.json')));

  // Unlimited requests alone cannot grant automatic approval, including execution settings.
  const unlimitedEvents = [], beforeUnlimitedPost = provider.post;
  provider.post = function (event) { unlimitedEvents.push(event); return beforeUnlimitedPost.call(this, event); };
  let unlimitedRound = 0;
  provider.browser.request = async prompt => {
    const data = JSON.parse(prompt.split('DATA: ')[1]);
    assert.equal(data.progress.unlimited, true); assert.equal(data.progress.limit, null);
    assert.match(prompt, /Commands need user approval/);
    if (++unlimitedRound === 1) return { kind: 'changes', summary: '무제한과 승인 설정 독립성 검증', files: [{ path: 'package.json', action: 'create', baseHash: null, content: '{"scripts":{"test":"echo reviewed"}}\n' }] };
    return { kind: 'done', message: '승인 후 적용했습니다.' };
  };
  try {
    const job = provider.start({ task: 'package.json을 만들어줘.', review: false, unlimitedRounds: true, includeEditor: false });
    for (let tries = 0; !provider.pending && tries < 500; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(provider.pending?.kind, 'changes');
    assert.ok(provider.pending.viewData.forcedReview.includes('package.json'));
    assert.equal(provider.agent.autoApprove, false);
    await provider.handle({ type: 'apply', token: provider.pending.viewData.token });
    await job;
  } finally { provider.post = beforeUnlimitedPost; }
  assert.match(await fs.readFile(path.join(root, 'package.json'), 'utf8'), /reviewed/);
  assert.ok(unlimitedEvents.some(event => event.type === 'progress' && event.unlimited && event.total === null && event.remaining === null));
  await provider.undo();
  await assert.rejects(fs.access(path.join(root, 'package.json')));

  // Delete and restore text, UTF-16, binary and empty files through actual VS Code APIs.
  const deletionFiles = new Map([
    ['src/legacy-delete.js', Buffer.from('exports.legacy = true;\r\n')],
    ['assets/delete.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff])],
    ['assets/delete-utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('한글 원본\r\n', 'utf16le')])],
    ['assets/delete-empty.txt', Buffer.alloc(0)]
  ]);
  await fs.mkdir(path.join(root, 'assets'));
  for (const [name, bytes] of deletionFiles) await fs.writeFile(path.join(root, name), bytes);
  const deletionStore = await provider.workspaceStore(await provider.rootFolder());
  const prepareDeletion = async () => {
    const files = [];
    for (const name of deletionFiles.keys()) { const info = await deletionStore.fileInfo(name); files.push({ path: info.path, action: 'delete', baseHash: info.hash }); }
    return deletionStore.prepareChanges(files);
  };
  let deleteJob = provider.stageAndApply(deletionStore, await prepareDeletion(), '구형 파일 삭제', false);
  assert.ok(provider.pending.viewData.files.every(file => file.action === 'delete'));
  assert.equal(provider.pending.viewData.review, true, 'deletion requires review unless automatic approval is explicit');
  await provider.handle({ type: 'reject', token: provider.pending.viewData.token }); assert.equal(await deleteJob, false);
  for (const [name, bytes] of deletionFiles) assert.deepEqual(await fs.readFile(path.join(root, name)), bytes);
  deleteJob = provider.stageAndApply(deletionStore, await prepareDeletion(), '삭제 승인', false);
  await provider.handle({ type: 'apply', token: provider.pending.viewData.token }); assert.equal(await deleteJob, true);
  for (const name of deletionFiles.keys()) await assert.rejects(fs.access(path.join(root, name)));
  const afterDeleteCommand = provider.runCommand('echo inspect-deleted-files', root);
  assert.ok(provider.pending.viewData.changedFiles.some(file => file.action === 'delete' && file.path === 'assets/delete.bin'));
  await provider.handle({ type: 'rejectCommand', token: provider.pending.viewData.token }); await afterDeleteCommand;
  await provider.undo();
  for (const [name, bytes] of deletionFiles) assert.deepEqual(await fs.readFile(path.join(root, name)), bytes, 'undo restores original bytes/encoding');

  // Mixed changes must save the correct documents even when deletions come first.
  await fs.writeFile(path.join(root, 'src/mixed-delete.js'), 'exports.value = 1;\n');
  const mixedRead = await deletionStore.readFile('src/mixed-delete.js');
  const mixed = [...await prepareDeletion(), ...await deletionStore.prepareChanges([
    { path: mixedRead.path, action: 'replace', baseHash: mixedRead.hash, content: 'exports.value = 2;\n' },
    { path: 'src/mixed-created.js', action: 'create', baseHash: null, content: 'exports.created = true;\n' }
  ])];
  assert.equal(await provider.stageAndApply(deletionStore, mixed, '자동 승인 혼합 변경', true, true), true);
  assert.equal(provider.pending, null);
  assert.equal(await fs.readFile(path.join(root, 'src/mixed-delete.js'), 'utf8'), 'exports.value = 2;\n');
  assert.match(await fs.readFile(path.join(root, 'src/mixed-created.js'), 'utf8'), /created/);
  for (const name of deletionFiles.keys()) await assert.rejects(fs.access(path.join(root, name)));
  await provider.undo();
  assert.equal(await fs.readFile(path.join(root, 'src/mixed-delete.js'), 'utf8'), 'exports.value = 1;\n');
  await assert.rejects(fs.access(path.join(root, 'src/mixed-created.js')));
  for (const [name, bytes] of deletionFiles) assert.deepEqual(await fs.readFile(path.join(root, name)), bytes);

  // The complete agent -> file_info -> delete -> done flow reports only actual outcomes.
  let deletionRound = 0;
  provider.browser.request = async prompt => {
    const data = JSON.parse(prompt.split('DATA: ')[1]);
    if (++deletionRound === 1) return { kind: 'tools', calls: [{ name: 'file_info', path: 'assets/delete.bin' }] };
    if (deletionRound === 2) {
      const info = data.history.flatMap(item => item.observations || []).findLast(item => item.call.name === 'file_info' && item.result?.path === 'assets/delete.bin').result;
      return { kind: 'changes', files: [{ path: info.path, action: 'delete', baseHash: info.hash }] };
    }
    assert.ok(data.history.some(item => item.kind === 'change_result' && item.applied && item.deletedFiles.includes('assets/delete.bin')));
    return { kind: 'done', message: '파일 삭제 완료' };
  };
  await provider.start({ task: 'assets/delete.bin 파일을 삭제해줘.', autoApprove: true, review: true, includeEditor: false });
  assert.equal(deletionRound, 3); await assert.rejects(fs.access(path.join(root, 'assets/delete.bin')));
  await fs.writeFile(path.join(root, 'assets/delete.bin'), 'user recreated file');
  await assert.rejects(provider.undo(), /다시 생겨/);
  assert.equal(await fs.readFile(path.join(root, 'assets/delete.bin'), 'utf8'), 'user recreated file');
  await fs.unlink(path.join(root, 'assets/delete.bin')); await provider.undo();
  assert.deepEqual(await fs.readFile(path.join(root, 'assets/delete.bin')), deletionFiles.get('assets/delete.bin'));

  // Edits on either side of a deletion approval must be detected before removing the file.
  const changedInfo = await deletionStore.fileInfo('src/legacy-delete.js');
  deleteJob = provider.stageAndApply(deletionStore, await deletionStore.prepareChanges([{ path: changedInfo.path, action: 'delete', baseHash: changedInfo.hash }]), '삭제 전 변경 감지', true);
  await fs.writeFile(path.join(root, changedInfo.path), 'user saved edit\n');
  await provider.handle({ type: 'apply', token: provider.pending.viewData.token }); await assert.rejects(deleteJob, /변경/);
  assert.equal(await fs.readFile(path.join(root, changedInfo.path), 'utf8'), 'user saved edit\n');
  const dirtyInfo = await deletionStore.fileInfo(changedInfo.path);
  const dirtyDocument = await vscode.workspace.openTextDocument(path.join(root, changedInfo.path));
  const dirtyEdit = new vscode.WorkspaceEdit(); dirtyEdit.insert(dirtyDocument.uri, new vscode.Position(0, 0), '// unsaved\n'); await vscode.workspace.applyEdit(dirtyEdit);
  await assert.rejects(provider.stageAndApply(deletionStore, await deletionStore.prepareChanges([{ path: dirtyInfo.path, action: 'delete', baseHash: dirtyInfo.hash }]), 'dirty delete', false, true), /저장하지 않은/);
  assert.equal(await fs.readFile(path.join(root, changedInfo.path), 'utf8'), 'user saved edit\n'); await dirtyDocument.save();

  // Native folder deletion removes only observed entries, and restores bytes and empty directories.
  const folderName = 'folder-delete-native', folderPath = path.join(root, folderName);
  const folderBytes = new Map([['nested/source.js', Buffer.from('exports.old = true;\r\n')], ['image.bin', Buffer.from([0, 255, 128])], ['nested/utf16.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('원본', 'utf16le')])]]);
  await fs.mkdir(path.join(folderPath, 'nested', 'empty'), { recursive: true });
  for (const [name, bytes] of folderBytes) await fs.writeFile(path.join(folderPath, name), bytes);
  const prepareFolderDelete = async () => {
    const info = await deletionStore.folderInfo(folderName);
    return deletionStore.prepareChanges([{ path: info.path, action: 'delete', baseHash: info.hash }]);
  };
  let folderJob = provider.stageAndApply(deletionStore, await prepareFolderDelete(), '폴더 삭제 검토', false);
  assert.equal(provider.pending.viewData.files[0].directory, true);
  await provider.handle({ type: 'reject', token: provider.pending.viewData.token }); assert.equal(await folderJob, false);
  assert.deepEqual(await fs.readFile(path.join(folderPath, 'image.bin')), folderBytes.get('image.bin'));
  folderJob = provider.stageAndApply(deletionStore, await prepareFolderDelete(), '검토 후 새 파일 보호', true);
  await fs.writeFile(path.join(folderPath, 'new.txt'), 'user file');
  await provider.handle({ type: 'apply', token: provider.pending.viewData.token }); await assert.rejects(folderJob, /변경/);
  assert.equal(await fs.readFile(path.join(folderPath, 'new.txt'), 'utf8'), 'user file');
  await fs.unlink(path.join(folderPath, 'new.txt'));
  assert.equal(await provider.stageAndApply(deletionStore, await prepareFolderDelete(), '폴더 자동 승인 삭제', true, true), true);
  await assert.rejects(fs.access(folderPath));
  await fs.mkdir(folderPath); await fs.writeFile(path.join(folderPath, 'recreated.txt'), 'keep');
  await assert.rejects(provider.undo(), /다시 생겨/);
  assert.equal(await fs.readFile(path.join(folderPath, 'recreated.txt'), 'utf8'), 'keep');
  await fs.unlink(path.join(folderPath, 'recreated.txt')); await fs.rmdir(folderPath);
  await provider.undo();
  for (const [name, bytes] of folderBytes) assert.deepEqual(await fs.readFile(path.join(folderPath, name)), bytes);
  assert.ok((await fs.stat(path.join(folderPath, 'nested', 'empty'))).isDirectory());
  const folderDocument = await vscode.workspace.openTextDocument(path.join(folderPath, 'nested', 'source.js'));
  const folderDirtyEdit = new vscode.WorkspaceEdit(); folderDirtyEdit.insert(folderDocument.uri, new vscode.Position(0, 0), '// unsaved\n');
  await vscode.workspace.applyEdit(folderDirtyEdit);
  await assert.rejects(provider.stageAndApply(deletionStore, await prepareFolderDelete(), '폴더 내 편집 보호', false, true), /저장하지 않은/);
  await folderDocument.save();

  // Inject a new child after validation using the real onWillDeleteFiles resource event.
  let injected = false;
  const raceListener = vscode.workspace.onWillDeleteFiles(event => {
    if (!injected && event.files.some(uri => uri.fsPath.toLowerCase().startsWith(folderPath.toLowerCase() + path.sep))) {
      injected = true;
      event.waitUntil(fs.writeFile(path.join(folderPath, 'new-user.txt'), 'keep new file').then(() => new vscode.WorkspaceEdit()));
    }
  });
  const checkpointsBeforeRace = provider.checkpoints.length;
  try { await assert.rejects(provider.stageAndApply(deletionStore, await prepareFolderDelete(), '삭제 도중 추가 파일 보호', false, true), /완료하지 못|삭제를 확인/); }
  finally { raceListener.dispose(); }
  assert.equal(injected, true);
  assert.equal(await fs.readFile(path.join(folderPath, 'new-user.txt'), 'utf8'), 'keep new file');
  if (provider.checkpoints.length > checkpointsBeforeRace) await provider.undo();
  for (const name of folderBytes.keys()) assert.ok((await fs.stat(path.join(folderPath, name))).isFile());
  await fs.unlink(path.join(folderPath, 'new-user.txt'));

  // Exercise the model-facing folder_info -> changes(delete) -> done flow.
  let folderRound = 0;
  provider.browser.request = async prompt => {
    const data = JSON.parse(prompt.split('DATA: ')[1]);
    if (++folderRound === 1) return { kind: 'tools', calls: [{ name: 'folder_info', path: folderName }] };
    if (folderRound === 2) {
      const info = data.history.flatMap(item => item.observations || []).findLast(item => item.call.name === 'folder_info').result;
      return { kind: 'changes', files: [{ path: info.path, action: 'delete', baseHash: info.hash }] };
    }
    assert.ok(data.history.some(item => item.kind === 'change_result' && item.applied && item.deletedFiles.includes(folderName)));
    return { kind: 'done', message: '폴더 삭제 완료' };
  };
  await provider.start({ task: folderName + ' 폴더를 삭제해줘.', autoApprove: true, includeEditor: false });
  assert.equal(folderRound, 3); await assert.rejects(fs.access(folderPath)); await provider.undo();
  assert.ok((await fs.stat(path.join(folderPath, 'nested', 'empty'))).isDirectory());
  await fs.mkdir(path.join(root, 'empty-delete', 'empty'), { recursive: true });
  const emptyInfo = await deletionStore.folderInfo('empty-delete');
  assert.equal(await provider.stageAndApply(deletionStore, await deletionStore.prepareChanges([{ path: emptyInfo.path, action: 'delete', baseHash: emptyInfo.hash }]), '빈 폴더 삭제', false, true), true);
  await assert.rejects(fs.access(path.join(root, 'empty-delete'))); await provider.undo();
  assert.ok((await fs.stat(path.join(root, 'empty-delete', 'empty'))).isDirectory());

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
  await assert.rejects(provider.stageAndApply(store, changes, 'must reject', true, true), /저장하지 않은/);
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
document.querySelector('#send').onclick=()=>{const input=document.querySelector('textarea');const prompt=input.value;const id=prompt.match(/Current requestId: ([^\\s]+)/)[1];const data=JSON.parse(prompt.slice(prompt.indexOf(' DATA: ')+7));input.value='';let reply={requestId:id,kind:'done',message:'실제 VS Code 자동 응답 수집 확인'};
if(data.task.includes('샘플 코드')){window.multiRound=(window.multiRound||0)+1;if(window.multiRound===1){const answer=document.querySelector('#answer');answer.replaceChildren();for(const file of [{path:'samples/add.js',action:'create',baseHash:null,content:'exports.add = (a, b) => a + b;\\n'},{path:'samples/add.test.js',action:'create',baseHash:null,content:'const assert = require("node:assert/strict"); const {add} = require("./add"); assert.equal(add(1,2),3);\\n'}]){const pre=document.createElement('pre');pre.textContent=JSON.stringify({requestId:id,kind:'changes',files:[file]});answer.append(pre);}const done=document.createElement('pre');done.textContent=JSON.stringify({requestId:id,kind:'done',message:'두 파일의 코드를 준비했습니다.'});answer.append(done);return;}window.multiAppliedSeen=data.history.some(x=>x.kind==='change_result'&&x.applied&&x.files.includes('samples/add.js'));reply={requestId:id,kind:'done',message:'다중 JSON 파일 저장 확인'};}
if(data.task.includes('src/target.js')){window.editRound=(window.editRound||0)+1;const observations=data.history.filter(x=>x.kind==='tool_results').flatMap(x=>x.observations);const file=[...observations].reverse().find(x=>x.result&&x.result.path==='src/target.js');
if(window.editRound===1){window.bootstrapSeen=!!file&&file.result.content.includes('exports.value = 1;');reply={requestId:id,kind:'tools',calls:[{name:'read_file',arguments:JSON.stringify({path:'./src/target.js',startLine:1,lineCount:3})}]};}
else if(window.editRound===2){const oldText=file.result.content.split('\\n')[0];reply={requestId:id,kind:'changes',files:[{path:'src/target.js',action:'edit',baseHash:file.result.hash,edits:[{oldText,newText:oldText.replace('1;','2;')}]}]};}
else reply={requestId:id,kind:'done',message:'실제 프로젝트 파일 수정 완료'};}
document.querySelector('#answer').textContent='JSON\\n복사\\n'+JSON.stringify(reply);};
</script>` }));
    const chat = await context.newPage();
    await chat.goto('https://m365.cloud.microsoft/chat');
    const { CopilotBrowser } = require(path.join(extension.extensionPath, 'src', 'browser'));
    const transport = new CopilotBrowser({ timeoutSeconds: 7, responseStableMs: 100 });
    transport.context = context; transport.page = chat; provider.browser = transport;
    await provider.start({ task: '응답 수집을 확인해줘.', mode: 'ask', includeEditor: false });
    assert.equal(transport.lastResponse.stage, 'complete');
    assert.equal(provider.browserPanel.panel.viewType, 'm365Agent.browser');
    for (let tries = 0; tries < 60 && (!provider.browserPanel.screen?.sequence || provider.browserPanel.screen.inFlight); tries++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(provider.browserPanel.screen.sequence > 0, 'actual editor browser receives live frames');
    assert.equal(provider.browserPanel.screen.page, transport.page, 'visible browser and automation use the same page');
    assert.ok(provider.events.some(event => event.role === 'assistant' && event.text === '실제 VS Code 자동 응답 수집 확인'));
    const target = 'exports.value = 1;\n' + '// project source filler\n'.repeat(20000);
    await fs.writeFile(path.join(root, 'src', 'target.js'), target);
    await provider.start({ task: 'src/target.js의 value를 2로 수정해줘.', mode: 'agent', includeEditor: false, review: false });
    assert.equal(await chat.evaluate(() => window.bootstrapSeen), true);
    assert.equal(await chat.evaluate(() => window.editRound), 3);
    assert.equal(await fs.readFile(path.join(root, 'src', 'target.js'), 'utf8'), target.replace('exports.value = 1;', 'exports.value = 2;'));
    await provider.start({ task: '샘플 코드 작성해줘. 함수와 테스트를 각각 파일로 만들어줘.', includeEditor: false, review: false });
    assert.equal(await chat.evaluate(() => window.multiRound), 2);
    assert.equal(await chat.evaluate(() => window.multiAppliedSeen), true);
    assert.match(await fs.readFile(path.join(root, 'samples/add.js'), 'utf8'), /exports.add/);
    assert.match(await fs.readFile(path.join(root, 'samples/add.test.js'), 'utf8'), /assert.equal/);
  } finally { await browser.close(); }
  const historyApi = provider.conversations.vscode;
  try {
    provider.conversations.vscode = { window: { async showInputBox() { return '샘플 코드 작업'; }, async showWarningMessage() { return '삭제'; } } };
    const id = provider.sessionId;
    await provider.conversations.manageSession('rename', id); provider.saveSession();
    assert.equal(provider.context.workspaceState.get('sessions').find(session => session.id === id).title, '샘플 코드 작업');
    await provider.conversations.manageSession('delete', id);
    assert.equal(provider.context.workspaceState.get('sessions').some(session => session.id === id), false);
    assert.match(await fs.readFile(path.join(root, 'samples/add.js'), 'utf8'), /exports.add/);
  } finally { provider.conversations.vscode = historyApi; }
  const report = { ok: true, checks: ['extension activation', 'sidebar webview', 'secondary-sidebar default and saved-location recovery', 'wide read-only response editor', 'local workspace read/write probe without M365', 'file read', 'existing-file modification', 'nested new-file creation', 'save to disk', 'command approval and rejection', 'changed-file command review', 'forced execution-config review', 'explicit automatic file/command approval and policy isolation', 'unlimited requests keep execution-config review and JSON-safe progress', 'delete approval/rejection, binary/UTF-16/empty restoration, mixed edits, collision and dirty-file guards', 'nested/empty-folder deletion, byte restoration, dirty/changed/recreated guards and new-file resource-event race', 'large-file partial edit', 'real generated test execution', 'checkpoint undo', 'persistent conversation', 'dirty-file protection', 'Edge launch/input inside VS Code extension host', 'automatic rendered-widget response collection inside VS Code', 'automatic source inspection -> browser tool arguments -> real edit over 128KB'], version: vscode.version };
  await fs.writeFile(path.join(root, 'vscode-test-result.json'), JSON.stringify(report, null, 2));
}
module.exports = { run };
