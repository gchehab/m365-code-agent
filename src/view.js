'use strict';
const { getLanguagePack, getAvailableLanguages } = require('./i18n');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function icon(name) {
  const shapes = {
    add: '<path d="M12 5v14M5 12h14"/>',
    history: '<path d="M3 11a9 9 0 1 1 2.6 7.3M3 4v7h7M12 7v5l3 2"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    sync: '<path d="M20 7h-5m5 0V2M4 17h5m-5 0v5M4 8a8 8 0 0 1 13-5l3 4M4 17l3 4a8 8 0 0 0 13-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shapes[name]}</svg>`;
}

function renderWebview({ nonce, cspSource, resource, lang }) {
  const pack = getLanguagePack(lang);
  const s = pack.ui;
  const availableLanguages = getAvailableLanguages();
  const i18nPayload = JSON.stringify({
    code: pack.code,
    dateLocale: pack.dateLocale,
    ui: s,
    availableLanguages,
  }).replace(/</g, '\\u003c');
  const languageOptions = availableLanguages
    .map(
      (item) =>
        `<option value="${escapeHtml(item.code)}"${item.code === pack.code ? ' selected' : ''}>${escapeHtml(item.label)}</option>`,
    )
    .join('');

  return `<!doctype html>
<html lang="${escapeHtml(pack.htmlLang)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('view.css')}">
</head>
<body>
<header>
<span class="brand">M365 <b>Code Agent</b>
</span>
<nav class="toolbar header-actions" aria-label="${escapeHtml(s.toolbarAriaLabel)}">
<button id="newChat" class="icon-button" title="${escapeHtml(s.newChat)}" aria-label="${escapeHtml(s.newChat)}">${icon('add')}</button>
<button id="history" class="icon-button" title="${escapeHtml(s.history)}" aria-label="${escapeHtml(s.history)}" aria-controls="historyPanel" aria-expanded="false">${icon('history')}</button>
<button id="more" class="icon-button" title="${escapeHtml(s.more)}" aria-label="${escapeHtml(s.more)}" aria-controls="moreMenu" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
</nav>
<div id="moreMenu" role="menu" hidden>
<button id="showBrowser" role="menuitem">${escapeHtml(s.showBrowser)}</button>
<button id="editorBrowser" role="menuitem">${escapeHtml(s.editorBrowser)}</button>
<button id="syncWeb" role="menuitem">${icon('sync')}${escapeHtml(s.syncWeb)}</button>
<button id="checkWorkspace" role="menuitem" title="${escapeHtml(s.checkWorkspaceTitle)}">${escapeHtml(s.checkWorkspace)}</button>
<button id="diagnostics" role="menuitem">${icon('info')}${escapeHtml(s.diagnostics)}</button>
<button id="mcpTools" role="menuitem">${escapeHtml(s.mcpTools)}</button>
</div>
</header>
<section id="historyPanel" hidden aria-label="${escapeHtml(s.history)}">
<div class="history-heading">
<h2 id="historyHeadingText">${escapeHtml(s.history)}</h2>
<button id="closeHistory" class="icon-button" title="${escapeHtml(s.closeHistory)}" aria-label="${escapeHtml(s.closeHistory)}">${icon('close')}</button>
</div>
<p id="historyNoteText" class="history-note">${escapeHtml(s.historyNote)}</p>
<input id="historySearch" type="search" placeholder="${escapeHtml(s.historySearchPlaceholder)}" aria-label="${escapeHtml(s.historySearchPlaceholder)}">
<div id="sessionList" role="list">
</div>
<button id="deleteAllSessions" class="danger-button">${escapeHtml(s.deleteAllSessions)}</button>
</section>
<div class="context-bar">
<span id="workspaceName" title="${escapeHtml(s.workspacePathTitle)}">${escapeHtml(s.workspaceUnverified)}</span>
<details id="readingOptions">
<summary id="readingOptionsSummary">${escapeHtml(s.readingSettings)}</summary>
<div class="reading-options">
<div class="language-controls">
<span id="languageLabel">${escapeHtml(s.languageLabel)}</span>
<select id="language" title="${escapeHtml(s.languageTitle)}" aria-label="${escapeHtml(s.languageLabel)}">
${languageOptions}
</select>
</div>
<div class="font-controls">
<span id="fontSizeLabel">${escapeHtml(s.fontSize)}</span>
<button id="fontSmaller" type="button" aria-label="${escapeHtml(s.fontSmaller)}">A−</button>
<output id="fontSize" aria-live="polite">14</output>
<button id="fontLarger" type="button" aria-label="${escapeHtml(s.fontLarger)}">A+</button>
</div>
<label>
<input id="wrapCode" type="checkbox" checked> <span id="wrapCodeLabel">${escapeHtml(s.wrapCode)}</span></label>
</div>
</details>
</div>
<div class="conversation">
<main id="messages" aria-label="${escapeHtml(s.conversationAriaLabel)}">
</main>
<button id="jumpToLatest" type="button" hidden>${escapeHtml(s.jumpToLatest)}</button>
<div id="welcome">
<h2 id="welcomeTitleText">${escapeHtml(s.welcomeTitle)}</h2>
<p id="welcomeSubtitleText">${escapeHtml(s.welcomeSubtitle)}</p>
<button id="suggestionExplore" class="suggestion" data-prompt="${escapeHtml(s.suggestionExplorePrompt)}">${escapeHtml(s.suggestionExploreLabel)}</button>
<button id="suggestionReview" class="suggestion" data-prompt="${escapeHtml(s.suggestionReviewPrompt)}">${escapeHtml(s.suggestionReviewLabel)}</button>
</div>
</div>
<footer>
<div id="roundProgress" hidden aria-live="polite">
</div>
<div id="status" role="status">${escapeHtml(s.initialStatus)}</div>
<section id="changes" hidden>
<strong id="changeTitle">${escapeHtml(s.changeReviewTitle)}</strong>
<p id="reviewReason">
</p>
<div id="changeFiles">
</div>
<div class="toolbar">
<button id="apply">${escapeHtml(s.apply)}</button>
<button id="reject">${escapeHtml(s.reject)}</button>
</div>
</section>
<section id="approval" hidden>
<strong id="approvalTitle">${escapeHtml(s.commandApprovalTitle)}</strong>
<p id="commandRoot">
</p>
<p id="approvalNote" hidden></p>
<pre id="commandText">
</pre>
<div id="commandChanges">
</div>
<div class="toolbar">
<button id="approveCommand">${escapeHtml(s.approveCommand)}</button>
<button id="rejectCommand">${escapeHtml(s.reject)}</button>
</div>
</section>
<div id="checkpoint" hidden>
<span id="lastFileChangeLabel">${escapeHtml(s.lastFileChange)}</span>
<button id="undo">${escapeHtml(s.undo)}</button>
</div>
<form id="form">
<div id="attachments">
</div>
<label id="taskSrLabel" class="sr-only" for="task">${escapeHtml(s.taskLabel)}</label>
<textarea id="task" rows="2" maxlength="8000" placeholder="${escapeHtml(s.taskPlaceholder)}">
</textarea>
<div class="composer-tools">
<div class="toolbar">
<button id="attach" type="button" title="${escapeHtml(s.attachFilesTitle)}">${escapeHtml(s.attachFiles)}</button>
<button id="attachLocal" type="button" title="${escapeHtml(s.attachLocalTitle)}">${escapeHtml(s.attachLocal)}</button>
<button id="connect" type="button" title="${escapeHtml(s.connectTitle)}">${escapeHtml(s.connect)}</button>
</div>
<div>
<button id="stop" type="button" hidden>${escapeHtml(s.stop)}</button>
<button id="run" type="submit" title="${escapeHtml(s.sendTitle)}">↑</button>
</div>
</div>
<details id="composerOptions">
<summary><span id="composerOptionsSummaryText">${escapeHtml(s.composerOptionsSummary)}</span> <span class="option-badges">
<span id="roundMode" hidden>${escapeHtml(s.unlimitedBadge)}</span>
<span id="approvalMode">
</span>
</span>
</summary>
<div class="model-tools">
<label id="modelSrLabel" class="sr-only" for="model">${escapeHtml(s.modelLabel)}</label>
<select id="model" title="${escapeHtml(s.modelTitle)}">
<option value="">${escapeHtml(s.defaultModelOption)}</option>
</select>
<button id="refreshModels" type="button" title="${escapeHtml(s.refreshModelsTitle)}">${escapeHtml(s.refreshModels)}</button>
</div>
<div class="preferences">
<label>
<input type="checkbox" id="includeEditor" checked> <span id="includeEditorLabel">${escapeHtml(s.includeEditor)}</span></label>
<label id="reviewLabelWrapper" title="${escapeHtml(s.reviewChangesTitle)}">
<input type="checkbox" id="review" checked> <span id="reviewChangesLabel">${escapeHtml(s.reviewChanges)}</span></label>
<span id="webSync" title="${escapeHtml(s.webSyncDefaultTitle)}">${escapeHtml(s.webSyncDefault)}</span>
</div>
<label class="request-limit-option">
<input type="checkbox" id="unlimitedRounds" aria-describedby="unlimitedRoundsHint"> <span id="unlimitedRoundsLabel">${escapeHtml(s.unlimitedRounds)}</span></label>
<p id="unlimitedRoundsHint" class="option-note">${escapeHtml(s.unlimitedRoundsHint)}</p>
<label class="auto-approve-option">
<input type="checkbox" id="autoApprove" aria-describedby="autoApproveHint"> <span id="autoApproveLabel">${escapeHtml(s.autoApprove)}</span></label>
<p id="autoApproveHint" class="option-note">${escapeHtml(s.autoApproveHint)}</p>
</details>
</form>
<p id="composerHintText" class="hint">${escapeHtml(s.composerHint)}</p>
</footer>
<script nonce="${nonce}">window.M365_I18N = ${i18nPayload};</script>
<script nonce="${nonce}" src="${resource('reading.js')}">
</script>
<script nonce="${nonce}" src="${resource('view.js')}">
</script>
</body>
</html>`;
}
module.exports = { renderWebview };
