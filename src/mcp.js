// @ts-check
'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { t } = require('./i18n');
/** @typedef {import('../types/contracts').McpSession} McpSession */
/** @typedef {{name: string, fingerprint: string}} Selection */
/** @typedef {{name: string, description: string, inputSchema: object, fingerprint: string}} Tool */
/** @typedef {{context: {workspaceState: Pick<import('vscode').Memento, 'get' | 'update'>}, starting?: boolean, switchingBrowser?: boolean, sessionSwitching?: boolean, agent?: {running: boolean} | null, stopRequested?: boolean, pending: {kind: 'command' | 'changes', resolve: (approved: boolean) => void, viewData: import('../types/contracts').HostEvent} | null, post(event: import('../types/contracts').HostEvent): void}} McpHost */

/** Bounded JSON shared by tool metadata and untrusted model arguments.
 * @param {unknown} value @param {number} [maxCharacters] */
function jsonValue(value, maxCharacters = 12000) {
  let entries = 0;
  /** @param {unknown} item @param {number} depth @returns {unknown} */
  const copy = (item, depth) => {
    if (++entries > 2000 || depth > 20) throw new Error(t('errMcpJsonTooLarge'));
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => copy(child, depth + 1));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, copy(/** @type {Record<string, unknown>} */ (item)[key], depth + 1)]),
      );
    throw new Error(t('errMcpArgsJsonOnly'));
  };
  const result = copy(value, 0);
  if (JSON.stringify(result).length > maxCharacters) throw new Error(t('errMcpJsonSizeLimitExceeded'));
  return result;
}
/** The public API exposes no trustworthy read-only capability flag. This is a
 * conservative name filter, never a sandbox or proof of a server's behaviour.
 * @param {string} name */
function lookupName(name) {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return (
    words.some((word) =>
      /^(get|list|search|find|fetch|read|lookup|query|resolve|describe|inspect|status|count|retrieve|docs|documentation|snapshot)$/.test(
        word,
      ),
    ) &&
    !words.some((word) =>
      /^(write|edit|delete|remove|rename|move|copy|create|update|patch|replace|execute|exec|run|push|commit|apply|send|upload|insert|upsert|drop|alter)$/.test(
        word,
      ),
    )
  );
}
/** @param {string} message @param {string} code */
function mcpError(message, code) {
  return Object.assign(new Error(message), { code });
}

