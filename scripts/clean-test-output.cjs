'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

async function statOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function isRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
async function ownedFinishedRun(target) {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(target, '.m365-test-run.json'), 'utf8'));
    return (
      marker.kind === 'm365-code-agent-integration' && marker.state === 'finished' && !isRunning(marker.pid)
    );
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
    // Older successful runs predate the marker. Unknown/failed legacy folders are retained.
    try {
      const result = JSON.parse(
        await fs.readFile(path.join(target, 'workspace', 'vscode-test-result.json'), 'utf8'),
      );
      return result.ok === true && (await statOrNull(path.join(target, 'vscode-test.log')))?.isFile();
    } catch {
      return false;
    }
  }
}
async function assertTreeBounds(target, root) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('정리 경로가 테스트 출력 폴더 밖입니다.');
  const stat = await fs.lstat(target);
  if (
    stat.isSymbolicLink() ||
    path.resolve(await fs.realpath(target)).toLowerCase() !== path.resolve(target).toLowerCase()
  )
    throw new Error('링크·정션은 정리하지 않습니다.');
  let bytes = stat.isFile() ? stat.size : 0;
  if (stat.isDirectory())
    for (const entry of await fs.readdir(target))
      bytes += await assertTreeBounds(path.join(target, entry), root);
  return bytes;
}
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
// This pass checks only the output root and immediate run metadata, never their trees.
async function selectRuns(repo, { keep = 3, olderThanHours = 24, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || !Number.isFinite(olderThanHours) || olderThanHours < 1)
    throw new Error('keep은 1 이상의 정수, older-than-hours는 1 이상의 숫자여야 합니다.');
  const realRepo = await fs.realpath(repo),
    root = path.join(realRepo, '.test-output');
  const stat = await statOrNull(root);
  if (!stat) return { root, runs: [], keep, olderThanHours };
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.realpath(root)).toLowerCase() !== root.toLowerCase()
  )
    throw new Error('테스트 출력 루트가 일반 폴더가 아닙니다.');
  const runs = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^integration-[a-z0-9]+$/i.test(entry.name)) continue;
    const target = path.join(root, entry.name),
      info = await statOrNull(target);
    if (info?.isDirectory() && !info.isSymbolicLink())
      runs.push({ name: entry.name, target, modified: info.mtimeMs, identity: identity(info) });
  }
  runs.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  return {
    root,
    keep,
    olderThanHours,
    runs: runs.slice(keep).filter((run) => now - run.modified >= olderThanHours * 3600000),
  };
}
async function inspectPlan(repo, options) {
  const selection = await selectRuns(repo, options),
    selected = new Map();
  let candidateBytes = 0;
  for (const run of selection.runs) {
    if (!(await ownedFinishedRun(run.target))) continue;
    try {
      candidateBytes += await assertTreeBounds(run.target, selection.root);
      selected.set(run.name, run);
    } catch {
      /* Keep linked or unstable output. */
    }
  }
  const report = {
    root: selection.root,
    candidates: [...selected.keys()],
    keep: selection.keep,
    olderThanHours: selection.olderThanHours,
    candidateBytes,
  };
  return { report, selected };
}
async function planCleanup(repo, options = {}) {
  return (await inspectPlan(repo, options)).report;
}
async function cleanTestOutput(repo, options = {}) {
  const { report, selected } = await inspectPlan(repo, options),
    removed = [];
  let removedBytes = 0;
  if (options.apply === true)
    for (const [name, planned] of selected) {
      // Refresh retention/age without walking any other run. Check only this target's tree.
      const current = await selectRuns(repo, options),
        run = current.runs.find((item) => item.name === name);
      if (!run || run.identity !== planned.identity || !(await ownedFinishedRun(run.target))) continue;
      const target = path.resolve(current.root, name);
      if (path.dirname(target) !== path.resolve(current.root))
        throw new Error('정리 대상 경로 검증에 실패했습니다.');
      const bytes = await assertTreeBounds(target, current.root);
      const finalStat = await fs.lstat(target);
      if (
        identity(finalStat) !== planned.identity ||
        finalStat.mtimeMs !== run.modified ||
        !(await ownedFinishedRun(target))
      )
        continue;
      await fs.rm(target, { recursive: true, force: false });
      removed.push(name);
      removedBytes += bytes;
    }
  return { ...report, dryRun: options.apply !== true, removed, removedBytes };
}
async function main(args) {
  const options = {};
  for (const arg of args) {
    if (arg === '--apply') options.apply = true;
    else if (/^--keep=\d+$/.test(arg)) options.keep = Number(arg.split('=')[1]);
    else if (/^--older-than-hours=\d+(?:\.\d+)?$/.test(arg))
      options.olderThanHours = Number(arg.split('=')[1]);
    else throw new Error('사용법: npm run clean:test-output -- [--apply] [--keep=3] [--older-than-hours=24]');
  }
  console.log(JSON.stringify(await cleanTestOutput(path.resolve(__dirname, '..'), options), null, 2));
}
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { planCleanup, cleanTestOutput };
