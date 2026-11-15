'use strict';
/* global document, getComputedStyle, NodeFilter */

// Executed in each frame. No page text is persisted in diagnostics.
function scanResponses({ selector, id, prompt }) {
  const blocks = [],
    seen = new Set(),
    roots = [document];
  const user =
    '[data-message-author-role="user"], [data-content="user-message"], [data-testid="user-message"], [data-testid="user-turn"], [data-testid="user-query"], [data-author="user"], [data-role="user"]';
  const editor =
    'input, textarea:not([readonly]), [contenteditable="true"], [contenteditable=""], [role="textbox"]:not([aria-readonly="true"])';
  let scanned = 0,
    truncated = false;
  const parent = (element) => element.parentElement || element.getRootNode()?.host || null;
  function excluded(element) {
    for (let current = element; current; current = parent(current)) {
      if (current.matches(user + ', ' + editor + ', script, style, [aria-hidden="true"]')) return true;
    }
    return false;
  }
  function add(element, source) {
    if (
      !element ||
      !element.getClientRects().length ||
      getComputedStyle(element).visibility === 'hidden' ||
      excluded(element)
    )
      return false;
    const code = element.querySelector('.view-lines, .cm-content');
    const text = element.tagName === 'TEXTAREA' ? element.value : (code || element).textContent || '';
    const clean = text.trim();
    if (!clean || clean.length > 1024 * 1024) return false;
    if (seen.has(clean)) return true;
    // Never interpret our outgoing protocol/examples or editable draft as a reply.
    if (
      clean.startsWith('VS Code coding agent. Current requestId:') ||
      clean.startsWith('You are a coding agent used from VS Code.') ||
      (prompt && clean.includes(prompt))
    )
      return false;
    if (blocks.length >= 120) {
      truncated = true;
      return false;
    }
    seen.add(clean);
    blocks.push({ text: clean, source: code ? 'code-editor' : source });
    return true;
  }
  // Open shadow roots are common in web components. Closed roots are not read.
  for (let rootIndex = 0; rootIndex < roots.length && rootIndex < 40; rootIndex++) {
    const root = roots[rootIndex];
    for (const element of root.querySelectorAll('*')) {
      if (++scanned > 20000) {
        truncated = true;
        break;
      }
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    for (const element of [...root.querySelectorAll(selector)].slice(-80)) add(element, 'response-selector');
    if (!id) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node,
      count = 0;
    while ((node = walker.nextNode()) && count++ < 20000) {
      if (!node.nodeValue?.includes(id)) continue;
      let element = node.parentElement;
      if (!element || excluded(element)) continue;
      // Ascend only to the small response/code wrapper, never use the whole page.
      for (let level = 0; element && level < 12; level++, element = parent(element)) {
        if (/^(BODY|HTML|MAIN)$/.test(element.tagName)) break;
        const text = element.textContent || '';
        if (text.includes('"requestId"') && text.includes('"kind"') && add(element, 'request-id')) break;
      }
    }
    if (count >= 20000) truncated = true;
  }
  return { blocks, roots: roots.length, truncated };
}

const defaultResponses =
  'pre, code, [data-message-author-role="assistant"], [data-content="ai-message"], [data-testid="assistant-message"], [data-testid="copilot-message"], [data-testid="ai-message"], [data-testid="bot-message"], [data-testid="markdown-reply"], [data-testid="code-block"], .view-lines, .cm-content, textarea[readonly]';
module.exports = { scanResponses, defaultResponses };
