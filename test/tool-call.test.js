'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeToolCall } = require('../src/protocol');

test('malformed JSON tool arguments use a Korean message and retain the syntax cause', () => {
  assert.throws(() => normalizeToolCall({ name: 'read_file', arguments: '{broken' }), error => error.message === '도구 인자의 JSON 형식이 올바르지 않습니다.' && error.cause instanceof SyntaxError);
});

test('tool calls normalize nested JSON and aliases but never trust model field types', () => {
  assert.deepEqual(normalizeToolCall({ function: { name: 'read_file', arguments: '{"file_path":"main.js","start_line":2,"line_count":4}' } }), { name: 'read_file', path: 'main.js', startLine: 2, lineCount: 4 });
  for (const value of [null, [], { name: '' }, { name: 'read_file', path: 42 }, { name: 'read_file', startLine: '2' }, { name: 'search_text', paths: [123] }, { name: 'list_files', limit: Infinity }, { name: 'read_file', arguments: '[]' }]) assert.throws(() => normalizeToolCall(value));
  assert.deepEqual(normalizeToolCall({ name: 'search_text', query: 'hello', paths: ['src'], directory: true }), { name: 'search_text', query: 'hello', paths: ['src'] });
});
