'use strict';
function renderWebview({ nonce, cspSource, resource }) {
  return `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('view.css')}"></head><body>
<header><span class="brand">M365 <b>Code Agent</b></span><div class="toolbar"><button id="newChat" title="새 대화">＋</button><button id="history" title="연결된 대화 기록">기록</button><button id="syncWeb" title="현재 웹 대화 동기화">↻</button><button id="diagnostics" title="연결 진단">⋯</button></div></header>
<div class="toolbar"><span id="workspaceName" title="프로젝트 경로">프로젝트 미확인</span><button id="checkWorkspace" title="M365 없이 코드 읽기와 임시 파일 쓰기·삭제를 점검합니다.">프로젝트 점검</button></div>
<main id="messages" aria-live="polite"></main>
<div id="welcome"><h2>어떤 작업을 할까요?</h2><p>코드를 살펴보고, 계획하고, 함께 수정하세요.</p><button class="suggestion" data-prompt="이 프로젝트의 구조와 실행 방법을 설명해줘." data-mode="agent">프로젝트 살펴보기</button><button class="suggestion" data-prompt="현재 파일을 검토하고 버그 가능성과 테스트 계획을 알려줘." data-mode="plan">코드 검토 계획</button></div>
<footer><div id="status" role="status">Copilot 연결 후 회사 계정으로 로그인하세요.</div>
<section id="changes" hidden><strong id="changeTitle">변경 검토</strong><p id="reviewReason"></p><div id="changeFiles"></div><div class="toolbar"><button id="apply">적용</button><button id="reject">거절</button></div></section>
<section id="approval" hidden><strong>명령 실행 승인</strong><p id="commandRoot"></p><pre id="commandText"></pre><div id="commandChanges"></div><div class="toolbar"><button id="approveCommand">이번 명령 실행</button><button id="rejectCommand">거절</button></div></section>
<div id="checkpoint" hidden><span>마지막 파일 변경</span><button id="undo">되돌리기</button></div>
<form id="form"><div id="attachments"></div><label class="sr-only" for="task">개발 요청</label><textarea id="task" rows="3" maxlength="8000" placeholder="작업을 요청하세요. /plan · /review · /test"></textarea>
<div class="composer-tools"><div class="toolbar"><button id="attach" type="button" title="프로젝트 파일 첨부">＋ 파일</button><button id="connect" type="button" title="Copilot 연결 / 로그인">연결</button></div><div><button id="stop" type="button" hidden>■ 중지</button><button id="run" type="submit" title="전송 (Enter)">↑</button></div></div>
<div class="model-tools"><label class="sr-only" for="model">M365 모델</label><select id="model" title="현재 M365 계정에서 선택 가능한 모델"><option value="">M365 웹의 현재 모델</option></select><button id="refreshModels" type="button" title="웹 모델 목록 불러오기">모델 불러오기</button></div>
<div class="preferences"><label><input type="checkbox" id="includeEditor" checked> 현재 파일</label><label><input type="checkbox" id="review" checked> 변경 승인</label><span id="webSync" title="연결된 웹 대화를 5초마다 확인합니다.">M365 Copilot</span></div></form>
<p class="hint">분석·계획·수정을 바로 요청하세요 · Enter 전송 · Shift+Enter 줄바꿈</p></footer>
<script nonce="${nonce}" src="${resource('view.js')}"></script></body></html>`;
}
module.exports = { renderWebview };
