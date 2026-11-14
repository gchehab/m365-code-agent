'use strict';

// Unknown wording keeps the normal tool set. A missing verb must never make an
// editing request read-only, and matching a verb never forces a file change.
function resolveTask(task) {
  if (/^\/ask(?:\s|$)/i.test(task)) return { mode: 'ask', task: task.replace(/^\/ask\s*/i, '') || '현재 프로젝트를 읽고 구조와 실행 방법을 설명해줘.' };
  if (/^\/agent(?:\s|$)/i.test(task)) return { mode: 'agent', task: task.replace(/^\/agent\s*/i, '') || '현재 프로젝트를 살펴보고 필요한 작업을 도와줘.' };
  if (/^\/plan(?:\s|$)/i.test(task)) return { mode: 'plan', task: task.replace(/^\/plan\s*/i, '') || '현재 프로젝트의 개선 계획을 세워줘.' };
  if (/^\/review(?:\s|$)/i.test(task)) return { mode: 'ask', task: '버그와 회귀 위험을 중심으로 코드를 검토하고 파일과 근거를 알려줘. ' + task.replace(/^\/review\s*/i, '') };
  if (/^\/test(?:\s|$)/i.test(task)) return { mode: 'agent', task: '프로젝트의 테스트 방법을 확인하고 필요한 테스트를 실행해서 실제 결과를 알려줘. ' + task.replace(/^\/test\s*/i, '') };
  const noChanges = /수정하지|변경하지|변경 없이|수정 없이|읽기\s*전용|do not (?:edit|change|modify)|read[ -]only/i.test(task);
  const explicitAction = /(?:수정|변경|구현|추가|생성|작성|적용|업데이트|리팩토링|리팩터링|개선|정리)(?:해|하[고여]|해\s*주)|고쳐|바꿔|넣어|실행해|돌려|^(?:please\s+)?(?:fix|edit|update|add|create|implement|refactor|run)\b|\b(?:and|then)\s+(?:fix|edit|update|add|create|implement|refactor|run)\b/i.test(task);
  const question = /설명|알려|분석해|검토해|검토하고|어떻게|왜\s|무엇|뭐야|[?？]\s*$|\b(?:explain|analy[sz]e|review|how|why|what)\b/i.test(task);
  const plan = /계획|\bplan\b/i.test(task);
  return { task, mode: noChanges || (!explicitAction && (question || plan)) ? (plan ? 'plan' : 'ask') : 'agent' };
}
module.exports = { resolveTask };
