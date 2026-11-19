'use strict';
const { conversationUrl, historyMessages } = require('./web-history');
const { inspectControls } = require('./controls');
const { t } = require('./i18n');

const modelName =
  /\b(auto|smart|gpt|claude|openai|anthropic|gemini|quick response|think deeper|reasoning)\b|자동|스마트|빠른 응답|심층|추론|깊이|automático|inteligente|resposta rápida|pensar mais fundo|pensamento profundo|raciocínio/i;
async function trigger(browser) {
  for (const frame of browser.page.frames()) {
    if (browser.options.modelButtonSelector) {
      const button = frame.locator(browser.options.modelButtonSelector).first();
      if (await button.isVisible()) return { frame, button };
    }
    for (const role of ['combobox', 'button']) {
      for (const button of await frame
        .getByRole(role, {
          name: /model|모델|응답 방식|response mode|modelo|modo de resposta|^auto$|^자동$|^automático$|quick response|resposta rápida|think deeper|pensar mais fundo|GPT-|Claude/i,
        })
        .all()) {
        if (!(await button.isVisible())) continue;
        const popup = await button.getAttribute('aria-haspopup');
        if (role === 'combobox' || ['menu', 'listbox', 'true'].includes(popup)) return { frame, button };
      }
    }
  }
  throw new Error(t('errModelMenuNotFound'));
}
async function visibleItems(frame) {
  const items = [];
  for (const role of ['option', 'menuitemradio', 'menuitem']) {
    for (const state of await frame.getByRole(role).evaluateAll(inspectControls)) {
      if (!state.visible || !state.enabled) continue;
      const label = state.label;
      if (
        !label ||
        label.length > 160 ||
        (!modelName.test(label) && !/^(more|더 보기|더보기|mais|mostrar mais|ver mais)$/i.test(label))
      )
        continue;
      items.push({ role, label, submenu: ['menu', 'true'].includes(state.popup) });
    }
  }
  return items;
}
async function openPath(browser, path) {
  for (let i = 0; i < 3; i++) await browser.page.keyboard.press('Escape');
  const menu = await trigger(browser);
  await menu.button.click();
  for (const item of path) await menu.frame.getByRole(item.role, { name: item.label, exact: true }).click();
  return menu;
}
async function listModels(browser) {
  const menu = await trigger(browser);
  if (await menu.button.evaluate((element) => element.tagName === 'SELECT')) {
    const items = await menu.button
      .locator('option')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => !node.disabled)
          .map((node) => ({ id: node.value, label: node.textContent.trim(), native: true })),
      );
    browser.modelChoices = items;
    return items;
  }
  const queue = [[]],
    choices = [];
  try {
    while (queue.length && choices.length < 30) {
      const path = queue.shift();
      const opened = await openPath(browser, path);
      for (const item of await visibleItems(opened.frame)) {
        const next = [...path, { role: item.role, label: item.label }];
        if (item.submenu && path.length < 2) queue.push(next);
        else if (!item.submenu && modelName.test(item.label))
          choices.push({
            id: JSON.stringify(next),
            label: next.map((value) => value.label).join(' › '),
            path: next,
          });
      }
      if (queue.length > 16) break;
    }
  } finally {
    for (let i = 0; i < 3; i++) await browser.page.keyboard.press('Escape');
  }
  browser.modelChoices = [...new Map(choices.map((choice) => [choice.id, choice])).values()];
  if (!browser.modelChoices.length) throw new Error(t('errModelMenuNoSelectableModels'));
  return browser.modelChoices;
}
async function selectModel(browser, id) {
  const choice = browser.modelChoices?.find((value) => value.id === id);
  if (!choice) throw new Error(t('errLoadModelListFirst'));
  if (choice.native) await (await trigger(browser)).button.selectOption(choice.id);
  else await openPath(browser, choice.path);
  browser.selectedModel = choice.label;
  return choice.label;
}
async function readConversation(browser) {
  const turns = [];
  const selector =
    '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-content="user-message"], [data-content="ai-message"], [data-testid="user-message"], [data-testid="assistant-message"], [data-testid="copilot-message"], [data-testid="ai-message"]';
  for (const frame of browser.page.frames()) {
    const result = await frame.locator(selector).evaluateAll(
      (nodes, selector) =>
        nodes
          .filter((node) => node.getClientRects().length && !node.parentElement?.closest(selector))
          .map((node) => {
            const role =
              node.getAttribute('data-message-author-role') ||
              (node.getAttribute('data-content') === 'user-message' ||
              node.getAttribute('data-testid') === 'user-message'
                ? 'user'
                : 'assistant');
            return { role, text: (node.innerText || node.textContent || '').slice(0, 1024 * 1024) };
          }),
      selector,
    );
    turns.push(...result);
  }
  return { ...conversationUrl(browser.page.url()), messages: historyMessages(turns.slice(-150)) };
}
module.exports = { listModels, selectModel, readConversation };
