'use strict';
const { buildPrompt, newId } = require('./protocol');

class CodingAgent {
  constructor({ store, transport, approveAndApply, runCommand, emit, conversation = [], mode = 'agent', maxRounds = 12, maxPromptCharacters = 48000 }) {
    Object.assign(this, { store, transport, approveAndApply, runCommand, emit, conversation, mode, maxRounds, maxPromptCharacters });
    this.cancelled = false;
    this.running = false;
  }
  async stop() { this.cancelled = true; await this.transport.stop(); }
  async run(task, extraContext = '') {
    if (this.running) throw new Error('이미 진행 중인 작업이 있습니다.');
    if (typeof task !== 'string' || !task.trim() || task.length > 8000) throw new Error('요청은 1~8,000자로 입력하세요.');
    this.running = true;
    this.cancelled = false;
    const history = this.conversation.slice(-12).map(event => ({ role: event.role, text: event.text.slice(0, 4000) }));
    try {
      const files = await this.store.listFiles(250);
      this.emit({ type: 'message', role: 'user', text: task });
      for (let round = 1; round <= this.maxRounds; round++) {
        if (this.cancelled) throw new Error('작업을 중지했습니다.');
        const id = newId();
        this.emit({ type: 'status', text: `진행 ${round}/${this.maxRounds} · Copilot 요청 준비` });
        const recentHistory = history.slice(-8);
        let prompt;
        while (true) {
          try {
            prompt = buildPrompt({ id, task, workspace: require('node:path').basename(this.store.root), files,
              history: recentHistory, extraContext, mode: this.mode, maxCharacters: this.maxPromptCharacters });
            break;
          } catch (error) {
            if (recentHistory.length <= 1) throw error;
            recentHistory.shift();
          }
        }
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
            const toolId = newId();
            const label = `${call.name} · ${call.path || call.query || call.command || '프로젝트'}`;
            this.emit({ type: 'tool', id: toolId, label, state: 'running' });
            try {
              let result;
              if (call.name === 'read_file') result = await this.store.readFile(call.path);
              else if (call.name === 'list_files') result = await this.store.listFiles(call.limit);
              else if (call.name === 'search_text') result = await this.store.search(call.query, call.paths);
              else if (call.name === 'run_command') {
                if (this.mode !== 'agent' || !this.runCommand) throw new Error('명령 실행은 Agent 모드에서만 사용할 수 있습니다.');
                result = await this.runCommand(call.command);
              }
              else throw new Error('지원하지 않는 도구입니다.');
              if (JSON.stringify(result).length > 22000) throw new Error('파일 또는 검색 결과가 너무 큽니다. 더 작은 파일이나 검색 범위를 요청하세요.');
              observations.push({ call, result });
              const failed = result.exitCode !== undefined && result.exitCode !== 0;
              this.emit({ type: 'tool', id: toolId, label, state: failed ? 'error' : 'done', detail: result.approved === false ? '실행 거절됨' : result.exitCode !== undefined ? `종료 코드 ${result.exitCode}${result.timedOut ? ' · 시간 초과' : ''}` : undefined });
            } catch (error) {
              if (this.cancelled) throw error;
              observations.push({ call, error: error.message });
              this.emit({ type: 'tool', id: toolId, label, state: 'error', detail: error.message });
            }
          }
          history.push({ kind: 'tool_results', observations });
          continue;
        }
        if (reply.kind === 'changes') {
          try {
            if (this.mode !== 'agent') throw new Error('Ask·Plan 모드에서는 파일을 수정할 수 없습니다. 설명 또는 계획으로 답변하세요.');
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
