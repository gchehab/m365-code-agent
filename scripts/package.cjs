'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');
const cli = require.resolve('@vscode/vsce/vsce');
const result = spawnSync(process.execPath, [cli, 'package', '--out', path.join('dist', `m365-code-agent-${version}.vsix`)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
