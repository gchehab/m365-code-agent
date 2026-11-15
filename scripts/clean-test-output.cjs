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
  if (stat.isDirectory())
    for (const entry of await fs.readdir(target)) await assertTreeBounds(path.join(target, entry), root);
}
async function planCleanup(repo, { keep = 3, olderThanHours = 24, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || !Number.isFinite(olderThanHours) || olderThanHours < 1)
    throw new Error('keep은 1 이상의 정수, older-than-hours는 1 이상의 숫자여야 합니다.');
  const realRepo = await fs.realpath(repo),
    root = path.join(realRepo, '.test-output');
  const stat = await statOrNull(root);
  if (!stat) return { root, candidates: [], keep, olderThanHours };
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
      info = await fs.lstat(target);
    if (!info.isSymbolicLink()) runs.push({ name: entry.name, target, modified: info.mtimeMs });
  }
  runs.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  const candidates = [];
  for (const run of runs.slice(keep)) {
    if (now - run.modified < olderThanHours * 3600000 || !(await ownedFinishedRun(run.target))) continue;
    try {
      await assertTreeBounds(run.target, root);
      candidates.push(run.name);
    } catch {
      /* Keep linked or unstable output. */
    }
  }
  return { root, candidates, keep, olderThanHours };
}
async function cleanTestOutput(repo, options = {}) {
  const plan = await planCleanup(repo, options),
    removed = [];
  if (options.apply === true)
    for (const name of plan.candidates) {
      // Recompute retention/ownership immediately before removing each verified target.
      const current = await planCleanup(repo, options);
      if (!current.candidates.includes(name)) continue;
      const target = path.resolve(current.root, name);
      if (path.dirname(target) !== path.resolve(current.root))
        throw new Error('정리 대상 경로 검증에 실패했습니다.');
      await assertTreeBounds(target, current.root);
      await fs.rm(target, { recursive: true, force: false });
      removed.push(name);
    }
  return { ...plan, dryRun: options.apply !== true, removed };
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
