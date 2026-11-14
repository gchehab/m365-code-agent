'use strict';
const { parseReply } = require('./protocol');

const allowedHosts = new Set(['m365.cloud.microsoft', 'copilot.cloud.microsoft', 'www.microsoft365.com', 'microsoft365.com', 'www.office.com', 'office.com']);
function validateCopilotUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('회사 M365 Copilot의 HTTPS 주소만 연결할 수 있습니다.');
  return url.href;
}

const defaultComposers = [
  '#userInput', '#m365-chat-editor-target-element',
  '[data-testid="chat-input"]', '[data-testid="chat-composer"] [contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]', 'textarea[placeholder]',
  '[contenteditable="true"][data-lexical-editor="true"]', '[contenteditable="true"][role="combobox"]'
];

class CopilotBrowser {
  constructor(options) {
    this.options = options;
    this.context = null;
    this.page = null;
    this.busy = false;
    this.cancelled = false;
  }
  async connect() {
    if (!this.connecting) this.connecting = this.openConnection().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async openConnection() {
    if (this.context) {
      const pages = this.context.pages().filter(page => !page.isClosed());
      const copilot = pages.filter(page => { try { validateCopilotUrl(page.url()); return true; } catch { return false; } });
      if (copilot.length) this.page = copilot.at(-1);
    }
    if (this.context && this.page && !this.page.isClosed()) {
      if (this.page.url() === 'about:blank' || this.page.url().startsWith('chrome-error:')) {
        await this.page.goto(validateCopilotUrl(this.options.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      return;
    }
    const url = validateCopilotUrl(this.options.url);
    const { chromium } = require('playwright-core');
    this.context = await chromium.launchPersistentContext(this.options.profile, {
      channel: this.options.channel || 'msedge', headless: false,
      viewport: null, acceptDownloads: false, locale: 'ko-KR'
    });
    this.context.on('close', () => { this.context = null; this.page = null; });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(7000);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  async getComposer() {
    const configured = this.options.composerSelector;
    const selectors = configured ? [configured] : defaultComposers;
    // Copilot can render the composer inside a same-origin or accessible child frame.
    for (const frame of this.page.frames()) {
      for (const selector of selectors) {
        const candidates = frame.locator(selector);
        for (const locator of (await candidates.all()).slice(0, 8)) {
          try {
            if (await locator.isVisible() && await locator.isEditable()) return { locator, frame, selector };
          } catch { /* An ID can belong to a non-editable wrapper in some tenant versions. */ }
        }
      }
    }
    throw new Error('Copilot 입력창을 찾지 못했습니다. 전용 Edge 창에서 로그인하고 대화 화면을 연 뒤 다시 연결하세요. 화면 구조가 달라졌다면 입력창 CSS 선택자를 설정하세요.');
  }
  async waitForComposer() {
    const deadline = Date.now() + 10000;
    while (true) {
      if (this.cancelled) throw new Error('작업을 중지했습니다.');
      try { return await this.getComposer(); }
      catch (error) {
        if (Date.now() >= deadline || this.page.isClosed()) throw error;
        await this.page.waitForTimeout(250);
      }
    }
  }
  async diagnostics() {
    await this.connect();
    let composer;
    try { composer = (await this.getComposer()).selector; } catch (error) { composer = error.message; }
    return { url: this.page.url().split('?')[0], title: await this.page.title(), composer, frames: this.page.frames().length, lastSend: this.lastSend || null };
  }
  async findSendButton(frame, composer) {
    const groups = this.options.sendButtonSelector ? [frame.locator(this.options.sendButtonSelector)] : [
      frame.getByRole('button', { name: /^(send|send message|send prompt|submit|submit prompt|보내기|전송|제출|메시지 보내기|메시지 전송|질문 보내기|프롬프트 제출|프롬프트 보내기)(\s*\(.*\))?$/i }),
      frame.locator('button[data-testid="send-button"], button[data-testid="sendButton"], button[data-testid="send-message-button"], button[data-testid="submit-button"], button#submit-button, button#sendMessageButton, button:has([data-icon-name="Send"])'),
      composer.locator('xpath=ancestor::form[1]').locator('button[type="submit"]')
    ];
    for (const group of groups) for (const button of (await group.all()).slice(0, 12)) {
      if (await button.isVisible() && await button.isEnabled()) return button;
    }
    return null;
  }
  async submitPrompt(locator, frame, prompt, baseline, id) {
    const readDraft = () => locator.evaluate(element => ('value' in element ? element.value : element.innerText) || '');
    if ((await readDraft()).replace(/\r\n/g, '\n') !== prompt.replace(/\r\n/g, '\n')) throw new Error('Copilot 입력창에 요청 전체가 입력되지 않았습니다. 입력 길이 제한을 확인하세요.');
    let button;
    const readyDeadline = Date.now() + (this.options.sendReadyTimeoutMs || 8000);
    while (Date.now() < readyDeadline) {
      if (this.cancelled) throw new Error('작업을 중지했습니다.');
      button = await this.findSendButton(frame, locator);
      if (button) break;
      await this.page.waitForTimeout(200);
    }
    if (!button) {
      this.lastSend = { stage: 'button-not-ready', characters: prompt.length };
      throw new Error('전송 버튼을 찾지 못했거나 활성화되지 않았습니다. Copilot 로그인·입력 길이 제한을 확인하세요. 요청은 전송하지 않았습니다.');
    }
    this.lastSend = { stage: 'clicked', characters: prompt.length };
    await button.click({ timeout: 5000 });
    const deadline = Date.now() + (this.options.sendAckTimeoutMs || 12000);
    while (Date.now() < deadline) {
      if (this.cancelled) throw new Error('작업을 중지했습니다.');
      const cleared = await readDraft().then(text => !text.trim()).catch(() => false);
      const generating = await this.generationActive();
      let reply = false;
      for (const text of await this.responseCandidates()) {
        if (baseline.has(text)) continue;
        try { parseReply(text, id); reply = true; break; } catch { /* Not a complete response yet. */ }
      }
      if (cleared || generating || reply) {
        this.lastSend.stage = 'confirmed';
        return;
      }
      await this.page.waitForTimeout(200);
    }
    this.lastSend.stage = 'unconfirmed';
    throw new Error('전송 버튼을 눌렀지만 제출을 확인하지 못했습니다. Edge 창의 제한·오류 메시지를 확인하세요. 중복 전송을 피하려고 자동 재전송하지 않았습니다.');
  }
  async responseCandidates() {
    const texts = [];
    const selector = this.options.responseSelector || 'pre, code, [data-message-author-role="assistant"], [data-content="ai-message"], [data-testid="assistant-message"], [data-testid="copilot-message"]';
    for (const frame of this.page.frames()) {
      const blocks = await frame.locator(selector).evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => node.innerText || node.textContent || ''));
      texts.push(...blocks.slice(-80).map(text => text.slice(0, 1024 * 1024)));
    }
    return texts;
  }
  async generationActive() {
    const pattern = /^(Stop generating|Stop responding|Stop response|응답 중지|생성 중지|답변 중지|중지)$/i;
    for (const frame of this.page.frames()) {
      for (const button of await frame.getByRole('button', { name: pattern }).all()) if (await button.isVisible()) return true;
    }
    return false;
  }
  async newChat() {
    await this.connect();
    const name = /^(새 채팅|새 대화|New chat|New conversation)$/i;
    for (const frame of this.page.frames()) {
      for (const role of ['button', 'link']) {
        for (const button of await frame.getByRole(role, { name }).all()) {
          if (await button.isVisible()) { await button.click(); return; }
        }
      }
    }
    throw new Error('새 대화 버튼을 찾지 못했습니다. 전용 브라우저에서 새 채팅을 선택하세요. 기존 대화에서 작업을 계속하는 것도 가능합니다.');
  }
  async request(prompt, id, onStatus = () => {}) {
    if (this.busy) throw new Error('이미 Copilot 응답을 기다리는 중입니다.');
    this.busy = true;
    this.cancelled = false;
    this.lastSend = null;
    let submitted = false;
    try {
      await this.connect();
      validateCopilotUrl(this.page.url());
      const { locator, frame } = await this.waitForComposer();
      const draft = await locator.evaluate(element => ('value' in element ? element.value : element.innerText) || '');
      if (draft.trim()) throw new Error('Copilot 입력창에 작성 중인 내용이 있습니다. 덮어쓰지 않았습니다. 전용 창에서 내용을 정리한 뒤 다시 실행하세요.');
      if (await this.generationActive()) throw new Error('Copilot이 다른 응답을 생성 중입니다. 완료 후 다시 실행하세요.');
      const baseline = new Set(await this.responseCandidates());
      onStatus('Copilot에 요청을 보내고 있습니다…');
      await locator.fill(prompt);
      if (this.cancelled) throw new Error('작업을 중지했습니다.');
      await this.submitPrompt(locator, frame, prompt, baseline, id);
      submitted = true;
      onStatus('전송 확인됨 · Copilot 응답을 기다리고 있습니다…');
      const deadline = Date.now() + (this.options.timeoutSeconds || 240) * 1000;
      let candidateText = '', stableSince = 0, reported = false;
      while (Date.now() < deadline) {
        if (this.cancelled) throw new Error('작업을 중지했습니다.');
        if (this.page.isClosed()) throw new Error('Copilot 브라우저 창이 닫혔습니다.');
        validateCopilotUrl(this.page.url());
        const blocks = await this.responseCandidates();
        let found = '';
        for (const text of blocks.reverse()) {
          if (baseline.has(text) || !text.includes(id)) continue;
          try { parseReply(text, id); found = text; break; } catch { /* Still streaming or unrelated block. */ }
        }
        if (found) {
          if (found !== candidateText) { candidateText = found; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 2500 && !(await this.generationActive())) return parseReply(found, id);
        } else { candidateText = ''; stableSince = 0; }
        if (!reported) { onStatus('Copilot 응답을 자동으로 수집하고 있습니다…'); reported = true; }
        await this.page.waitForTimeout(500);
      }
      throw new Error('시간 안에 올바른 응답을 받지 못했습니다. 전용 창에서 로그인·사용량 제한·응답 형식을 확인하세요. 요청은 자동 재전송하지 않았습니다.');
    } finally {
      if ((this.cancelled || this.lastSend?.stage === 'button-not-ready') && !submitted && this.page && !this.page.isClosed()) {
        try {
          const { locator } = await this.getComposer();
          const draft = await locator.evaluate(element => ('value' in element ? element.value : element.innerText) || '');
          if (draft === prompt) await locator.fill('');
        } catch { /* Never clear a draft that is not exactly the one we inserted. */ }
      }
      this.busy = false;
    }
  }
  async stop() {
    this.cancelled = true;
    if (!this.page || this.page.isClosed()) return;
    try {
      for (const frame of this.page.frames()) {
        const buttons = frame.getByRole('button', { name: /^(Stop generating|Stop responding|응답 중지|생성 중지|답변 중지)$/i });
        for (const button of await buttons.all()) if (await button.isVisible()) { await button.click({ timeout: 2000 }); return; }
      }
    } catch { /* Local cancellation still prevents applying subsequent results. */ }
  }
  async close() {
    this.cancelled = true;
    if (this.context) await this.context.close();
  }
}
module.exports = { CopilotBrowser, validateCopilotUrl };
