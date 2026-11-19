'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, normalizeToolCall } = require('../src/protocol');
const { resolveTask } = require('../src/task');
const {
  DEFAULT_LANGUAGE,
  getLanguage,
  setLanguage,
  getAvailableLanguages,
  getLanguagePack,
  registerLanguagePack,
  t,
  ui,
} = require('../src/i18n');
const enPack = require('../src/locales/en');
const koPack = require('../src/locales/ko');
const ptBrPack = require('../src/locales/pt-BR');
const packageJson = require('../package.json');
const nlsEn = require('../package.nls.json');
const nlsKo = require('../package.nls.ko.json');
const nlsPtBr = require('../package.nls.pt-br.json');
const { renderWebview } = require('../src/view');
const { renderBrowserPanel } = require('../src/browser-panel');
const { renderResponse } = require('../src/response-panel');

test('response language follows the original request and honors explicit language requests', () => {
  for (const task of [
    'Explain this project.',
    '이 프로젝트를 설명해줘.',
    'Please explain this project in Korean.',
    '이 프로젝트를 영어로 설명해줘.',
  ]) {
    const prompt = buildPrompt({ id: 'language', ...resolveTask(task), workspace: 'sample' });
    assert.equal(JSON.parse(prompt.split('DATA: ')[1]).task, task);
    assert.match(prompt, /language of DATA.task/);
    assert.match(prompt, /explicit request takes precedence/);
    assert.equal(prompt.includes('Reply in Korean'), false);
  }
});

test('review/test shortcuts preserve user language instead of adding Korean task instructions', () => {
  for (const [command, mode, intent] of [
    ['review', 'ask', 'review'],
    ['test', 'agent', 'test'],
  ]) {
    const task = 'Please inspect the current module and respond in English.';
    const resolved = resolveTask('/' + command + ' ' + task);
    assert.equal(resolved.task, task);
    assert.equal(resolved.mode, mode);
    assert.equal(resolved.intent, intent);
    const data = JSON.parse(
      buildPrompt({ id: 'shortcuts', ...resolved, workspace: 'sample' }).split('DATA: ')[1],
    );
    assert.equal(data.task, task);
    assert.equal(data.intent, intent);
  }
});

