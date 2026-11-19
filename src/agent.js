// @ts-check
'use strict';
const { buildPrompt, newId, normalizeToolCall, toolCallLimit } = require('./protocol');
const { inspectProject } = require('./project');
const { TaskProgress } = require('./task-progress');
const { commandEnvironment } = require('./terminal');
const { t } = require('./i18n');
/** @param {string | undefined} value @param {string} field @returns {string} */
function requiredText(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(t('errRequiredString', { field }));
  return value;
}

class CodingAgent {
  /** @param {import('../types/contracts').AgentOptions} options */
  constructor({
    store,
    transport,
    approveAndApply,
    runCommand,
    emit,
    conversation = [],
    mode = 'agent',
    intent,
    autoApprove = false,
    unlimitedRounds = false,
    maxRounds = 100,
    maxPromptCharacters = 120000,
    initialPaths,
    attachments = [],
    attachmentContext = [],
    mcp,
  }) {
    this.store = store;
    this.transport = transport;
    this.approveAndApply = approveAndApply;
    this.runCommand = runCommand;
    this.emit = emit;
    this.conversation = conversation;
    this.mode = mode;
    this.intent = intent;
    this.autoApprove = autoApprove === true;
    this.unlimitedRounds = unlimitedRounds === true;
    this.maxRounds = Number.isFinite(maxRounds) ? Math.max(1, Math.min(500, Math.floor(maxRounds))) : 100;
    this.maxPromptCharacters = maxPromptCharacters;
    this.initialPaths = initialPaths;
    this.attachments = attachments;
    this.attachmentContext = attachmentContext;
    this.mcp = mcp;
    this.cancelled = false;
    this.running = false;
  }
  async stop() {
    this.cancelled = true;
    this.mcp?.cancel();
    await this.transport.stop();
  }
  /** @param {string} task */
  async run(task, extraContext = '') {
    if (this.running) throw new Error(t('errTaskAlreadyRunning'));
    if (typeof task !== 'string' || !task.trim() || task.length > 8000)
      throw new Error(t('errTaskLengthRange'));
    this.running = true;
    this.cancelled = false;
    /** @type {import('../types/contracts').HistoryEntry[]} */
    const history = this.conversation
      .slice(-12)
      .map((event) => ({ role: event.role, text: event.text.slice(0, 4000) }));
    let promptBudget = Math.min(
      this.maxPromptCharacters,
      this.transport.promptCharacterLimit ?? this.maxPromptCharacters,
    );
    let appliedFiles = 0;
    const progress = new TaskProgress();
    let attachmentsSubmitted = false;
    try {
      this.emit({ type: 'message', role: 'user', text: task });
      const project = await inspectProject(
        this.store,
        task,
        promptBudget,
        this.emit,
        () => this.cancelled,
        this.initialPaths,
      );
      const files = project.files;
      history.push(project.history);
      if (project.discovered && !project.read && !project.inspected)
        throw new Error(t('errCouldNotReadProjectFiles'));
      this.emit({
        type: 'message',
        role: 'system',
        text: t('msgProjectInspectionSummary', {
          name: require('node:path').basename(this.store.root),
          discovered: project.discovered,
          read: project.read,
          inspectedNote: project.inspected
            ? t('msgProjectInspectedNote', { inspected: project.inspected })
            : '',
          readOnlyNote: this.mode !== 'agent' ? t('msgProjectReadOnlyNote') : '',
        }),
      });
      for (let round = 1; this.unlimitedRounds || round <= this.maxRounds; round++) {
        if (this.cancelled) throw new Error(t('errTaskStopped'));
        const id = newId();
        const limit = this.unlimitedRounds ? null : this.maxRounds;
        this.emit({
          type: 'progress',
          round,
          total: limit,
          remaining: this.unlimitedRounds ? null : this.maxRounds - round,
          unlimited: this.unlimitedRounds,
        });
        this.emit({
          type: 'status',
          text: this.unlimitedRounds
            ? t('statusPreparingRequestUnlimited', { round })
            : t('statusPreparingRequestLimited', { round, maxRounds: this.maxRounds }),
        });
        /** @type {import('../types/contracts').AgentReply | undefined} */
        let reply;
        for (let attempt = 0; attempt < 3; attempt++) {
          const prompt = buildPrompt({
            id,
            task,
            workspace: require('node:path').basename(this.store.root),
            environment: commandEnvironment(this.store.root),
            files,
            history,
            extraContext,
            attachments: this.attachmentContext,
            mode: this.mode,
            intent: this.intent,
            autoApprove: this.autoApprove,
            hasMcp: Boolean(this.mcp),
            progress: progress.snapshot(round, limit, appliedFiles),
            maxCharacters: promptBudget,
          });
          try {
            reply = await this.transport.request(
              prompt,
              id,
              (text) => this.emit({ type: 'status', text }),
              undefined,
              { attachments: attachmentsSubmitted ? [] : this.attachments },
            );
            attachmentsSubmitted = true;
            break;
          } catch (error) {
            if (
              this.cancelled ||
              attempt === 2 ||
              error.code !== 'PROMPT_LIMIT' ||
              error.notSubmitted !== true ||
              !Number.isFinite(error.maxCharacters) ||
              error.maxCharacters < 2000 ||
              error.maxCharacters >= prompt.length
            )
              throw error;
            promptBudget = Math.min(promptBudget, error.maxCharacters);
            this.emit({
              type: 'status',
              text: t('statusReducingContextForLimit', { limit: promptBudget.toLocaleString() }),
            });
          }
        }
        if (this.cancelled) throw new Error(t('errTaskStopped'));
        if (!reply) throw new Error(t('errNoCopilotResponse'));
        if (reply.kind === 'done') {
          this.emit({ type: 'message', role: 'assistant', text: reply.message });
          this.emit({
            type: 'message',
            role: 'system',
            text: t('msgActualAppliedFiles', {
              count: appliedFiles,
              zeroNote: appliedFiles === 0 ? t('msgZeroChangesNote') : '',
            }),
          });
          return { status: 'done', message: reply.message, appliedFiles };
        }
        if (reply.kind === 'tools') {
          if (reply.deferred?.length)
            this.emit({
              type: 'status',
              text: t('statusDeferredChangesForTools'),
            });
          /** @type {import('../types/contracts').ToolObservation[]} */
          const observations = [];
          let fresh = false;
          const batchLimit = toolCallLimit(promptBudget);
          for (const [index, rawCall] of reply.calls.entries()) {
            const call = normalizeToolCall(rawCall);
            if (this.cancelled) throw new Error(t('errTaskStopped'));
            if (index >= batchLimit) {
              observations.push({
                call,
                error: t('errToolBatchLimit', { limit: batchLimit }),
              });
              continue;
            }
            const toolId = newId();
            const label = `${call.name} · ${call.path || call.query || call.command || call.tool || t('toolTargetProject')}`;
            this.emit({ type: 'tool', id: toolId, label, state: 'running' });
            try {
              /** @type {import('../types/contracts').ToolResult} */
              let result;
              const resultBudget = Math.max(
                256,
                Math.min(6000, Math.floor((promptBudget - 3500) / Math.min(batchLimit, reply.calls.length))),
              );
              if (call.name === 'read_file')
                result = await this.store.readFile(requiredText(call.path, 'path'), {
                  startLine: call.startLine,
                  startColumn: call.startColumn,
                  lineCount: call.lineCount,
                  maxCharacters: resultBudget,
                });
              else if (call.name === 'file_info')
                result = await this.store.fileInfo(requiredText(call.path, 'path'), () => this.cancelled);
              else if (call.name === 'folder_info')
                result = await this.store.folderInfo(requiredText(call.path, 'path'), () => this.cancelled);
              else if (call.name === 'list_files') result = await this.store.listFiles(call.limit, call.path);
              else if (call.name === 'search_text')
                result = await this.store.search(
                  requiredText(call.query, 'query'),
                  call.paths,
                  () => this.cancelled,
                );
              else if (call.name === 'search_code')
                result = await this.store.searchCode(
                  requiredText(call.query, 'query'),
                  call.paths,
                  () => this.cancelled,
                );
              else if (call.name === 'run_command') {
                if (this.mode !== 'agent' || !this.runCommand)
                  throw new Error(t('errReadOnlyNoCommands'));
                result = await this.runCommand(requiredText(call.command, 'command'));
              } else if (['mcp_list_tools', 'mcp_tool_info', 'mcp_call'].includes(call.name)) {
                if (this.mode !== 'agent' || !this.mcp) throw new Error(t('errMcpOnlyInAgentMode'));
                if (call.name === 'mcp_list_tools') result = this.mcp.list(resultBudget, call.offset);
                else if (call.name === 'mcp_tool_info')
                  result = this.mcp.info(requiredText(call.tool, 'tool'), resultBudget);
                else {
                  if (!call.input) throw new Error(t('errMcpInputObjectRequired'));
                  result = await this.mcp.invoke(requiredText(call.tool, 'tool'), call.input, resultBudget);
                }
              } else throw new Error(t('errUnsupportedTool'));
              if (Array.isArray(result.files))
                while (JSON.stringify(result).length > resultBudget && result.files.length > 1) {
                  result.files.pop();
                  result.truncated = true;
                }
              if (Array.isArray(result.matches))
                while (JSON.stringify(result).length > resultBudget && result.matches.length > 1) {
                  result.matches.pop();
                  result.truncated = true;
                }
              if (typeof result.output === 'string' && result.output.length > resultBudget) {
                result.output = result.output.slice(-resultBudget);
                result.truncated = true;
              }
              if (JSON.stringify(result).length > 22000) throw new Error(t('errToolResultTooLarge'));
              observations.push({ call, result });
              fresh = progress.observe(call, result) || fresh;
              const failed = result.exitCode !== undefined && result.exitCode !== 0;
              this.emit({
                type: 'tool',
                id: toolId,
                label,
                state: failed ? 'error' : 'done',
                detail:
                  typeof result.content === 'string'
                    ? t('toolDetailReadLines', {
                        chars: result.content.length.toLocaleString(),
                        startLine: result.startLine,
                        endLine: result.endLine,
                      })
                    : ['file_info', 'folder_info'].includes(call.name) && result.size !== undefined
                      ? t('toolDetailHashVerified', { size: result.size.toLocaleString() })
                      : result.approved === false
                        ? t('toolDetailExecutionRejected')
                        : result.exitCode !== undefined
                          ? t('toolDetailExitCode', {
                              exitCode: result.exitCode,
                              timedOutNote: result.timedOut ? t('toolDetailTimedOutNote') : '',
                            })
                          : undefined,
              });
            } catch (error) {
              if (this.cancelled || ['MCP_CANCELLED', 'MCP_UNCERTAIN'].includes(error.code)) throw error;
              observations.push({ call, error: error.message });
              fresh = progress.failure(error) || fresh;
              this.emit({ type: 'tool', id: toolId, label, state: 'error', detail: error.message });
            }
          }
          history.push({
            kind: 'tool_results',
            observations,
            ...(reply.deferred?.length
              ? {
                  note: 'Premature changes/done in the same response were NOT applied. Re-propose needed changes using these actual results and hashes; return done only after local outcomes.',
                }
              : {}),
          });
          progress.finishRound(fresh, history, appliedFiles);
          continue;
        }
        if (reply.kind === 'changes') {
          let fresh = false;
          try {
            if (this.mode !== 'agent') throw new Error(t('errReadOnlyNoFileEdits'));
            const changes = (await this.store.prepareChanges(reply.files, () => this.cancelled)).filter(
              (change) =>
                change.action === 'create' ||
                change.action === 'delete' ||
                change.content !== change.original,
            );
            if (!changes.length) {
              /** @type {Error & { code?: string }} */
              const error = new Error(t('errChangesIdentical'));
              error.code = 'UNCHANGED_CHANGES';
              throw error;
            }
            this.emit({
              type: 'message',
              role: 'assistant',
              text: reply.summary || t('defaultChangeSummary'),
            });
            if (!this.approveAndApply) throw new Error(t('errChangeApplierNotConnected'));
            const applied = await this.approveAndApply(changes, reply.summary || t('defaultChangeTitle'));
            if (applied) {
              appliedFiles += changes.length;
              fresh = true;
              progress.lastError = undefined;
              progress.recordChanges(changes);
            }
            if (this.cancelled) throw new Error(t('errTaskStopped'));
            history.push({
              kind: 'change_result',
              applied,
              files: changes.map((change) => change.path),
              deletedFiles: changes
                .filter((change) => change.action === 'delete')
                .map((change) => change.path),
              tests: 'not_run',
            });
            if (!applied) return { status: 'rejected' };
          } catch (error) {
            if (this.cancelled || error.code === 'PARTIAL_DELETE') throw error;
            this.emit({
              type: 'message',
              role: 'system',
              text: t('msgProposalValidation', { message: error.message }),
            });
            fresh = progress.failure(error);
            history.push({
              kind: 'change_error',
              error: error.message,
              nextStep:
                'Correct the proposal using actual read_file, file_info (files) or folder_info (folders) evidence. Existing files need read evidence; create requires baseHash=null and must not overwrite an existing file.',
            });
            if (this.mode === 'agent') {
              const paths = [
                ...new Set(
                  (Array.isArray(reply.files) ? reply.files : [])
                    .filter((file) => file && typeof file.path === 'string')
                    .map((file) => file.path),
                ),
              ]
                .filter((file) => !progress.repaired.has(file))
                .slice(0, 2);
              /** @type {import('../types/contracts').ToolObservation[]} */
              const observations = [];
              for (const path of paths) {
                if (this.cancelled) throw new Error(t('errTaskStopped'), { cause: error });
                progress.repaired.add(path);
                const id = newId();
                const autoVerifyLabel = t('toolAutoVerifyTarget', { path });
                this.emit({ type: 'tool', id, label: autoVerifyLabel, state: 'running' });
                const deleting = reply.files.some((file) => file?.path === path && file.action === 'delete');
                const call = deleting
                  ? { name: 'file_info', path }
                  : { name: 'read_file', path, startLine: 1, lineCount: 120 };
                try {
                  /** @type {import('../types/contracts').ToolResult} */
                  const result = deleting
                    ? await this.store.deletionInfo(path, () => this.cancelled)
                    : await this.store.readFile(path, {
                        startLine: 1,
                        lineCount: 120,
                        maxCharacters: Math.max(
                          256,
                          Math.min(3000, Math.floor((promptBudget - 4000) / paths.length)),
                        ),
                      });
                  if (deleting) call.name = result.kind === 'directory' ? 'folder_info' : 'file_info';
                  observations.push({ call, result });
                  fresh = progress.observe(call, result) || fresh;
                  this.emit({
                    type: 'tool',
                    id,
                    label: autoVerifyLabel,
                    state: 'done',
                    detail: t('toolAutoVerifyDetail', {
                      sizeInfo: deleting ? result.size + ' bytes' : (result.content || '').length + ' chars',
                    }),
                  });
                } catch (readError) {
                  observations.push({ call, error: readError.message });
                  this.emit({
                    type: 'tool',
                    id,
                    label: autoVerifyLabel,
                    state: 'error',
                    detail: readError.message,
                  });
                }
              }
              if (observations.length)
                history.push({ kind: 'tool_results', origin: 'proposal_validation_repair', observations });
            }
          }
          progress.finishRound(fresh, history, appliedFiles);
        }
      }
      throw new Error(t('errMaxRoundsReached', { maxRounds: this.maxRounds, appliedFiles }));
    } finally {
      this.attachments = [];
      this.mcp?.dispose();
      this.running = false;
      this.emit({ type: 'idle' });
    }
  }
}
module.exports = { CodingAgent };
