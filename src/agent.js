'use strict';
const { buildPrompt, newId, normalizeToolCall, toolCallLimit } = require('./protocol');
const { inspectProject } = require('./project');
const { TaskProgress } = require('./task-progress');

class CodingAgent {
  constructor({ store, transport, approveAndApply, runCommand, emit, conversation = [], mode = 'agent', intent, maxRounds = 20, maxPromptCharacters = 12000 }) {
    Object.assign(this, { store, transport, approveAndApply, runCommand, emit, conversation, mode, intent, maxRounds, maxPromptCharacters });
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
    let promptBudget = Math.min(this.maxPromptCharacters, this.transport.promptCharacterLimit ?? this.maxPromptCharacters);
    let appliedFiles = 0;
    const progress = new TaskProgress();
    try {
      this.emit({ type: 'message', role: 'user', text: task });
      const project = await inspectProject(this.store, task, promptBudget, this.emit, () => this.cancelled);
      const files = project.files;
      history.push(project.history);
      if (project.discovered && !project.read) throw new Error('프로젝트 파일 본문을 읽지 못했습니다. 작업 기록의 파일별 오류를 확인하세요. 분석이나 수정이 완료된 것으로 처리하지 않았습니다.');
      this.emit({ type: 'message', role: 'system', text: `프로젝트 ${require('node:path').basename(this.store.root)} · ${project.discovered}개 파일 발견 · ${project.read}개 본문을 먼저 읽었습니다.${this.mode !== 'agent' ? ' 이번 요청은 분석·계획으로 처리하며 파일을 수정하지 않습니다.' : ''}` });
      for (let round = 1; round <= this.maxRounds; round++) {
        if (this.cancelled) throw new Error('작업을 중지했습니다.');
        const id = newId();
        this.emit({ type: 'progress', round, total: this.maxRounds, remaining: this.maxRounds - round });
        this.emit({ type: 'status', text: `진행 ${round}/${this.maxRounds} · 이후 ${this.maxRounds - round}회 · Copilot 요청 준비` });
        let reply;
        for (let attempt = 0; attempt < 3; attempt++) {
          const prompt = buildPrompt({ id, task, workspace: require('node:path').basename(this.store.root), files,
            history, extraContext, mode: this.mode, intent: this.intent, progress: progress.snapshot(round, this.maxRounds, appliedFiles), maxCharacters: promptBudget });
          try {
            reply = await this.transport.request(prompt, id, text => this.emit({ type: 'status', text }));
            break;
          } catch (error) {
            if (this.cancelled || attempt === 2 || error.code !== 'PROMPT_LIMIT' || error.notSubmitted !== true || !Number.isFinite(error.maxCharacters) || error.maxCharacters < 2000 || error.maxCharacters >= prompt.length) throw error;
            promptBudget = Math.min(promptBudget, error.maxCharacters);
            this.emit({ type: 'status', text: `Copilot 입력 한도 ${promptBudget.toLocaleString()}자에 맞춰 문맥을 줄이고 있습니다. 아직 전송하지 않았습니다.` });
          }
        }
        if (this.cancelled) throw new Error('작업을 중지했습니다.');
        if (reply.kind === 'done') {
          this.emit({ type: 'message', role: 'assistant', text: reply.message });
          this.emit({ type: 'message', role: 'system', text: `이번 요청에서 실제 적용한 파일: ${appliedFiles}개${appliedFiles === 0 ? ' · 파일 변경은 발생하지 않았습니다.' : ''}` });
          return { status: 'done', message: reply.message, appliedFiles };
        }
        if (reply.kind === 'tools') {
          if (reply.deferred?.length) this.emit({ type: 'status', text: '도구 요청을 먼저 처리합니다. 함께 온 수정안은 도구 결과 확인 뒤 다시 받습니다.' });
          const observations = [];
          let fresh = false;
          const batchLimit = toolCallLimit(promptBudget);
          for (const [index, rawCall] of reply.calls.entries()) {
            const call = normalizeToolCall(rawCall);
            if (this.cancelled) throw new Error('작업을 중지했습니다.');
            if (index >= batchLimit) { observations.push({ call, error: `이번 요청의 도구 예산은 ${batchLimit}개입니다. 이 호출은 실행하지 않았습니다. 결과를 확인한 뒤 다음 요청에서 다시 호출하세요.` }); continue; }
            const toolId = newId();
            const label = `${call.name} · ${call.path || call.query || call.command || '프로젝트'}`;
            this.emit({ type: 'tool', id: toolId, label, state: 'running' });
            try {
              let result;
              const resultBudget = Math.max(256, Math.min(6000, Math.floor((promptBudget - 3500) / Math.min(batchLimit, reply.calls.length))));
              if (call.name === 'read_file') result = await this.store.readFile(call.path, { startLine: call.startLine, startColumn: call.startColumn, lineCount: call.lineCount, maxCharacters: resultBudget });
              else if (call.name === 'list_files') result = await this.store.listFiles(call.limit, call.path);
              else if (call.name === 'search_text') result = await this.store.search(call.query, call.paths);
              else if (call.name === 'run_command') {
                if (this.mode !== 'agent' || !this.runCommand) throw new Error('이번 요청은 읽기 전용 분석입니다. 명령 실행이 필요하면 실행할 작업을 요청하세요.');
                result = await this.runCommand(call.command);
              }
              else throw new Error('지원하지 않는 도구입니다.');
              if (Array.isArray(result.files)) while (JSON.stringify(result).length > resultBudget && result.files.length > 1) { result.files.pop(); result.truncated = true; }
              if (Array.isArray(result.matches)) while (JSON.stringify(result).length > resultBudget && result.matches.length > 1) { result.matches.pop(); result.truncated = true; }
              if (typeof result.output === 'string' && result.output.length > resultBudget) { result.output = result.output.slice(-resultBudget); result.truncated = true; }
              if (JSON.stringify(result).length > 22000) throw new Error('파일 또는 검색 결과가 너무 큽니다. 더 작은 파일이나 검색 범위를 요청하세요.');
              observations.push({ call, result });
              fresh = progress.observe(call, result) || fresh;
              const failed = result.exitCode !== undefined && result.exitCode !== 0;
              this.emit({ type: 'tool', id: toolId, label, state: failed ? 'error' : 'done', detail: typeof result.content === 'string' ? `${result.content.length.toLocaleString()}자 읽음 · ${result.startLine}~${result.endLine}줄` : result.approved === false ? '실행 거절됨' : result.exitCode !== undefined ? `종료 코드 ${result.exitCode}${result.timedOut ? ' · 시간 초과' : ''}` : undefined });
            } catch (error) {
              if (this.cancelled) throw error;
              observations.push({ call, error: error.message });
              fresh = progress.failure(error) || fresh;
              this.emit({ type: 'tool', id: toolId, label, state: 'error', detail: error.message });
            }
          }
          history.push({ kind: 'tool_results', observations, ...(reply.deferred?.length ? { note: 'Premature changes/done in the same response were NOT applied. Re-propose needed changes using these actual results and hashes; return done only after local outcomes.' } : {}) });
          progress.finishRound(fresh, history, appliedFiles);
          continue;
        }
        if (reply.kind === 'changes') {
          let fresh = false;
          try {
            if (this.mode !== 'agent') throw new Error('이번 요청은 분석·계획이므로 파일을 수정하지 않습니다. 설명 또는 계획으로 답변하세요.');
            const changes = await this.store.prepareChanges(reply.files);
            this.emit({ type: 'message', role: 'assistant', text: reply.summary || '파일 수정안을 준비했습니다.' });
            const applied = await this.approveAndApply(changes, reply.summary || '파일 수정안');
            if (applied) { appliedFiles += changes.length; fresh = true; progress.lastError = undefined; for (const change of changes) progress.changedFiles.add(change.path); }
            if (this.cancelled) throw new Error('작업을 중지했습니다.');
            history.push({ kind: 'change_result', applied, files: changes.map(change => change.path), tests: 'not_run' });
            if (!applied) return { status: 'rejected' };
          } catch (error) {
            if (this.cancelled) throw error;
            this.emit({ type: 'message', role: 'system', text: `수정안 검증: ${error.message}` });
            fresh = progress.failure(error);
            history.push({ kind: 'change_error', error: error.message, nextStep: 'Correct the proposal using actual read_file hashes/content. Existing files need read evidence; create requires baseHash=null and must not overwrite an existing file.' });
            if (this.mode === 'agent') {
              const paths = [...new Set((Array.isArray(reply.files) ? reply.files : []).filter(file => file && typeof file.path === 'string').map(file => file.path))].filter(file => !progress.repaired.has(file)).slice(0, 2);
              const observations = [];
              for (const path of paths) {
                if (this.cancelled) throw new Error('작업을 중지했습니다.', { cause: error });
                progress.repaired.add(path); const id = newId();
                this.emit({ type: 'tool', id, label: '수정 대상 자동 확인 · ' + path, state: 'running' });
                const call = { name: 'read_file', path, startLine: 1, lineCount: 120 };
                try {
                  const result = await this.store.readFile(path, { startLine: 1, lineCount: 120, maxCharacters: Math.max(256, Math.min(3000, Math.floor((promptBudget - 4000) / paths.length))) });
                  observations.push({ call, result }); fresh = progress.observe(call, result) || fresh;
                  this.emit({ type: 'tool', id, label: '수정 대상 자동 확인 · ' + path, state: 'done', detail: `${result.content.length}자 · 실제 hash 확인. 검증한 새 수정안을 요청합니다.` });
                } catch (readError) { observations.push({ call, error: readError.message }); this.emit({ type: 'tool', id, label: '수정 대상 자동 확인 · ' + path, state: 'error', detail: readError.message }); }
              }
              if (observations.length) history.push({ kind: 'tool_results', origin: 'proposal_validation_repair', observations });
            }
          }
          progress.finishRound(fresh, history, appliedFiles);
        }
      }
      throw new Error('최대 요청 횟수에 도달했습니다. 작업 범위를 줄여 다시 요청하세요.');
    } finally { this.running = false; this.emit({ type: 'idle' }); }
  }
}
module.exports = { CodingAgent };
