'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt } = require('../src/protocol');
const { resolveTask } = require('../src/task');

test('response language follows the original request and honors explicit language requests', () => {
  for (const task of ['Explain this project.', '이 프로젝트를 설명해줘.', 'Please explain this project in Korean.', '이 프로젝트를 영어로 설명해줘.']) {
    const prompt = buildPrompt({ id: 'language', ...resolveTask(task), workspace: 'sample' });
    assert.equal(JSON.parse(prompt.split('DATA: ')[1]).task, task);
    assert.match(prompt, /language of DATA.task/); assert.match(prompt, /explicit request takes precedence/);
    assert.equal(prompt.includes('Reply in Korean'), false);
  }
});

test('review/test shortcuts preserve user language instead of adding Korean task instructions', () => {
  for (const [command, mode, intent] of [['review', 'ask', 'review'], ['test', 'agent', 'test']]) {
    const task = 'Please inspect the current module and respond in English.';
    const resolved = resolveTask('/' + command + ' ' + task);
    assert.equal(resolved.task, task); assert.equal(resolved.mode, mode); assert.equal(resolved.intent, intent);
    const data = JSON.parse(buildPrompt({ id: 'shortcuts', ...resolved, workspace: 'sample' }).split('DATA: ')[1]);
    assert.equal(data.task, task); assert.equal(data.intent, intent);
  }
});
