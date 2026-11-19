'use strict';

// Unknown wording keeps the normal tool set. A missing verb must never make an
// editing request read-only, and matching a verb never forces a file change.
function resolveTask(task) {
  if (/^\/ask(?:\s|$)/i.test(task))
    return {
      mode: 'ask',
      task: task.replace(/^\/ask\s*/i, '') || 'Read the project and explain its structure and how to run it.',
    };
  if (/^\/agent(?:\s|$)/i.test(task))
    return {
      mode: 'agent',
      task: task.replace(/^\/agent\s*/i, '') || 'Inspect the project and help with the requested work.',
    };
  if (/^\/plan(?:\s|$)/i.test(task))
    return {
      mode: 'plan',
      task: task.replace(/^\/plan\s*/i, '') || 'Create an improvement plan for the current project.',
    };
  if (/^\/review(?:\s|$)/i.test(task))
    return {
      mode: 'ask',
      intent: 'review',
      task: task.replace(/^\/review\s*/i, '') || 'Review the project for bugs, regressions and test gaps.',
    };
  if (/^\/test(?:\s|$)/i.test(task))
    return {
      mode: 'agent',
      intent: 'test',
      task:
        task.replace(/^\/test\s*/i, '') ||
        'Inspect the project test setup, run the tests and report the actual results.',
    };
  const noChanges =
    /수정하지|변경하지|변경 없이|수정 없이|읽기\s*전용|do not (?:edit|change|modify)|read[ -]only|não (?:edite|altere|modifique)|somente leitura/i.test(
      task,
    );
  const explicitAction =
    /(?:수정|변경|구현|추가|생성|작성|적용|업데이트|리팩토링|리팩터링|개선|정리)(?:해|하[고여]|해\s*주)|고쳐|바꿔|넣어|실행해|돌려|^(?:please\s+|por favor\s+)?(?:fix|edit|update|add|create|implement|refactor|run|corrija|edite|atualize|adicione|crie|implemente|refatore|execute)\b|\b(?:and|then|e|depois)\s+(?:fix|edit|update|add|create|implement|refactor|run|corrija|edite|atualize|adicione|crie|implemente|refatore|execute)\b/i.test(
      task,
    );
  const question =
    /설명|알려|분석해|검토해|검토하고|어떻게|왜\s|무엇|뭐야|[?？]\s*$|\b(?:explain|analy[sz]e|review|how|why|what|explique|analise|revise|como|por que|o que)\b/i.test(
      task,
    );
  const plan = /계획|\b(?:plan|plano|planeje)\b/i.test(task);
  return {
    task,
    mode: noChanges || (!explicitAction && (question || plan)) ? (plan ? 'plan' : 'ask') : 'agent',
  };
}
module.exports = { resolveTask };
