'use strict';
const { createHash, randomUUID } = require('node:crypto');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
class TaskProgress {
  constructor() { this.id = randomUUID(); this.seen = new Set(); this.failures = new Set(); this.recentTools = []; this.changedFiles = new Set(); this.stalls = 0; this.repaired = new Set(); }
  failure(error) { this.lastError = error.message; const category = (error.code || '') + ':' + error.message.split(':')[0]; const fresh = !this.failures.has(category); this.failures.add(category); return fresh; }
  observe(call, result) {
    if (call.name === 'run_command') return true; // An approved command is a fresh execution, never a cached result.
    const evidence = { name: call.name, query: call.query, scope: call.name === 'read_file' ? undefined : call.path, result };
    const key = createHash('sha256').update(JSON.stringify(canonical(evidence))).digest('hex');
    const fresh = !this.seen.has(key); this.seen.add(key);
    this.recentTools.push({ name: call.name, path: result.path || call.path, query: call.query, hash: result.hash, startLine: result.startLine, endLine: result.endLine, nextLine: result.nextLine, nextColumn: result.nextColumn, repeated: !fresh });
    this.recentTools = this.recentTools.slice(-4); return fresh;
  }
  snapshot(round, limit, appliedFiles) { return { taskId: this.id, round, limit, appliedFiles, noProgressRounds: this.stalls, changedFiles: [...this.changedFiles].slice(-4), recentTools: this.recentTools, ...(this.lastError ? { lastError: this.lastError.slice(0, 200) } : {}) }; }
  finishRound(fresh, history, appliedFiles) {
    this.stalls = fresh ? 0 : this.stalls + 1;
    if (!this.stalls) return;
    const note = 'No new evidence or applied changes in the last response. Do not restart the task or repeat unchanged requests. Reuse completed reads and hashes; use nextLine/nextColumn for more source. Correct the latest validation error, request genuinely missing evidence, or return done with the actual outcome.';
    if (history.length) history.at(-1).note = [history.at(-1).note, note].filter(Boolean).join(' ');
    if (this.stalls >= 2) { const error = new Error(`새로운 도구 결과나 파일 적용 없이 같은 요청·검증 실패가 반복되어 중지했습니다. 실제 적용한 파일: ${appliedFiles}개.${this.lastError ? ' 최근 원인: ' + this.lastError : ''}`); error.code = 'NO_PROGRESS'; throw error; }
  }
}
module.exports = { TaskProgress };
