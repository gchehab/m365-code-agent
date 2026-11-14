'use strict';
const { buildPrompt, newId } = require('./protocol');

class CodingAgent {
  constructor({ store, transport, approveAndApply, emit, maxRounds = 12, maxPromptCharacters = 48000 }) {
    Object.assign(this, { store, transport, approveAndApply, emit, maxRounds, maxPromptCharacters });
    this.cancelled = false;
    this.running = false;
  }
  async stop() { this.cancelled = true; await this.transport.stop(); }
  async run(task, extraContext = '') {
    if (this.running) throw new Error('이미 진행 중인 작업이 있습니다.');
    if (typeof task !== 'string' || !task.trim() || task.length > 8000) throw new Error('요청은 1~8,000자로 입력하세요.');
    this.running = true;
    this.cancelled = false;
    const history = [];
    try {
      const files = await this.store.listFiles(250);
      this.emit({ type: 'message', role: 'user', text: task });
      for (let round = 1; round <= this.maxRounds; round++) {
        if (this.cancelled) throw new Error('작업을 중지했습니다.');
        const id = newId();
        this.emit({ type: 'status', text: `진행 ${round}/${this.maxRounds} · Copilot 요청 준비` });
        const prompt = buildPrompt({ id, task, workspace: require('node:path').basename(this.store.root), files,
          history: history.slice(-6), extraContext, maxCharacters: this.maxPromptCharacters });
        const reply = await this.transport.request(prompt, id, text => this.emit({ type: 'status', text }));
        if (this.cancelled) throw new Error('작업을 중지했습니다.');
        if (reply.kind === 'done') {
          this.emit({ type: 'message', role: 'assistant', text: reply.message });
          return { status: 'done', message: reply.message };
        }
        if (reply.kind === 'tools') {
          const observations = [];
          for (const call of reply.calls) {
            if (this.cancelled) throw new Error('작업을 중지했습니다.');
            this.emit({ type: 'status', text: `프로젝트 읽기 · ${call.name} ${call.path || call.query || ''}` });
            try {
              let result;
              if (call.name === 'read_file') result = await this.store.readFile(call.path);
              else if (call.name === 'list_files') result = await this.store.listFiles(call.limit);
              else if (call.name === 'search_text') result = await this.store.search(call.query, call.paths);
              else throw new Error('지원하지 않는 도구입니다.');
              if (JSON.stringify(result).length > 22000) throw new Error('파일 또는 검색 결과가 너무 큽니다. 더 작은 파일이나 검색 범위를 요청하세요.');
              observations.push({ call, result });
            } catch (error) { observations.push({ call, error: error.message }); }
          }
          history.push({ kind: 'tool_results', observations });
          continue;
        }
        if (reply.kind === 'changes') {
          try {
            const changes = await this.store.prepareChanges(reply.files);
            this.emit({ type: 'message', role: 'assistant', text: reply.summary || '파일 수정안을 준비했습니다.' });
            const applied = await this.approveAndApply(changes, reply.summary || '파일 수정안');
            if (this.cancelled) throw new Error('작업을 중지했습니다.');
            history.push({ kind: 'change_result', applied, files: changes.map(change => change.path), tests: 'not_run' });
            if (!applied) return { status: 'rejected' };
          } catch (error) {
            if (this.cancelled) throw error;
            this.emit({ type: 'message', role: 'system', text: `수정안 검증: ${error.message}` });
            history.push({ kind: 'change_error', error: error.message });
          }
        }
      }
      throw new Error('최대 요청 횟수에 도달했습니다. 작업 범위를 줄여 다시 요청하세요.');
    } finally { this.running = false; this.emit({ type: 'idle' }); }
  }
}
module.exports = { CodingAgent };
