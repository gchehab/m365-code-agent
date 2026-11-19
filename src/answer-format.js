'use strict';

const sections = {
  projectStructure: ['프로젝트 구조', 'Project structure'],
  entryPoints: ['진입점', 'Entry points'],
  execution: ['실행 방법', 'Execution'],
  requirements: ['실행 환경', 'Requirements'],
  mainCommands: ['주요 명령', 'Main commands'],
  notes: ['참고', 'Notes'],
};
const outcomes = {
  no_changes: ['변경 제안 없음', 'No changes proposed'],
  blocked: ['모델이 진행 불가로 보고함', 'Model reported a blocker'],
  completed: ['모델이 완료로 보고함', 'Model reported completion'],
};

function fence(value) {
  const text = JSON.stringify(value, null, 2);
  const marker = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${marker}json\n${text}\n${marker}`;
}

function code(text) {
  const marker = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${marker} ${text} ${marker}`;
}

function section(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return fence(value);
  return value
    .map((item) => {
      if (typeof item === 'string') return '- ' + item.replace(/\r?\n/g, '\n  ');
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const path = item.path ?? item.file;
        if (
          typeof path === 'string' &&
          !/[\r\n]/.test(path) &&
          typeof item.role === 'string' &&
          Object.keys(item).every((key) => ['path', 'file', 'role'].includes(key)) &&
          !(Object.hasOwn(item, 'path') && Object.hasOwn(item, 'file'))
        )
          return `- ${code(path)} — ${item.role.replace(/\r?\n/g, '\n  ')}`;
      }
      return fence(item);
    })
    .join('\n\n');
}

// Presentation only: never interpret answer fields as file/tool actions. Keep the
// original stored message and any explicitly requested JSON/code block unchanged.
function formatAnswer(text, request = '') {
  if (
    typeof text !== 'string' ||
    text.length > 1024 * 1024 ||
    (typeof request === 'string' && /(?<![\w.])jsonl?(?![\w.])/i.test(request))
  )
    return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return text;
  let answer;
  try {
    answer = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (
    !answer ||
    typeof answer.summary !== 'string' ||
    !answer.summary.trim() ||
    !['no_changes', 'blocked', 'completed'].includes(answer.outcome) ||
    ['requestId', 'kind', 'files', 'calls', 'toolCalls'].some((key) => Object.hasOwn(answer, key))
  )
    return text;
  try {
    const korean = /[가-힣]/.test(answer.summary);
    const parts = [
      answer.summary,
      `**${korean ? '응답 상태' : 'Response status'}:** ${outcomes[answer.outcome][korean ? 0 : 1]}`,
    ];
    const extra = {};
    for (const [key, value] of Object.entries(answer)) {
      if (['summary', 'outcome'].includes(key)) continue;
      if (Object.hasOwn(sections, key))
        parts.push(`## ${sections[key][korean ? 0 : 1]}\n\n${section(value)}`);
      else Object.defineProperty(extra, key, { value, enumerable: true });
    }
    if (Object.keys(extra).length)
      parts.push(`## ${korean ? '추가 정보' : 'Additional information'}\n\n${fence(extra)}`);
    return parts.join('\n\n');
  } catch {
    return text;
  }
}

module.exports = { formatAnswer };
