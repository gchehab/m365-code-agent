'use strict';
const { createHash } = require('node:crypto');
const { parseReply } = require('./protocol');

function conversationUrl(value) {
  const url = new URL(value);
  const output = new URL(url.origin + url.pathname);
  for (const key of ['threadId', 'conversationId', 'chatId', 'agentId', 'agent']) if (url.searchParams.has(key)) output.searchParams.set(key, url.searchParams.get(key));
  const restorable = ['threadId', 'conversationId', 'chatId'].some(key => output.searchParams.has(key)) || /\/(?:chat|conversation|conversations)\/[^/]+/i.test(url.pathname);
  return { url: output.href, restorable };
}
function historyMessages(turns) {
  const events = [];
  let activeTask = null;
  for (const turn of turns) {
    const text = turn.text.trim();
    if (!text) continue;
    if (turn.role === 'user' && text.startsWith('VS Code coding agent.')) {
      try {
        const data = JSON.parse(text.slice(text.indexOf(' DATA: ') + 7));
        if (typeof data.task === 'string' && activeTask !== data.task) { events.push({ role: 'user', text: data.task }); activeTask = data.task; }
      } catch { /* Do not expose raw protocol/file payloads as chat messages. */ }
      continue;
    }
    if (turn.role === 'assistant') {
      const match = text.match(/"requestId"\s*:\s*"([^"]+)"/);
      if (match) {
        try {
          const reply = parseReply(text, match[1]);
          if (reply.kind === 'tools') continue;
          if (reply.kind === 'changes') { if (reply.summary) events.push({ role: 'assistant', text: reply.summary }); continue; }
          events.push({ role: 'assistant', text: reply.message }); activeTask = null;
          continue;
        } catch { continue; }
      }
    }
    events.push({ role: turn.role, text });
    if (turn.role === 'assistant') activeTask = null;
  }
  const occurrences = new Map();
  return events.map(event => {
    const key = createHash('sha256').update(event.role + '\0' + event.text).digest('hex');
    const count = (occurrences.get(key) || 0) + 1; occurrences.set(key, count);
    return { type: 'message', ...event, webId: key + ':' + count, source: 'web' };
  });
}
function mergeHistory(local, incoming) {
  const existing = new Set(local.map(event => event.webId).filter(Boolean));
  const counts = new Map();
  for (const event of local.filter(event => event.type === 'message' && ['user', 'assistant'].includes(event.role))) {
    const key = event.role + '\0' + event.text; counts.set(key, (counts.get(key) || 0) + 1);
  }
  const seen = new Map(), added = [];
  for (const event of incoming) {
    const key = event.role + '\0' + event.text, count = (seen.get(key) || 0) + 1; seen.set(key, count);
    if (existing.has(event.webId) || count <= (counts.get(key) || 0)) continue;
    added.push(event);
  }
  return [...local, ...added].slice(-100);
}
module.exports = { conversationUrl, historyMessages, mergeHistory };
