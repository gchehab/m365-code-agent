'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatAnswer } = require('../src/answer-format');
const { decorate, decorateHistory } = require('../src/markdown');
const report = require('./fixtures/structured-answer.json');
const raw = JSON.stringify(report);

test('reported analysis JSON is presented as Markdown with every section and value retained', () => {
  const result = decorate({ type: 'message', role: 'assistant', text: raw }, '프로젝트를 분석해줘');
  assert.ok(result.text.startsWith(report.summary));
  for (const heading of ['프로젝트 구조', '진입점', '실행 방법', '실행 환경', '주요 명령', '참고']) assert.ok(result.text.includes('## ' + heading));
  for (const item of report.projectStructure) { assert.ok(result.text.includes(item.path)); assert.ok(result.text.includes(item.role)); }
  for (const value of [report.execution, ...report.requirements, ...report.mainCommands, ...report.notes]) assert.ok(result.text.includes(value));
  assert.match(result.html, /<h2>프로젝트 구조<\/h2>/);
  assert.match(result.html, /<code>src\/<\/code>/);
  assert.ok(!result.text.includes('"projectStructure"'));
});

test('saved history is formatted without modifying stored messages and explicit JSON remains exact', () => {
  const events = [{ type: 'message', role: 'user', text: '프로젝트 설명' }, { type: 'message', role: 'assistant', text: raw }, { type: 'message', role: 'user', text: '같은 분석을 JSON으로만 출력해줘' }, { type: 'message', role: 'assistant', text: raw }];
  const original = structuredClone(events);
  const rendered = decorateHistory(events);
  assert.notEqual(rendered[1].text, raw);
  assert.equal(rendered[3].text, raw);
  assert.deepEqual(events, original);
  assert.notEqual(formatAnswer(raw, 'package.json을 분석해줘'), raw, 'a filename is not a JSON output request');
  for (const request of ['Output JSON only', 'JSON 형식으로 응답해줘', 'Return JSONL']) assert.equal(formatAnswer(raw, request), raw);
});

test('ordinary prose, JSON examples, unrelated objects and malformed text are untouched', () => {
  for (const text of ['# 설명\n\n```json\n' + raw + '\n```', '```json\n' + raw + '\n```', '{"key":"value"}', '{"summary":"incomplete"', '설명과 {"outcome":"no_changes","summary":"예제"}']) assert.equal(formatAnswer(text), text);
  const event = { type: 'message', role: 'user', text: raw };
  assert.equal(decorate(event), event);
});

test('action envelopes are never unwrapped, unknown report fields are visible data and HTML stays inert', () => {
  for (const key of ['requestId', 'kind', 'files', 'calls', 'toolCalls']) {
    const text = JSON.stringify({ ...report, [key]: [{ command: 'never execute this' }] });
    assert.equal(formatAnswer(text), text);
  }
  const unknown = { details: { command: 'never execute this', extra: '```\n<script>danger()</script>' } };
  const result = decorate({ type: 'message', role: 'assistant', text: JSON.stringify({ outcome: 'blocked', summary: '<script>danger()</script>', ...unknown }) });
  assert.ok(result.text.includes('never execute this'));
  assert.ok(result.text.includes('## Additional information'));
  assert.ok(!result.html.includes('<script>'));
  assert.ok(result.html.includes('&lt;script&gt;'));
  const english = formatAnswer(JSON.stringify({ outcome: 'no_changes', summary: 'Project analysis', requirements: ['Windows'] }));
  assert.ok(english.includes('## Requirements'));
  assert.ok(!english.includes('실행 환경'));
});
