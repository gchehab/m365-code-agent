'use strict';
const path = require('node:path');

function rankFiles(files, task) {
  const tokens = task.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [];
  const source = /\.(?:[cm]?[jt]sx?|py|cs|java|kt|go|rs|rb|php|vue|svelte|cpp|c|h|swift|html|css|scss)$/i;
  const score = file => {
    const name = file.toLowerCase(), base = path.posix.basename(name);
    let value = source.test(name) ? 30 : 0;
    if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|readme(?:\.md)?|.*\.sln)$/.test(base)) value += 25;
    if (/(^|\/)(src|app|lib|server|client)\//.test(name)) value += 20;
    if (/^(index|main|app|program|startup|extension)\./.test(base)) value += 20;
    if (/(^|\/)(dist|build|coverage|vendor|bin|obj|\.test-output)\//.test(name)) value -= 100;
    for (const token of tokens) if (name.includes(token)) value += 40;
    return value;
  };
  return [...files].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

async function inspectProject(store, task, maxCharacters = 12000, emit, cancelled = () => false) {
  const id = 'project-scan';
  emit({ type: 'tool', id, label: '프로젝트 파일 탐색', state: 'running' });
  const listing = await store.listFiles(1000);
  const ranked = rankFiles(listing.files, task);
  const observations = [];
  let remaining = Math.max(1000, Math.min(6000, Math.floor(maxCharacters * 0.4)));
  for (const file of ranked.slice(0, 12)) {
    if (cancelled()) throw new Error('작업을 중지했습니다.');
    if (remaining < 300 || observations.filter(item => item.result).length >= 4) break;
    emit({ type: 'tool', id: 'project:' + file, label: 'read_file · ' + file, state: 'running' });
    try {
      const result = await store.readFile(file, { startLine: 1, lineCount: 60, maxCharacters: Math.min(1800, remaining) });
      remaining -= JSON.stringify(result).length;
      observations.push({ call: { name: 'read_file', path: file }, result });
      emit({ type: 'tool', id: 'project:' + file, label: 'read_file · ' + file, state: 'done', detail: `${result.content.length.toLocaleString()}자 · ${result.startLine}~${result.endLine}줄 읽음${result.complete ? ' · 전체' : ' · 일부'}` });
    } catch (error) {
      observations.push({ call: { name: 'read_file', path: file }, error: error.message });
      emit({ type: 'tool', id: 'project:' + file, label: 'read_file · ' + file, state: 'error', detail: error.message });
    }
  }
  const read = observations.filter(item => item.result).length;
  emit({ type: 'tool', id, label: '프로젝트 파일 탐색', state: read ? 'done' : 'error', detail: `${listing.files.length}개 발견${listing.truncated ? ' (목록 일부)' : ''} · ${read}개 본문 읽음` });
  return { files: { files: ranked.slice(0, 250), directories: listing.directories || [], truncated: listing.truncated || ranked.length > 250 }, history: { kind: 'tool_results', origin: 'automatic_workspace_inspection', observations }, read, discovered: listing.files.length };
}

function requestsEdits(task, mode) {
  return mode === 'agent' && !/수정하지|변경하지|변경 없이|수정 방법|수정 계획|do not (?:edit|change)|explain|how to/i.test(task) && /수정|고쳐|변경해|리팩터|구현|추가해|만들어|작성해|\b(fix|edit|modify|implement|refactor|create|update)\b/i.test(task);
}
module.exports = { inspectProject, requestsEdits, rankFiles };
