'use strict';
// Shared by the conversation and the wider, read-only response view.
window.M365Reading = (api) => {
  const copies = new Map();
  const ui = (key) => window.M365_I18N?.ui?.[key] || key;
  window.addEventListener('message', ({ data }) => {
    if (data?.type !== 'copyResult' || !copies.has(data.id)) return;
    const { button, key, fallbackLabel, timeout } = copies.get(data.id);
    copies.delete(data.id);
    clearTimeout(timeout);
    button.textContent = data.success ? ui('copied') : ui('copyFailed');
    button.disabled = false;
    setTimeout(() => {
      button.textContent = key ? ui(key) : fallbackLabel;
    }, 1800);
  });
  function copy(text, button, type = 'copyCode', key = '') {
    const id = crypto.randomUUID(),
      fallbackLabel = button.textContent;
    button.disabled = true;
    const timeout = setTimeout(() => {
      copies.delete(id);
      button.disabled = false;
      button.textContent = key ? ui(key) : fallbackLabel;
    }, 5000);
    copies.set(id, { button, key, fallbackLabel, timeout });
    api.postMessage({ type, id, text });
  }
  function wrapButton(block) {
    const wrapped = block.dataset.wrap
      ? block.dataset.wrap === 'on'
      : document.body.classList.contains('wrap-code');
    block.querySelector('.wrap-button').setAttribute('aria-pressed', String(wrapped));
  }
  function setWrap(enabled) {
    document.body.classList.toggle('wrap-code', enabled);
    for (const block of document.querySelectorAll('.code-block')) {
      delete block.dataset.wrap;
      wrapButton(block);
    }
  }
  function enhance(body) {
    for (const code of body.querySelectorAll('pre > code')) {
      const pre = code.parentElement,
        block = document.createElement('div');
      block.className = 'code-block';
      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      const language = document.createElement('span');
      const explicitLang = code.className.replace('language-', '');
      if (explicitLang) language.dataset.explicitLang = explicitLang;
      language.textContent = explicitLang || ui('codeDefaultLabel');
      const actions = document.createElement('div');
      actions.className = 'code-actions';
      const wrap = document.createElement('button');
      wrap.type = 'button';
      wrap.className = 'wrap-button';
      wrap.textContent = ui('wrapButton');
      wrap.title = ui('wrapButtonTitle');
      wrap.addEventListener('click', () => {
        block.dataset.wrap = wrap.getAttribute('aria-pressed') === 'true' ? 'off' : 'on';
        wrapButton(block);
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-button';
      button.textContent = ui('copyButton');
      button.setAttribute('aria-label', ui('copyCodeAriaLabel'));
      button.addEventListener('click', () => copy(code.textContent, button, 'copyCode', 'copyButton'));
      actions.append(wrap, button);
      toolbar.append(language, actions);
      pre.before(block);
      block.append(toolbar, pre);
      wrapButton(block);
    }
    for (const link of body.querySelectorAll('a'))
      link.addEventListener('click', (event) => {
        event.preventDefault();
        api.postMessage({ type: 'openLink', url: link.href });
      });
  }
  function refreshLanguage() {
    for (const block of document.querySelectorAll('.code-block')) {
      const language = block.querySelector('.code-toolbar > span');
      if (language && !language.dataset.explicitLang) language.textContent = ui('codeDefaultLabel');
      const wrap = block.querySelector('.wrap-button');
      if (wrap) {
        wrap.textContent = ui('wrapButton');
        wrap.title = ui('wrapButtonTitle');
      }
      const copyBtn = block.querySelector('.copy-button');
      if (copyBtn) {
        copyBtn.textContent = ui('copyButton');
        copyBtn.setAttribute('aria-label', ui('copyCodeAriaLabel'));
      }
    }
  }
  return { copy, enhance, setWrap, refreshLanguage };
};