class McpBridge {
  /** @param {McpHost} host @param {typeof import('vscode')} vscode @param {number} [timeoutMs] */
  constructor(host, vscode, timeoutMs = 120000) {
    this.host = host;
    this.vscode = vscode;
    this.timeoutMs = timeoutMs;
    /** @type {McpSession | undefined} */
    this.active = undefined;
  }
  available() {
    /** @type {Tool[]} */
    const result = [];
    for (const tool of this.vscode.lm?.tools || []) {
      if (!tool.tags.includes('mcp') || tool.name.length > 200 || !lookupName(tool.name)) continue;
      try {
        const schema = jsonValue(tool.inputSchema || { type: 'object', properties: {} }, 5000);
        if (!schema || typeof schema !== 'object' || Array.isArray(schema) || tool.description.length > 4000)
          continue;
        const fingerprint = createHash('sha256')
          .update(JSON.stringify([tool.name, tool.description, schema]))
          .digest('hex');
        result.push({ name: tool.name, description: tool.description, inputSchema: schema, fingerprint });
      } catch {
        /* Oversized or non-JSON schemas are not advertised. */
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  selected() {
    const value = this.host.context.workspaceState?.get('mcp.lookupTools', /** @type {unknown} */ ([]));
    return /** @type {Selection[]} */ (
      Array.isArray(value)
        ? value
            .filter(
              (item) =>
                item &&
                typeof item.name === 'string' &&
                typeof item.fingerprint === 'string' &&
                /^[a-f0-9]{64}$/.test(item.fingerprint),
            )
            .slice(0, 20)
        : []
    );
  }
  async select() {
    if (
      this.host.starting ||
      this.host.switchingBrowser ||
      this.host.sessionSwitching ||
      this.host.agent?.running
    )
      throw new Error(t('errSelectMcpAfterTask'));
    if (!this.vscode.workspace.isTrusted) throw new Error(t('errMcpTrustedWorkspaceOnly'));
    const tools = this.available(),
      selected = this.selected();
    if (!tools.length) {
      void this.vscode.window.showInformationMessage(t('infoNoLookupMcpTools'));
      return;
    }
    const picks = await this.vscode.window.showQuickPick(
      tools.map((tool) => ({
        label: tool.name,
        detail: tool.description.slice(0, 300),
        picked: selected.some((item) => item.name === tool.name && item.fingerprint === tool.fingerprint),
        tool,
      })),
      {
        canPickMany: true,
        title: t('pickMcpTitle'),
        placeHolder: t('pickMcpPlaceholder'),
      },
    );
    if (!picks) return;
    if (picks.length > 20) throw new Error(t('errMcpMax20Tools'));
    if (this.host.starting || this.host.agent?.running || !this.vscode.workspace.isTrusted)
      throw new Error(t('errMcpSelectionStateChanged'));
    await this.host.context.workspaceState.update(
      'mcp.lookupTools',
      picks.map((item) => ({ name: item.tool.name, fingerprint: item.tool.fingerprint })),
    );
    this.host.post({
      type: 'status',
      text: t('statusMcpToolsSelected', { count: picks.length }),
    });
  }
  /** @param {string} root @param {string} mode @returns {McpSession | undefined} */
  createSession(root, mode) {
    if (mode !== 'agent' || !this.vscode.workspace.isTrusted || !this.vscode.lm?.invokeTool) return;
    const selected = this.selected();
    const tools = new Map(
      this.available()
        .filter((tool) =>
          selected.some((item) => item.name === tool.name && item.fingerprint === tool.fingerprint),
        )
        .map((tool) => [tool.name, tool]),
    );
    if (!tools.size) return;
    let stopped = false;
    /** @type {string | undefined} */
    let pendingToken;
    /** @type {(() => void) | undefined} */
    let cancelInvocation;
    const advertised = new Set(),
      failed = new Set();
    /** @param {string} name */
    const current = (name) => {
      const tool = tools.get(name);
      if (stopped || this.host.stopRequested) throw mcpError(t('errMcpCancelled'), 'MCP_CANCELLED');
      if (
        !this.vscode.workspace.isTrusted ||
        !tool ||
        !this.selected().some((item) => item.name === name && item.fingerprint === tool.fingerprint) ||
        !this.available().some((item) => item.name === name && item.fingerprint === tool.fingerprint)
      )
        throw new Error(t('errMcpNotAllowedOrChanged'));
      return tool;
    };
    /** @type {McpSession} */
    const session = {
      list: (maxCharacters, offset = 0) => {
        if (!Number.isInteger(offset) || offset < 0 || offset > tools.size)
          throw new Error(t('errMcpOffsetInvalid'));
        const result = {
          tools: /** @type {{name: string, description: string}[]} */ ([]),
          truncated: false,
          nextOffset: /** @type {number | null} */ (null),
        };
        for (const tool of [...tools.values()].slice(offset)) {
          current(tool.name);
          result.tools.push({ name: tool.name, description: tool.description.slice(0, 200) });
          const next = offset + result.tools.length;
          result.nextOffset = next < tools.size ? next : null;
          if (JSON.stringify(result).length > maxCharacters) {
            result.tools.pop();
            result.truncated = true;
            result.nextOffset = offset + result.tools.length;
            break;
          }
          advertised.add(tool.name);
        }
        if (!result.tools.length && offset < tools.size) throw new Error(t('errMcpListBudgetInsufficient'));
        return result;
      },
      info: (name, maxCharacters) => {
        const tool = current(name);
        const result = { name, description: tool.description.slice(0, 300), inputSchema: tool.inputSchema };
        if (JSON.stringify(result).length > maxCharacters) throw new Error(t('errMcpSchemaTooLarge'));
        advertised.add(name);
        return result;
      },
      invoke: async (name, input, maxCharacters) => {
        current(name);
        if (!advertised.has(name)) throw new Error(t('errMcpInspectFirst'));
        const safeInput = /** @type {Record<string, unknown>} */ (jsonValue(input));
        if (!safeInput || typeof safeInput !== 'object' || Array.isArray(safeInput))
          throw new Error(t('errMcpInputMustBeObject'));
        const signature = JSON.stringify([name, safeInput]);
        if (failed.has(signature)) throw new Error(t('errMcpDuplicateFailedCall'));
        if (this.host.pending) throw new Error(t('errHandleOtherApprovalFirst'));
        const viewData = {
          type: 'commandApproval',
          approvalKind: 'mcp',
          tool: name,
          command: JSON.stringify(safeInput, null, 2),
          root,
          changedFiles: [],
          token: randomUUID(),
        };
        pendingToken = viewData.token;
        const approved = await new Promise((resolve) => {
          this.host.pending = { kind: 'command', resolve, viewData };
          this.host.post(viewData);
        });
        const pending = /** @type {McpHost['pending']} */ (this.host.pending);
        if (pending?.viewData.token === viewData.token) this.host.pending = null;
        pendingToken = undefined;
        this.host.post({ type: 'approvalClosed' });
        current(name);
        if (!approved) {
          failed.add(signature);
          return {
            approved: false,
            message: t('msgMcpRejectedByUser'),
          };
        }
        const cancellation = new this.vscode.CancellationTokenSource();
        /** @type {NodeJS.Timeout | undefined} */
        let timer;
        const interrupted = new Promise((_, reject) => {
          cancelInvocation = () => {
            cancellation.cancel();
            reject(mcpError(t('errMcpCancelledRemoteWarning'), 'MCP_CANCELLED'));
          };
          timer = setTimeout(() => {
            stopped = true;
            cancellation.cancel();
            reject(mcpError(t('errMcpTimedOut'), 'MCP_UNCERTAIN'));
          }, this.timeoutMs);
        });
        try {
          const result = await Promise.race([
            this.vscode.lm.invokeTool(
              name,
              { input: safeInput, toolInvocationToken: undefined },
              cancellation.token,
            ),
            interrupted,
          ]);
          current(name);
          if (
            !result ||
            typeof result !== 'object' ||
            !('content' in result) ||
            !Array.isArray(result.content)
          )
            throw new Error(t('errMcpResultInvalid'));
          let output = '',
            omittedParts = Math.max(0, result.content.length - 100),
            truncated = false;
          for (const part of result.content.slice(0, 100)) {
            if (!(part instanceof this.vscode.LanguageModelTextPart)) {
              omittedParts++;
              continue;
            }
            const room = Math.max(0, maxCharacters - output.length - 160);
            if (part.value.length + 1 > room) truncated = true;
            if (room > 0) output += (output ? '\n' : '') + part.value.slice(0, room);
          }
          const observation = {
            approved: true,
            output,
            truncated: truncated || omittedParts > 0,
            omittedParts,
          };
          while (JSON.stringify(observation).length > maxCharacters && observation.output.length) {
            observation.output = observation.output.slice(0, Math.floor(observation.output.length / 2));
            observation.truncated = true;
          }
          return observation;
        } catch (error) {
          failed.add(signature);
          throw error;
        } finally {
          clearTimeout(timer);
          cancelInvocation = undefined;
          cancellation.dispose();
        }
      },
      cancel: () => {
        stopped = true;
        cancelInvocation?.();
        if (pendingToken && this.host.pending?.viewData.token === pendingToken) {
          this.host.pending.resolve(false);
          this.host.pending = null;
          this.host.post({ type: 'approvalClosed' });
        }
      },
      dispose: () => {
        session.cancel();
        if (this.active === session) this.active = undefined;
      },
    };
    this.active = session;
    return session;
  }
  cancel() {
    this.active?.cancel();
  }
}
module.exports = { McpBridge, jsonValue, lookupName };
