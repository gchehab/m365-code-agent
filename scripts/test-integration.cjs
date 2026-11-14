'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, '.test-output');
  await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'integration-'));
  const workspace = path.join(run, 'workspace');
  await fs.mkdir(workspace);
  const log = createWriteStream(path.join(run, 'vscode-test.log'));
  let result;
  try { result = await runTests({
    vscodeExecutablePath: process.env.M365_AGENT_VSCODE_PATH || undefined,
    cachePath: path.join(output, 'vscode-cache'),
    extensionDevelopmentPath: process.env.M365_AGENT_EXTENSION_PATH || root,
    extensionTestsPath: path.join(root, 'test', 'vscode.integration.js'),
    stdout: log, stderr: log,
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--user-data-dir=' + path.join(run, 'profile'), '--extensions-dir=' + path.join(run, 'extensions')]
  }); } finally { log.end(); console.log('VS Code test log: ' + path.join(run, 'vscode-test.log')); }
  if (result !== 0) throw new Error(`VS Code 테스트 종료 코드 ${result}`);
  const report = JSON.parse(await fs.readFile(path.join(workspace, 'vscode-test-result.json'), 'utf8'));
  if (!report.ok) throw new Error('VS Code 통합 검증 실패');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
