'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { validateCopilotUrl } = require('./browser');
const { conversationUrl } = require('./web-history');
const { t } = require('./i18n');

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const markerPattern = () =>
  new RegExp(
    `^\\[m365-chat:(${uuid}):(${uuid})\\]: https://m365\\.cloud\\.microsoft/[ \\t]*(?:\\r?\\n\\r?\\n|\\r?\\n|$)`,
    'gm',
  );
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sessionError = (text) => Object.assign(new Error(text), { code: 'MODEL_CONVERSATION_UNAVAILABLE' });

function cleanText(text) {
  return text.replace(markerPattern(), '');
}
function cleanMessages(messages) {
  return messages.map((message) =>
    message.role !== 'assistant'
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type === 'text' ? { ...part, text: cleanText(part.text) } : part,
          ),
        },
  );
}
function webUrl(value) {
  const info = conversationUrl(validateCopilotUrl(value));
  if (!info.restorable) throw sessionError(t('errCannotRestoreWebUrl'));
  return info.url;
}

class ModelConversations {
  constructor(state) {
    this.state = state;
    this.records = new Map();
    this.references = new Map();
    this.invalid = false;
    const saved = state?.get('modelWebConversations.v1', []) || [];
    if (!Array.isArray(saved) || saved.length > 1000) this.invalid = true;
    else
      for (const value of saved) {
        try {
          if (
            !value ||
            !new RegExp(`^${uuid}$`).test(value.id) ||
            !/^[a-f0-9]{64}$/.test(value.scope) ||
            typeof value.started !== 'boolean' ||
            this.records.has(value.id) ||
            (value.explicitKey !== undefined && !/^[a-f0-9]{64}$/.test(value.explicitKey)) ||
            (value.failedInput !== undefined && !/^[a-f0-9]{64}$/.test(value.failedInput)) ||
            !Array.isArray(value.turns) ||
            !Array.isArray(value.calls)
          )
            throw Error('invalid');
          if (
            value.turns.length > 64 ||
            value.calls.length > 128 ||
            value.turns.some((turn) => !new RegExp(`^${uuid}$`).test(turn))
          )
            throw Error('invalid');
          if (
            value.calls.some(
              (call) => !/^m365_[a-f0-9]{32}$/.test(call.id) || !value.turns.includes(call.turn),
            )
          )
            throw Error('invalid');
          this.records.set(value.id, {
            id: value.id,
            scope: value.scope,
            started: value.started,
            ...(value.explicitKey ? { explicitKey: value.explicitKey } : {}),
            ...(value.failedInput ? { failedInput: value.failedInput } : {}),
            url: value.url ? webUrl(value.url) : null,
            turns: [...value.turns],
            calls: [...value.calls],
          });
        } catch {
          this.invalid = true;
        }
      }
  }

  resolve(messages, options, endpoint) {
    if (this.invalid) throw sessionError(t('errSavedWebMappingCorrupted'));
    const scope = hash(validateCopilotUrl(endpoint));
    const explicit = options.modelOptions?.m365ConversationId;
    if (explicit !== undefined && (typeof explicit !== 'string' || !explicit.trim() || explicit.length > 200))
      throw sessionError(t('errInvalidConversationIdOption'));
    const explicitKey = explicit === undefined ? undefined : hash(explicit);
    const matches = [];
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type === 'text')
          for (const match of part.text.matchAll(markerPattern())) {
            const record = this.records.get(match[1]);
            if (!record) throw sessionError(t('errWebBindingNotFoundForChat'));
            matches.push({ record, turn: match[2] });
          }
        if (part.type === 'tool_call' && /^m365_[a-f0-9]{32}$/.test(part.id)) {
          const record = [...this.records.values()].find((record) =>
            record.calls.some((call) => call.id === part.id),
          );
          if (!record && !matches.length) throw sessionError(t('errWebBindingNotFoundForToolCall'));
          if (record) matches.push({ record, turn: record.calls.find((call) => call.id === part.id).turn });
        }
      }
    }
    const ids = new Set(matches.map((match) => match.record.id));
    if (ids.size > 1) throw sessionError(t('errMixedConversationBindings'));
    const explicitRecord =
      explicitKey && [...this.records.values()].find((record) => record.explicitKey === explicitKey);
    if (explicitKey && matches.length && matches.at(-1).record.explicitKey !== explicitKey)
      throw sessionError(t('errExplicitIdMismatch'));
    const record = explicitRecord || matches.at(-1)?.record;
    if (record) {
      if (record.scope !== scope) throw sessionError(t('errCopilotSettingsChangedForChat'));
      return { record, cursor: matches.at(-1)?.turn, explicit: Boolean(explicitKey) };
    }
    const fingerprint = hash(
      JSON.stringify({ messages: cleanMessages(messages), tools: options.tools, toolMode: options.toolMode }),
    );
    const failed = [...this.records.values()].filter(
      (record) => record.scope === scope && record.failedInput === fingerprint,
    );
    if (!explicitKey && failed.length === 1) return { record: failed[0], explicit: false };
    if (
      !explicitKey &&
      messages.filter(
        (message) => message.role === 'user' && message.content.some((part) => part.type === 'text'),
      ).length > 1 &&
      [...this.records.values()].some((record) => record.scope === scope && record.failedInput)
    )
      throw sessionError(t('errFirstResponseIncompleteFollowUp'));
    if (!explicitKey && messages.some((message) => message.role === 'assistant'))
      throw sessionError(t('errMissingRestoreIdentifier'));
    if (this.records.size >= 1000) throw sessionError(t('errWebMappingLimitReached'));
    const created = {
      id: randomUUID(),
      scope,
      url: null,
      started: false,
      turns: [],
      calls: [],
      ...(explicitKey ? { explicitKey } : {}),
    };
    this.records.set(created.id, created);
    return { record: created, explicit: Boolean(explicitKey), fingerprint };
  }

  check(binding) {
    if (!binding.explicit && binding.cursor && binding.cursor !== binding.record.turns.at(-1))
      throw sessionError(t('errConversationBranchedOrConcurrent'));
  }

  capture(record, info) {
    if (!info?.restorable) return;
    const url = webUrl(info.url);
    if (record.url && record.url !== url) throw sessionError(t('errWebConversationChangedMidReply'));
    record.url = url;
  }

  finish(record, text, calls) {
    const turn = randomUUID();
    const mapped = calls.map((call) => ({ ...call, id: 'm365_' + randomUUID().replaceAll('-', '') }));
    record.turns.push(turn);
    record.turns = record.turns.slice(-64);
    record.calls = [...record.calls, ...mapped.map((call) => ({ id: call.id, turn }))]
      .filter((call) => record.turns.includes(call.turn))
      .slice(-128);
    delete record.failedInput;
    return {
      text: `[m365-chat:${record.id}:${turn}]: https://m365.cloud.microsoft/\n\n${cleanText(text)}`,
      calls: mapped,
    };
  }

  async save() {
    await this.state?.update(
      'modelWebConversations.v1',
      [...this.records.values()].filter((record) => record.started || record.turns.length),
    );
  }

  retain(record) {
    this.references.set(record.id, (this.references.get(record.id) || 0) + 1);
  }

  releaseUnused(record) {
    const remaining = (this.references.get(record.id) || 1) - 1;
    if (remaining) this.references.set(record.id, remaining);
    else {
      this.references.delete(record.id);
      if (!record.started && !record.turns.length) this.records.delete(record.id);
    }
  }
}

module.exports = { ModelConversations, cleanText, cleanMessages };
