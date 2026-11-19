'use strict';
const { rankFiles } = require('./search');

async function inspectProject(store, task, maxCharacters = 120000, emit, cancelled = () => false, paths) {
  const id = 'project-scan';
  emit({ type: 'tool', id, label: '프로젝트 파일 탐색', state: 'running' });
  const listing = store.discoverFiles
    ? await store.discoverFiles({ paths, cancelled })
    : await store.listFiles(1000);
  let retrieval;
  if (store.searchCode && listing.files.length) {
    emit({ type: 'tool', id: 'project-search', label: '관련 코드 검색', state: 'running' });
    retrieval = await store.searchCode(task, undefined, cancelled, listing);
    emit({
      type: 'tool',
      id: 'project-search',
      label: '관련 코드 검색',
      state: 'done',
      detail: `${retrieval.indexedFiles}개 파일 색인 · 관련 파일 ${retrieval.matches.length}개${retrieval.truncated ? ' · 검색 범위 일부' : ''}`,
    });
  }
  const ranked = [
    ...new Set([...(retrieval?.matches.map((match) => match.path) || []), ...rankFiles(listing.files, task)]),
  ];
  const observations = [];
  let remaining = Math.max(1000, Math.min(6000, Math.floor(maxCharacters * 0.4)));
  const initialReads = Math.max(1, Math.min(4, Math.floor(maxCharacters / 6000)));
  for (const file of ranked.slice(0, 12)) {
    if (cancelled()) throw new Error('작업을 중지했습니다.');
    if (remaining < 300 || observations.filter((item) => item.result).length >= initialReads) break;
    emit({ type: 'tool', id: 'project:' + file, label: 'read_file · ' + file, state: 'running' });
    try {
      const match = retrieval?.matches.find((match) => match.path === file);
      const result = await store.readFile(file, {
        startLine: match?.column > 1 ? match.line : Math.max(1, (match?.line || 1) - 3),
        startColumn: match?.column > 1 ? match.column : 1,
        lineCount: 60,
        maxCharacters: Math.min(1800, remaining),
      });
      remaining -= JSON.stringify(result).length;
      observations.push({
        call: { name: 'read_file', path: file, startLine: result.startLine, startColumn: result.startColumn },
        result,
      });
      emit({
        type: 'tool',
        id: 'project:' + file,
        label: 'read_file · ' + file,
        state: 'done',
        detail: `${result.content.length.toLocaleString()}자 · ${result.startLine}~${result.endLine}줄 읽음${result.complete ? ' · 전체' : ' · 일부'}`,
      });
    } catch (error) {
      observations.push({ call: { name: 'read_file', path: file }, error: error.message });
      try {
        const result = await store.fileInfo(file, cancelled);
        remaining -= JSON.stringify(result).length;
        observations.push({ call: { name: 'file_info', path: file }, result });
        emit({
          type: 'tool',
          id: 'project:' + file,
          label: 'file_info · ' + file,
          state: 'done',
          detail: `${result.size.toLocaleString()} bytes · 본문 대신 파일 해시 확인`,
        });
      } catch {
        emit({
          type: 'tool',
          id: 'project:' + file,
          label: 'read_file · ' + file,
          state: 'error',
          detail: error.message,
        });
      }
    }
  }
  const read = observations.filter((item) => item.result && item.call.name === 'read_file').length;
  const inspected = observations.filter((item) => item.result && item.call.name === 'file_info').length;
  emit({
    type: 'tool',
    id,
    label: '프로젝트 파일 탐색',
    state: read || inspected ? 'done' : 'error',
    detail: `${listing.files.length}개 발견${listing.truncated ? ' (목록 일부)' : ''} · ${read}개 본문 읽음${inspected ? ' · 파일 정보 ' + inspected + '개 확인' : ''}`,
  });
  return {
    files: {
      files: ranked.slice(0, 250),
      ...(paths ? { scope: paths } : {}),
      directories: listing.directories || [],
      truncated: listing.truncated || ranked.length > 250,
      ...(retrieval
        ? {
            searchCoverage: {
              indexedFiles: retrieval.indexedFiles,
              skippedFiles: retrieval.skippedFiles,
              incomplete: retrieval.truncated,
              reasons: retrieval.reasons,
            },
          }
        : {}),
    },
    history: {
      kind: 'tool_results',
      origin: 'automatic_workspace_inspection',
      observations,
      ...(inspected
        ? {
            note: 'file_info provides byte hash/size only, not source text. Do not claim to have analyzed unread file bodies.',
          }
        : {}),
    },
    read,
    inspected,
    discovered: listing.files.length,
  };
}

module.exports = { inspectProject, rankFiles };
