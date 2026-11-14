'use strict';
const api = acquireVsCodeApi();
const el = id => document.getElementById(id);
const send = type => api.postMessage({ type });
const saved = api.getState() || {};
let running = false;
let composing = false;
let reviewToken, commandToken;
const tools = new Map();
el('task').value = saved.draft || '';
el('mode').value = saved.mode || 'agent';
el('review').checked = saved.review !== false;
el('includeEditor').checked = saved.includeEditor !== false;
function persist() { api.setState({ draft: el('task').value, mode: el('mode').value, review: el('review').checked, includeEditor: el('includeEditor').checked }); }
function busy(value) {
  running = value;
  for (const id of ['run', 'connect', 'newChat', 'history', 'attach', 'mode', 'undo', 'review', 'includeEditor']) el(id).disabled = value;
  el('stop').hidden = !value;
  el('run').hidden = value;
  el('status').classList.toggle('working', value);
}
function followEnd() { const messages = el('messages'); messages.scrollTop = messages.scrollHeight; }
function message(event) {
  el('welcome').hidden = true;
  if (event.type === 'tool') {
    let card = tools.get(event.id);
    if (!card) { card = document.createElement('details'); card.className = 'tool'; tools.set(event.id, card); el('messages').append(card); }
    const summary = document.createElement('summary');
    summary.textContent = `${{ running: '◌', done: '✓', error: '!' }[event.state]} ${event.label}`;
    card.dataset.state = event.state;
    const detail = document.createElement('pre'); detail.textContent = event.detail || (event.state === 'running' ? '작업 중…' : '완료');
    card.replaceChildren(summary, detail); followEnd(); return;
  }
  const card = document.createElement('article'); card.className = event.role;
  const label = document.createElement('strong'); label.textContent = { user: '나', assistant: 'M365 Copilot', system: '작업 기록' }[event.role] || event.role;
  card.append(label);
  // Model output is text, never executable HTML.
  String(event.text).split(/```[^\n]*\n([\s\S]*?)```/g).forEach((text, index) => {
    const block = document.createElement(index % 2 ? 'pre' : 'div'); block.className = index % 2 ? 'code' : 'prose'; block.textContent = text.trim(); card.append(block);
  });
  el('messages').append(card); followEnd();
}
function attachments(files) {
  el('attachments').replaceChildren();
  for (const path of files) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'chip'; chip.textContent = `${path} ×`; chip.title = '첨부 해제';
    chip.addEventListener('click', () => api.postMessage({ type: 'removeAttachment', path })); el('attachments').append(chip);
  }
}
function closeReview() { el('apply').hidden = true; el('reject').hidden = true; }
el('form').addEventListener('submit', event => {
  event.preventDefault(); const task = el('task').value.trim(); if (!task || running || composing) return;
  busy(true); el('status').textContent = '작업 준비 중…'; el('status').classList.remove('error'); el('changes').hidden = true;
  api.postMessage({ type: 'run', task, mode: el('mode').value, review: el('review').checked, includeEditor: el('includeEditor').checked });
  el('task').value = ''; persist();
});
el('task').addEventListener('compositionstart', () => { composing = true; });
el('task').addEventListener('compositionend', () => { composing = false; });
el('task').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); el('form').requestSubmit(); }
  if (event.key === 'Escape' && running) send('stop');
});
for (const id of ['task', 'mode', 'review', 'includeEditor']) el(id).addEventListener('input', persist);
for (const id of ['connect', 'newChat', 'history', 'attach', 'diagnostics', 'stop', 'apply', 'reject', 'undo', 'approveCommand', 'rejectCommand']) el(id).addEventListener('click', () => {
  if (['apply', 'reject'].includes(id)) closeReview();
  if (['approveCommand', 'rejectCommand'].includes(id)) el('approval').hidden = true;
  api.postMessage({ type: id, token: ['apply', 'reject'].includes(id) ? reviewToken : ['approveCommand', 'rejectCommand'].includes(id) ? commandToken : undefined });
});
for (const button of document.querySelectorAll('.suggestion')) button.addEventListener('click', () => {
  el('task').value = button.dataset.prompt; el('mode').value = button.dataset.mode; persist(); el('task').focus();
});
window.addEventListener('message', ({ data }) => {
  if (data.type === 'message' || data.type === 'tool') message(data);
  if (data.type === 'status') { el('status').textContent = data.text; el('status').classList.toggle('error', Boolean(data.error)); }
  if (data.type === 'busy') busy(true);
  if (data.type === 'idle') { busy(false); closeReview(); el('approval').hidden = true; }
  if (data.type === 'history') {
    el('messages').replaceChildren(); tools.clear(); el('welcome').hidden = Boolean(data.events.length);
    data.events.forEach(message); busy(data.running); attachments(data.attachments || []);
    el('changes').hidden = true; el('approval').hidden = true; el('checkpoint').hidden = !data.undo;
    if (data.pending) window.dispatchEvent(new MessageEvent('message', { data: data.pending }));
  }
  if (data.type === 'attachments') attachments(data.files);
  if (data.type === 'changes') {
    reviewToken = data.token;
    el('changes').hidden = false; el('changeTitle').textContent = data.summary; el('changeFiles').replaceChildren();
    for (const file of data.files) {
      const button = document.createElement('button'); button.className = 'file'; button.textContent = `${file.action === 'create' ? '+' : 'M'}  ${file.path}`; button.title = 'VS Code에서 diff 열기';
      button.addEventListener('click', () => api.postMessage({ type: 'preview', id: file.id })); el('changeFiles').append(button);
    }
    el('apply').hidden = !data.review; el('reject').hidden = !data.review;
  }
  if (data.type === 'reviewClosed') closeReview();
  if (data.type === 'commandApproval') {
    commandToken = data.token;
    el('approval').hidden = false; el('commandText').textContent = data.command; el('commandRoot').textContent = `작업 폴더: ${data.root}`; el('status').textContent = '명령 실행 승인 대기 중';
  }
  if (data.type === 'approvalClosed') el('approval').hidden = true;
  if (data.type === 'applied') { closeReview(); el('checkpoint').hidden = false; }
  if (data.type === 'undoState') el('checkpoint').hidden = !data.available;
});
send('ready');
