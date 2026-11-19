'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');
const cli = require.resolve('@vscode/vsce/vsce');
const { listFiles, PackageManager } = require('@vscode/vsce');
(async () => {
  const root = path.resolve(__dirname, '..');
  const files = await listFiles({ cwd: root, packageManager: PackageManager.Npm });
  const privatePath =
    /(^|[/\\])(\.test-output|\.vscode-test|edge-profile|model-provider-profile|\.git)([/\\]|$)|(^|[/\\])(?:Cookies|Login Data|Local State|\.env[^/\\]*|\.npmrc)$|\.(pem|pfx|p12|key)$/i;
  if (files.some((file) => privatePath.test(file)))
    throw new Error('패키지에 테스트 프로필·자격 증명 경로가 포함됐습니다. 배포를 중단합니다.');
  const tracked = spawnSync('git', ['ls-files', '--', '.test-output', '.vscode-test'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (tracked.status === 0 && tracked.stdout.trim())
    throw new Error('테스트 프로필이 Git에 추적되고 있습니다. 소스 배포를 중단합니다.');
  const result = spawnSync(
    process.execPath,
    [cli, 'package', '--out', path.join('dist', `m365-code-agent-${version}.vsix`)],
    { stdio: 'inherit', cwd: root },
  );
  process.exitCode = result.status ?? 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
