'use strict';
const api = acquireVsCodeApi();
const el = id => document.getElementById(id);
const send = type => api.postMessage({ type });
const saved = api.getState() || {};
let running = false;
let composing = false;
let reviewToken, commandToken;
let pendingTask = saved.pendingTask || null;
const tools = new Map();
let sessions = [];
let activityGroup, activeSessionId, hasHistory = false, renderingHistory = false;
let followTail = true;
let readingSize = Number.isFinite(saved.readingSize) ? Math.min(18, Math.max(12, saved.readingSize)) : 14;
const reading = window.M365Reading(api);
el('wrapCode').checked = saved.wrapCode !== false;
function applyReading() {
  document.documentElement.style.setProperty('--reading-font-size', readingSize + 'px');
  el('fontSize').textContent = String(readingSize);
  el('fontSmaller').disabled = readingSize <= 12; el('fontLarger').disabled = readingSize >= 18;
  reading.setWrap(el('wrapCode').checked);
}
applyReading();
el('fontSmaller').addEventListener('click', () => { readingSize = Math.max(12, readingSize - 1); applyReading(); persist(); });
el('fontLarger').addEventListener('click', () => { readingSize = Math.min(18, readingSize + 1); applyReading(); persist(); });
el('wrapCode').addEventListener('change', () => { applyReading(); persist(); });
el('composerOptions').open = saved.composerOptions === true;
el('composerOptions').addEventListener('toggle', persist);
el('task').value = saved.draft || '';
el('review').checked = saved.review !== false;
el('autoApprove').checked = saved.autoApprove === true;
el('unlimitedRounds').checked = saved.unlimitedRounds === true;
el('includeEditor').checked = saved.includeEditor !== false;
function syncPreferences() {
  const automatic = el('autoApprove').checked;
  el('roundMode').hidden = !el('unlimitedRounds').checked;
  el('approvalMode').textContent = automatic ? '승인 없이 진행' : el('review').checked ? '승인 켜짐' : '일반 파일 자동 적용';
  el('approvalMode').classList.toggle('auto-apply', automatic || !el('review').checked);
  el('review').disabled = running || automatic;
  el('form').classList.toggle('auto-approval', automatic);
}
syncPreferences();
function persist() { syncPreferences(); api.setState({ draft: el('task').value, pendingTask, review: el('review').checked, autoApprove: el('autoApprove').checked, unlimitedRounds: el('unlimitedRounds').checked, includeEditor: el('includeEditor').checked, readingSize, wrapCode: el('wrapCode').checked, composerOptions: el('composerOptions').open }); }
function busy(value) {
  running = value;
  if (!value) progress(null);
  for (const id of ['run', 'connect', 'newChat', 'history', 'more', 'attach', 'model', 'refreshModels', 'syncWeb', 'showBrowser', 'editorBrowser', 'diagnostics', 'undo', 'review', 'autoApprove', 'unlimitedRounds', 'includeEditor', 'checkWorkspace']) el(id).disabled = value;
  for (const control of el('historyPanel').querySelectorAll('button,input')) control.disabled = value;
  el('deleteAllSessions').disabled = value || !sessions.length;
  if (value) toggleMore(false);
  el('stop').hidden = !value;
  el('run').hidden = value;
  el('status').classList.toggle('working', value); syncPreferences();
}
function followEnd(force = false) {
  if (renderingHistory) return;
  if (force) followTail = true;
  const messages = el('messages');
  if (followTail) messages.scrollTop = messages.scrollHeight;
  el('jumpToLatest').hidden = followTail;
}
el('messages').addEventListener('scroll', () => {
  const messages = el('messages');
  followTail = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
  el('jumpToLatest').hidden = followTail;
});
el('jumpToLatest').addEventListener('click', () => followEnd(true));
function activity() {
  if (!activityGroup) {
    activityGroup = document.createElement('details'); activityGroup.className = 'activity';
    const summary = document.createElement('summary');
    const title = document.createElement('span'); title.className = 'activity-title';
    const status = document.createElement('span'); status.className = 'activity-status';
    summary.append(title, status);
    const items = document.createElement('div'); items.className = 'activity-items';
    activityGroup.append(summary, items); el('messages').append(activityGroup);
  }
  return activityGroup;
}
function updateActivity(group) {
  const running = group.querySelectorAll('.tool[data-state="running"]').length;
  const failed = group.querySelectorAll('.tool[data-state="error"]').length;
  group.querySelector('.activity-title').textContent = `작업 기록 · ${group.querySelector('.activity-items').children.length}개`;
  group.querySelector('.activity-status').textContent = failed ? '확인 필요' : running ? '진행 중' : '';
  group.classList.toggle('has-error', Boolean(failed));
}
function message(event) {
  el('welcome').hidden = true;
  if (event.type === 'tool') {
    let card = tools.get(event.id);
    if (!card) { card = document.createElement('details'); card.className = 'tool'; tools.set(event.id, card); activity().querySelector('.activity-items').append(card); }
    const previous = card.dataset.state;
    const summary = document.createElement('summary');
    summary.textContent = `${{ running: '◌', done: '✓', error: '!' }[event.state]} ${event.label}`;
    card.dataset.state = event.state;
    const detail = document.createElement('pre'); detail.textContent = event.detail || (event.state === 'running' ? '작업 중…' : '완료');
    card.replaceChildren(summary, detail);
    const group = card.closest('.activity'); updateActivity(group);
    if (event.state === 'error' && previous !== 'error') { group.open = true; card.open = true; }
    followEnd(); return;
  }
  const card = document.createElement('article'); card.className = event.role;
  const label = document.createElement('strong'); label.className = 'message-role'; label.textContent = { user: '나', assistant: 'M365 Copilot', system: '작업 기록' }[event.role] || event.role;
  card.append(label);
  const body = document.createElement('div');
  if (event.role === 'assistant' && typeof event.html === 'string') {
    // Only extension-rendered Markdown with raw HTML disabled enters innerHTML.
    body.className = 'markdown'; body.innerHTML = event.html; reading.enhance(body);
  } else { body.className = 'prose'; body.textContent = event.text; }
  card.append(body);
  if (event.role === 'assistant') {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const copy = document.createElement('button'); copy.textContent = '답변 복사'; copy.addEventListener('click', () => reading.copy(event.text, copy));
    const expand = document.createElement('button'); expand.textContent = '크게 보기'; expand.title = '편집기 탭에서 답변 읽기'; expand.addEventListener('click', () => api.postMessage({ type: 'openResponse', text: event.text, readingSize, wrapCode: el('wrapCode').checked }));
    actions.append(copy, expand); card.append(actions);
  }
  if (event.role === 'system') { const group = activity(); group.querySelector('.activity-items').append(card); updateActivity(group); }
  else { activityGroup = null; el('messages').append(card); }
  followEnd();
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
  followEnd(true);
  busy(true); el('status').textContent = '작업 준비 중…'; el('status').classList.remove('error'); el('changes').hidden = true;
  pendingTask = { id: crypto.randomUUID(), task };
  api.postMessage({ type: 'run', task, clientRequestId: pendingTask.id, review: el('review').checked, autoApprove: el('autoApprove').checked, unlimitedRounds: el('unlimitedRounds').checked, includeEditor: el('includeEditor').checked });
  el('task').value = ''; resizeComposer(); persist();
});
el('task').addEventListener('compositionstart', () => { composing = true; });
el('task').addEventListener('compositionend', () => { composing = false; });
el('task').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); el('form').requestSubmit(); }
  if (event.key === 'Escape' && running) send('stop');
});
function resizeComposer() { el('task').style.height = 'auto'; el('task').style.height = Math.min(160, Math.max(52, el('task').scrollHeight)) + 'px'; }
el('task').addEventListener('input', resizeComposer); resizeComposer();
for (const id of ['task', 'review', 'autoApprove', 'unlimitedRounds', 'includeEditor']) el(id).addEventListener('input', persist);
for (const id of ['connect', 'newChat', 'attach', 'diagnostics', 'stop', 'apply', 'reject', 'undo', 'approveCommand', 'rejectCommand', 'checkWorkspace', 'refreshModels', 'syncWeb', 'showBrowser', 'editorBrowser']) el(id).addEventListener('click', () => {
  toggleMore(false);
  if (id === 'newChat') showHistory(false);
  if (['apply', 'reject'].includes(id)) closeReview();
  if (['approveCommand', 'rejectCommand'].includes(id)) el('approval').hidden = true;
  api.postMessage({ type: id, token: ['apply', 'reject'].includes(id) ? reviewToken : ['approveCommand', 'rejectCommand'].includes(id) ? commandToken : undefined });
});
function toggleMore(open) { el('moreMenu').hidden = !open; el('more').setAttribute('aria-expanded', String(open)); if (open) el('moreMenu').querySelector('button:not(:disabled)')?.focus(); }
function showHistory(open) {
  el('historyPanel').hidden = !open; el('history').setAttribute('aria-expanded', String(open)); toggleMore(false);
  if (open) { send('listSessions'); el('historySearch').focus(); } else el('task').focus();
}
function renderSessions() {
  const query = el('historySearch').value.trim().toLowerCase();
  const filtered = sessions.filter(item => item.title.toLowerCase().includes(query));
  el('sessionList').replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = sessions.length ? '일치하는 대화가 없습니다.' : '저장된 대화가 없습니다.'; el('sessionList').append(empty);
  }
  for (const item of filtered) {
    const row = document.createElement('article'); row.className = 'session-row'; row.setAttribute('role', 'listitem'); row.classList.toggle('active', Boolean(item.active));
    const open = document.createElement('button'); open.className = 'session-open'; open.textContent = item.title; open.title = item.title;
    open.addEventListener('click', () => { if (!running) { showHistory(false); api.postMessage({ type: 'openSession', id: item.id }); } });
    const meta = document.createElement('p'); meta.className = 'session-meta'; meta.textContent = `${item.active ? '현재 대화 · ' : ''}${new Date(item.updated).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 메시지 ${item.count}개${item.linked ? ' · 웹 연결' : ''}`;
    const actions = document.createElement('div'); actions.className = 'session-actions';
    for (const [type, label] of [['renameSession', '이름 변경'], ['deleteSession', '삭제']]) {
      const button = document.createElement('button'); button.textContent = label; button.disabled = running; if (type === 'deleteSession') button.className = 'danger-button';
      button.addEventListener('click', () => { if (!running) api.postMessage({ type, id: item.id }); }); actions.append(button);
    }
    open.disabled = running; row.append(open, meta, actions); el('sessionList').append(row);
  }
  el('deleteAllSessions').disabled = running || !sessions.length;
}
el('more').addEventListener('click', () => toggleMore(el('moreMenu').hidden));
el('moreMenu').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault(); const items = [...el('moreMenu').querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
  items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
});
el('history').addEventListener('click', () => showHistory(el('historyPanel').hidden));
el('closeHistory').addEventListener('click', () => showHistory(false));
el('historySearch').addEventListener('input', renderSessions);
el('deleteAllSessions').addEventListener('click', () => { if (!running) send('deleteAllSessions'); });
document.addEventListener('click', event => { if (!event.target.closest('#more,#moreMenu')) toggleMore(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if (!el('moreMenu').hidden) { toggleMore(false); el('more').focus(); } else if (!el('historyPanel').hidden) showHistory(false); } });
for (const button of document.querySelectorAll('.suggestion')) button.addEventListener('click', () => {
  el('task').value = button.dataset.prompt; resizeComposer(); persist(); el('task').focus();
});
el('model').addEventListener('change', () => api.postMessage({ type: 'selectModel', id: el('model').value }));
function models(choices, selected) {
  el('model').replaceChildren(new Option('M365 웹의 현재 모델', ''));
  for (const choice of choices || []) el('model').append(new Option(choice.label, choice.id));
  el('model').value = selected || '';
}
function progress(value) {
  el('roundProgress').hidden = !value;
  el('roundProgress').textContent = value ? `Copilot 요청 ${value.round}회 · ${value.unlimited === true ? '무제한' : '안전 한도 ' + value.total + '회'}` : '';
}
window.addEventListener('message', ({ data }) => {
  if (data.type === 'message' || data.type === 'tool') message(data);
  if (data.type === 'status') { el('status').textContent = data.text; el('status').classList.toggle('error', Boolean(data.error)); }
  if (data.type === 'busy') busy(true);
  if (data.type === 'idle') { busy(false); closeReview(); el('approval').hidden = true; }
  if (data.type === 'runResult' && pendingTask && data.clientRequestId === pendingTask.id) {
    if (!data.success && !el('task').value.trim()) el('task').value = pendingTask.task;
    pendingTask = null; resizeComposer(); persist();
  }
  if (data.type === 'models') models(data.choices, data.selected);
  if (data.type === 'progress') progress(data);
  if (data.type === 'sessions') { sessions = data.items || []; renderSessions(); }
  if (data.type === 'webConversation') { el('webSync').textContent = data.url ? '웹 기록 연결됨' : 'M365 Copilot'; el('webSync').title = data.url ? '5초마다 현재 웹 대화 동기화 · ' + data.url : '연결된 웹 대화를 5초마다 확인합니다.'; }
  if (data.type === 'history') {
    const same = hasHistory && activeSessionId === data.sessionId;
    const oldTop = el('messages').scrollTop, wasFollowing = followTail;
    const oldDetailsCount = same ? el('messages').querySelectorAll('details').length : 0;
    const opened = same ? [...el('messages').querySelectorAll('details')].map((item, index) => item.open ? index : -1).filter(index => index >= 0) : [];
    const codeStates = same ? [...el('messages').querySelectorAll('.code-block')].map(block => ({ text: block.querySelector('code').textContent, wrap: block.dataset.wrap })) : [];
    renderingHistory = true;
    el('messages').replaceChildren(); tools.clear(); activityGroup = null; el('welcome').hidden = Boolean(data.events.length);
    data.events.forEach(message);
    if (same) for (const [index, item] of [...el('messages').querySelectorAll('details')].entries()) if (index < oldDetailsCount) item.open = opened.includes(index);
    for (const [index, block] of [...el('messages').querySelectorAll('.code-block')].entries()) { const prior = codeStates[index]; if (prior?.wrap && prior.text === block.querySelector('code').textContent) { block.dataset.wrap = prior.wrap; block.querySelector('.wrap-button').setAttribute('aria-pressed', String(prior.wrap === 'on')); } }
    renderingHistory = false; activeSessionId = data.sessionId; hasHistory = true;
    followTail = same ? wasFollowing : true;
    if (!followTail) el('messages').scrollTop = oldTop;
    followEnd(); busy(data.running); attachments(data.attachments || []);
    el('changes').hidden = true; el('approval').hidden = true; el('checkpoint').hidden = !data.undo;
    if (data.pending) window.dispatchEvent(new MessageEvent('message', { data: data.pending }));
    if (data.workspace) window.dispatchEvent(new MessageEvent('message', { data: { type: 'workspace', ...data.workspace } }));
    models(data.models, data.selectedModel);
    sessions = data.sessions || []; renderSessions();
    progress(data.running ? data.progress : null);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'webConversation', url: data.webUrl } }));
    if (!data.running && pendingTask) { if (!el('task').value.trim()) el('task').value = pendingTask.task; pendingTask = null; resizeComposer(); persist(); }
  }
  if (data.type === 'workspace') { el('workspaceName').textContent = data.name; el('workspaceName').title = data.path; }
  if (data.type === 'attachments') attachments(data.files);
  if (data.type === 'changes') {
    reviewToken = data.token;
    el('reviewReason').textContent = data.autoApproved ? '승인 없이 진행 · 검증 후 자동 적용합니다.' : data.forcedReview?.length ? '파일 삭제·실행 설정 변경은 자동 적용 설정과 관계없이 검토가 필요합니다.' : '';
    el('changes').hidden = false; el('changeTitle').textContent = data.summary; el('changeFiles').replaceChildren();
    for (const file of data.files) {
      const button = document.createElement('button'); button.className = 'file' + (file.action === 'delete' ? ' deleted-file' : ''); button.textContent = `${file.action === 'delete' ? 'D · 삭제' : file.action === 'create' ? '+' : 'M'}  ${file.path}${file.binary ? ' (바이너리)' : ''}`; button.title = file.action === 'delete' ? '삭제할 파일 미리보기' : 'VS Code에서 diff 열기';
      button.addEventListener('click', () => api.postMessage({ type: 'preview', id: file.id })); el('changeFiles').append(button);
    }
    el('apply').hidden = !data.review; el('reject').hidden = !data.review;
  }
  if (data.type === 'reviewClosed') closeReview();
  if (data.type === 'commandApproval') {
    commandToken = data.token;
    el('approval').hidden = false; el('commandText').textContent = data.command; el('commandRoot').textContent = `작업 폴더: ${data.root}`; el('status').textContent = '명령 실행 승인 대기 중';
    el('commandChanges').replaceChildren();
    if (data.changedFiles?.length) {
      for (const currentTask of [true, false]) {
        const files = data.changedFiles.filter(file => Boolean(file.currentTask) === currentTask);
        if (!files.length) continue;
        const title = document.createElement('p'); title.textContent = (currentTask ? '이번 요청에서 변경한 파일' : '이전 요청에서 변경한 파일') + ' · 파일명을 눌러 diff 검토'; el('commandChanges').append(title);
        for (const file of files) {
          const button = document.createElement('button'); button.className = 'file'; button.textContent = `${file.action === 'delete' ? '삭제 · ' : ''}${file.sensitive ? '실행 설정 · ' : ''}${file.path}`; button.disabled = !file.id;
          button.addEventListener('click', () => api.postMessage({ type: 'preview', id: file.id })); el('commandChanges').append(button);
        }
      }
    }
  }
  if (data.type === 'approvalClosed') el('approval').hidden = true;
  if (data.type === 'applied') { closeReview(); el('checkpoint').hidden = false; }
  if (data.type === 'undoState') el('checkpoint').hidden = !data.available;
});
send('ready');