test('i18n defaults to English, exposes available languages in settings, and switches between English and Korean', (ctx) => {
  ctx.after(() => setLanguage('en'));
  assert.equal(DEFAULT_LANGUAGE, 'en');
  setLanguage(undefined);
  assert.equal(getLanguage(), 'en');

  const available = getAvailableLanguages();
  assert.ok(available.length >= 3);
  assert.equal(available[0].code, 'en');
  assert.equal(available[0].label, 'English');
  assert.ok(available.some((item) => item.code === 'ko' && item.label.includes('한국어')));
  assert.ok(available.some((item) => item.code === 'pt-BR' && item.label === 'Português (Brasil)'));

  // Settings schema in package.json defaults to English and lists available languages
  const langSetting = packageJson.contributes.configuration.properties['m365Agent.language'];
  assert.ok(langSetting);
  assert.equal(langSetting.default, 'en');
  assert.deepEqual(langSetting.enum, ['en', 'ko', 'pt-BR']);

  // Every NLS key in package.nls.json, package.nls.ko.json, and package.nls.pt-br.json matches
  assert.deepEqual(Object.keys(nlsEn).sort(), Object.keys(nlsKo).sort());
  assert.deepEqual(Object.keys(nlsEn).sort(), Object.keys(nlsPtBr).sort());
  // Every UI and message key in en.js, ko.js, and pt-BR.js matches
  assert.deepEqual(Object.keys(enPack.ui).sort(), Object.keys(koPack.ui).sort());
  assert.deepEqual(Object.keys(enPack.ui).sort(), Object.keys(ptBrPack.ui).sort());
  assert.deepEqual(Object.keys(enPack.messages).sort(), Object.keys(koPack.messages).sort());
  assert.deepEqual(Object.keys(enPack.messages).sort(), Object.keys(ptBrPack.messages).sort());

  // Default English messages and webviews
  assert.equal(ui('attachLocal'), 'Images/Docs/Video');
  assert.equal(t('errInvalidToolArgsJson'), 'JSON format of tool arguments is invalid.');
  assert.throws(
    () => normalizeToolCall({ name: 'read_file', arguments: '{broken' }),
    /JSON format of tool arguments is invalid/,
  );

  const webviewEn = renderWebview({
    nonce: 'n',
    cspSource: 'https://test',
    resource: (name) => 'https://test/' + name,
  });
  assert.match(webviewEn, /<html lang="en">/);
  assert.match(webviewEn, /<select id="language"/);
  assert.match(webviewEn, /<option value="en" selected>English<\/option>/);
  assert.match(webviewEn, /<option value="ko">한국어 \(Korean\)<\/option>/);
  assert.match(webviewEn, /Images\/Docs\/Video/);

  const browserEn = renderBrowserPanel('n', 'https://test', (name) => 'https://test/' + name);
  assert.match(browserEn, /<html lang="en">/);
  assert.match(browserEn, /Switch to external browser/);

  const responseEn = renderResponse({
    text: 'Hello',
    nonce: 'n',
    cspSource: 'https://test',
    resource: (name) => 'https://test/' + name,
  });
  assert.match(responseEn, /<html lang="en">/);
  assert.match(responseEn, /Copy response/);

  // Switch to Korean
  setLanguage('ko');
  assert.equal(getLanguage(), 'ko');
  assert.equal(ui('attachLocal'), '이미지·문서·동영상');
  assert.equal(t('errInvalidToolArgsJson'), '도구 인자의 JSON 형식이 올바르지 않습니다.');
  assert.throws(
    () => normalizeToolCall({ name: 'read_file', arguments: '{broken' }),
    /도구 인자의 JSON 형식이 올바르지 않습니다/,
  );

  const webviewKo = renderWebview({
    nonce: 'n',
    cspSource: 'https://test',
    resource: (name) => 'https://test/' + name,
  });
  assert.match(webviewKo, /<html lang="ko">/);
  assert.match(webviewKo, /<option value="ko" selected>한국어 \(Korean\)<\/option>/);
  assert.match(webviewKo, /이미지·문서·동영상/);

  // Switch to Brazilian Portuguese
  setLanguage('pt-BR');
  assert.equal(getLanguage(), 'pt-BR');
  assert.equal(ui('attachLocal'), 'Imagens/Docs/Vídeo');
  assert.equal(t('errInvalidToolArgsJson'), 'O formato JSON dos argumentos da ferramenta é inválido.');
  assert.throws(
    () => normalizeToolCall({ name: 'read_file', arguments: '{broken' }),
    /O formato JSON dos argumentos da ferramenta é inválido/,
  );

  const webviewPt = renderWebview({
    nonce: 'n',
    cspSource: 'https://test',
    resource: (name) => 'https://test/' + name,
  });
  assert.match(webviewPt, /<html lang="pt-BR">/);
  assert.match(webviewPt, /<option value="pt-BR" selected>Português \(Brasil\)<\/option>/);
  assert.match(webviewPt, /Imagens\/Docs\/Vídeo/);
});

test('custom partial language packs inherit missing keys from the default English pack', (t) => {
  t.after(() => setLanguage('en'));
  registerLanguagePack({
    code: 'custom-test',
    label: 'Custom Test',
    ui: { connect: 'Custom Connect' },
    messages: {},
  });
  const pack = getLanguagePack('custom-test');
  assert.equal(pack.ui.connect, 'Custom Connect');
  assert.equal(pack.ui.attachLocal, enPack.ui.attachLocal);
  assert.equal(pack.messages.errTaskStopped, enPack.messages.errTaskStopped);
});
