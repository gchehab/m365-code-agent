'use strict';
const api = acquireVsCodeApi();
const el = id => document.getElementById(id);
const send = type => api.postMessage({ type });
let running = false;
function busy(value) {
  running = value;
  el('run').disabled = value;
  el('stop').disabled = !value;
  el('connect').disabled = value;
  el('newChat').disabled = value;
}
function message(event) {
  const card = document.createElement('article');
  card.className = event.role;
  const label = document.createElement('strong');
  label.textContent = { user: '내 요청', assistant: 'Copilot', system: '작업 기록' }[event.role] || event.role;
  const text = document.createElement('pre');
  text.textContent = event.text;
  card.append(label, text);
  el('messages').append(card);
  card.scrollIntoView({ block: 'end' });
}
el('form').addEventListener('submit', event => {
  event.preventDefault();
  const task = el('task').value.trim();
  if (!task || running) return;
  busy(true);
  el('changes').hidden = true;
  api.postMessage({ type: 'run', task, review: el('review').checked, includeEditor: el('includeEditor').checked });
});
for (const id of ['connect', 'newChat', 'diagnostics', 'stop', 'apply', 'reject']) el(id).addEventListener('click', () => {
  if (id === 'apply' || id === 'reject') { el('apply').disabled = true; el('reject').disabled = true; }
  send(id);
});
window.addEventListener('message', ({ data }) => {
  if (data.type === 'message') message(data);
  if (data.type === 'status') el('status').textContent = data.text;
  if (data.type === 'busy') busy(true);
  if (data.type === 'idle') { busy(false); el('status').textContent = '대기 중 · 다음 작업을 입력하세요.'; el('apply').disabled = true; el('reject').disabled = true; }
  if (data.type === 'history') { el('messages').replaceChildren(); data.events.forEach(message); busy(data.running); }
  if (data.type === 'changes') {
    el('changes').hidden = false;
    el('changeTitle').textContent = data.summary;
    el('changeFiles').replaceChildren();
    for (const file of data.files) {
      const button = document.createElement('button');
      button.className = 'file';
      button.textContent = `${file.action === 'create' ? '새 파일' : '수정'} · ${file.path}`;
      button.addEventListener('click', () => api.postMessage({ type: 'preview', id: file.id }));
      el('changeFiles').append(button);
    }
    el('apply').hidden = !data.review;
    el('reject').hidden = !data.review;
    el('apply').disabled = false;
    el('reject').disabled = false;
  }
  if (data.type === 'applied') { el('apply').disabled = true; el('reject').disabled = true; }
});
send('ready');
