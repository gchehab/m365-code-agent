'use strict';
const { parseReply, replyIdentity, mergeReplies } = require('./protocol');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  normalizeDraft,
  matchesPrompt,
  readComposer,
  promptLimitError,
  isAgentProtocolDraft,
} = require('./composer');
const { scanResponses, defaultResponses } = require('./responses');
const { conversationUrl } = require('./web-history');
const { inspectControls, firstReadyControl, anyReadyControl } = require('./controls');
const { connectionError } = require('./connection');
const { prepareAttachments, verifyAttachments } = require('./browser-attachments');
const { t, getLanguagePack, getWebUiPattern } = require('./i18n');

function buildAcceptLanguageHeader(locale) {
  const clean = String(locale || 'en-US').trim() || 'en-US';
  const primary = clean.split('-')[0];
  const parts = [clean];
  if (primary && primary.toLowerCase() !== clean.toLowerCase()) parts.push(`${primary};q=0.9`);
  if (!/^en(?:-|$)/i.test(clean)) parts.push('en-US;q=0.8', 'en;q=0.7');
  return parts.join(',');
}

async function syncProfileLocale(profileDir, locale) {
  if (!profileDir || typeof profileDir !== 'string') return;
  try {
    const clean = String(locale || 'en-US').trim() || 'en-US';
    const primary = clean.split('-')[0];
    const acceptLanguages =
      primary && primary.toLowerCase() !== clean.toLowerCase() ? `${clean},${primary}` : clean;
    const defaultDir = path.join(profileDir, 'Default');
    await fs.mkdir(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, 'Preferences');
    let prefs = {};
    try {
      prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
    } catch {
      prefs = {};
    }
    prefs.intl = { ...(prefs.intl || {}), accept_languages: acceptLanguages };
    await fs.writeFile(prefsPath, JSON.stringify(prefs), 'utf8');
  } catch {
    /* Non-fatal: launchPersistentContext still passes locale, --lang, and extraHTTPHeaders. */
  }
}

const allowedHosts = new Set([
  'm365.cloud.microsoft',
  'copilot.cloud.microsoft',
  'www.microsoft365.com',
  'microsoft365.com',
  'www.office.com',
  'office.com',
]);
const authHosts = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'account.microsoft.com',
]);
function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && authHosts.has(url.hostname);
  } catch {
    return false;
  }
}
function validateCopilotUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !allowedHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw new Error(t('errHttpsCopilotUrlOnly'));
  return url.href;
}

const defaultComposers = [
  '#userInput',
  '#m365-chat-editor-target-element',
  '[data-testid="chat-input"]',
  '[data-testid="chat-composer"] [contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
  'textarea[placeholder]',
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="combobox"]',
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
    if (!this.connecting)
      this.connecting = this.openConnection()
        .catch((error) => {
          const failure = connectionError(error, this.connectionStage || 'launch', this.options);
          this.lastConnectionFailure = failure.connectionFailure;
          throw failure;
        })
        .finally(() => {
          this.connecting = null;
        });
    return this.connecting;
  }
  async openConnection() {
    this.connectionStage = 'reuse';
    if (this.context) {
      try {
        const pages = this.context.pages().filter((page) => !page.isClosed());
        if (!this.page || this.page.isClosed()) {
          this.page =
            pages.findLast((page) => {
              try {
                validateCopilotUrl(page.url());
                return true;
              } catch {
                return false;
              }
            }) ||
            pages.at(-1) ||
            (await this.context.newPage());
        }
      } catch (error) {
        if (!/closed|disposed/i.test(error.message)) throw error;
        this.context = null;
        this.page = null;
      }
    }
    if (!this.context) {
      this.connectionStage = 'url';
      validateCopilotUrl(this.options.url);
      this.connectionStage = 'launch';
      const activeLocale = this.options.locale || getLanguagePack().browserLocale;
      await syncProfileLocale(this.options.profile, activeLocale);
      const { chromium } = require('playwright-core');
      const context = await chromium.launchPersistentContext(this.options.profile, {
        channel: this.options.channel || 'msedge',
        headless: Boolean(this.options.embedded),
        viewport: this.options.embedded ? { width: 1100, height: 760 } : null,
        acceptDownloads: false,
        locale: activeLocale,
        args: [`--lang=${activeLocale}`, `--accept-lang=${activeLocale}`],
        extraHTTPHeaders: {
          'Accept-Language': buildAcceptLanguageHeader(activeLocale),
        },
      });
      this.context = context;
      context.on('close', () => {
        if (this.context === context) {
          this.context = null;
          this.page = null;
        }
      });
      this.page = context.pages()[0] || (await context.newPage());
      this.needsNavigation = true;
    }
    this.page.setDefaultTimeout(7000);
    const current = this.page.url();
    if (this.needsNavigation && current !== 'about:blank' && !current.startsWith('chrome-error:')) {
      // Preserve a working composer or a sign-in page after a navigation timeout.
      if (
        isLoginUrl(current) ||
        (await this.getComposer()
          .then(() => true)
          .catch(() => false))
      )
        this.needsNavigation = false;
    }
    if (this.needsNavigation || current === 'about:blank' || current.startsWith('chrome-error:')) {
      this.connectionStage = 'navigation';
      this.needsNavigation = true;
      await this.page.goto(validateCopilotUrl(this.options.url), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      this.needsNavigation = false;
    }
    this.connectionStage = 'ready';
    this.lastConnectionFailure = null;
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
            if ((await locator.isVisible()) && (await locator.isEditable()))
              return { locator, frame, selector };
          } catch {
            /* An ID can belong to a non-editable wrapper in some tenant versions. */
          }
        }
      }
    }
    throw new Error(t('errComposerNotFound'));
  }
  async waitForComposer(onStatus = () => {}) {
    const deadline =
      Date.now() + (this.options.loginTimeoutMs ?? (this.options.loginTimeoutSeconds || 600) * 1000);
    let handle,
      readySince = 0,
      lastStatus = '';
    const report = (text) => {
      if (text !== lastStatus) {
        onStatus(text);
        lastStatus = text;
      }
    };
    try {
      while (true) {
        if (this.cancelled) throw new Error(t('errTaskStopped'));
        if (!this.context || !this.context.pages().some((page) => !page.isClosed()))
          throw new Error(t('errCopilotBrowserClosedNotSent'));
        if (Date.now() >= deadline) throw new Error(t('errLoginComposerTimeout'));
        let candidate;
        for (const page of [this.page, ...[...this.context.pages()].reverse()].filter(
          (page, index, all) => page && !page.isClosed() && all.indexOf(page) === index,
        )) {
          try {
            validateCopilotUrl(page.url());
          } catch {
            continue;
          }
          this.page = page;
          try {
            candidate = await this.getComposer();
            break;
          } catch {
            /* Login redirect or app hydration. */
          }
        }
        if (candidate) {
          if (
            handle &&
            this.readyPage === this.page &&
            this.readyFrame === candidate.frame &&
            (await handle.evaluate((element) => element.isConnected).catch(() => false))
          ) {
            if (Date.now() - readySince >= (this.options.composerStableMs ?? 900)) return candidate;
          } else {
            await handle?.dispose();
            handle = await candidate.locator.elementHandle();
            readySince = Date.now();
            this.readyPage = this.page;
            this.readyFrame = candidate.frame;
          }
          report(t('statusComposerPreparingHold'));
        } else {
          await handle?.dispose();
          handle = null;
          readySince = 0;
          const pages = this.context.pages().filter((page) => !page.isClosed());
          if (pages.some((page) => isLoginUrl(page.url()))) report(t('statusWaitingLoginMfa'));
          else {
            report(t('statusWaitingCopilotScreen'));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.readinessPollMs ?? 250));
      }
    } finally {
      await handle?.dispose().catch(() => {});
    }
  }
  async diagnostics({ connect = true } = {}) {
    if (connect) await this.connect();
    let composer;
    try {
      composer = (await this.getComposer()).selector;
    } catch (error) {
      composer = error.message;
    }
    return {
      url: this.page.url().split(/[?#]/)[0],
      connectionStage: this.connectionStage || 'ready',
      title: await this.page.title(),
      composer,
      frames: this.page.frames().length,
      lastSend: this.lastSend || null,
      lastResponse: this.lastResponse || null,
    };
  }
  async findSendButton(frame, composer) {
    const groups = this.options.sendButtonSelector
      ? [frame.locator(this.options.sendButtonSelector)]
      : [
          frame.getByRole('button', {
            name: getWebUiPattern('send', '(\\s*\\(.*\\))?'),
          }),
          frame.locator(
            'button[data-testid="send-button"], button[data-testid="sendButton"], button[data-testid="send-message-button"], button[data-testid="submit-button"], button#submit-button, button#sendMessageButton, button:has([data-icon-name="Send"])',
          ),
          composer.locator('xpath=ancestor::form[1]').locator('button[type="submit"]'),
        ];
    for (const group of groups) {
      const button = await firstReadyControl(group);
      if (button) return button;
    }
    return null;
  }
  async submitPrompt(locator, frame, prompt, baseline, id) {
    let button;
    try {
      const readyDeadline = Date.now() + (this.options.sendReadyTimeoutMs || 8000);
      while (Date.now() < readyDeadline) {
        if (this.cancelled) throw new Error(t('errTaskStopped'));
        button = await this.findSendButton(frame, locator);
        if (button) {
          let actionable = false;
          try {
            await button.click({
              trial: true,
              timeout: Math.max(1, Math.min(750, readyDeadline - Date.now())),
            });
            actionable = true;
          } catch {
            /* No click was dispatched; safely find a replacement control. */
          }
          if (actionable) {
            await this.verifyInput(locator, prompt);
            const [state] = await button.evaluate(inspectControls).catch(() => [{ visible: false }]);
            if (state.visible && state.enabled) break;
          }
          await button.dispose().catch(() => {});
          button = null;
        }
        await this.page.waitForTimeout(200);
      }
      if (!button) {
        await this.verifyInput(locator, prompt);
        this.lastSend.stage = 'button-not-ready';
        throw new Error(t('errSendButtonNotReady'));
      }
      await this.verifyInput(locator, prompt);
      if (this.cancelled) throw new Error(t('errTaskStopped'));
      await verifyAttachments(this, locator, id);
      this.lastSend.stage = 'clicked';
      // Pin one DOM element and attempt a real click only once. Even if the page
      // replaces it during dispatch, inspect acknowledgement rather than re-clicking.
      let clickError;
      try {
        await button.click({ timeout: 2000 });
      } catch (error) {
        clickError = error;
        this.lastSend.clickError = error.name;
      }
      const deadline = Date.now() + (this.options.sendAckTimeoutMs || 12000);
      while (Date.now() < deadline) {
        if (this.cancelled) throw new Error(t('errTaskStopped'));
        const cleared = await readComposer(locator)
          .then((snapshot) => !snapshot.text.trim())
          .catch(() => false);
        const generating = await this.generationActive();
        let reply = false;
        for (const text of await this.responseCandidates(id, prompt)) {
          if (baseline.has(text)) continue;
          try {
            parseReply(text, id);
            reply = true;
            break;
          } catch {
            /* Not a complete response yet. */
          }
        }
        if (cleared || generating || reply) {
          this.lastSend.stage = 'confirmed';
          return;
        }
        await this.page.waitForTimeout(200);
      }
      this.lastSend.stage = 'unconfirmed';
      throw new Error(clickError ? t('errSendClickScreenChanged') : t('errSendClickUnconfirmed'));
    } finally {
      await button?.dispose().catch(() => {});
    }
  }
  async verifyInput(locator, prompt) {
    let snapshot;
    const deadline = Date.now() + (this.options.inputSettleTimeoutMs || 1500);
    do {
      snapshot = await readComposer(locator);
      this.lastSend = {
        stage: 'input-check',
        characters: prompt.length,
        observedCharacters: snapshot.text.length,
        maxLength: snapshot.maxLength,
        tag: snapshot.tag,
      };
      if (matchesPrompt(snapshot, prompt)) {
        this.ownedDraft = snapshot;
        return;
      }
      if (this.cancelled) throw new Error(t('errTaskStopped'));
      await this.page.waitForTimeout(100);
    } while (Date.now() < deadline);
    const actual = normalizeDraft(snapshot.text),
      expected = normalizeDraft(prompt);
    if (actual.length >= 32 && actual.length < expected.length && expected.startsWith(actual)) {
      this.ownedDraft = snapshot;
      this.promptCharacterLimit = snapshot.maxLength ?? actual.length;
      this.lastSend.stage = 'input-truncated';
      throw promptLimitError(this.promptCharacterLimit, prompt.length);
    }
    this.lastSend.stage = 'input-mismatch';
    const error = new Error(
      t('errComposerChangedInput', {
        requested: prompt.length.toLocaleString(),
        observed: snapshot.text.length.toLocaleString(),
      }),
    );
    if (!actual) {
      error.code = 'COMPOSER_REINITIALIZED';
      error.notSubmitted = true;
    }
    throw error;
  }
  async writePrompt(locator, prompt) {
    const initial = await readComposer(locator);
    if (initial.maxLength !== null && prompt.length > initial.maxLength) {
      this.promptCharacterLimit = initial.maxLength;
      this.lastSend = {
        stage: 'input-limit',
        characters: prompt.length,
        observedCharacters: 0,
        maxLength: initial.maxLength,
        tag: initial.tag,
      };
      throw promptLimitError(initial.maxLength, prompt.length);
    }
    await locator.fill(prompt);
    const snapshot = await readComposer(locator);
    if (matchesPrompt(snapshot, prompt)) this.ownedDraft = snapshot;
    await this.verifyInput(locator, prompt);
  }
  async responseCandidates(id, prompt) {
    const texts = new Set(),
      sources = new Set();
    let truncated = false;
    const selector = this.options.responseSelector || defaultResponses;
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      const scan = await frame.evaluate(scanResponses, { selector, id, prompt });
      truncated ||= scan.truncated;
      for (const block of scan.blocks) {
        texts.add(block.text);
        sources.add(block.source);
      }
    }
    this.responseScan = { candidates: texts.size, sources: [...sources], scanTruncated: truncated };
    return [...texts];
  }
  async generationActive() {
    const pattern = getWebUiPattern('stop', '(\\s*\\(.*\\))?');
    for (const frame of this.page.frames()) {
      if (!frame.isDetached() && (await anyReadyControl(frame.getByRole('button', { name: pattern }))))
        return true;
    }
    return false;
  }
  async newChat() {
    await this.connect();
    await this.protectConversationDraft();
    const name = getWebUiPattern('newChat');
    const fallbackSelector =
      '[data-testid="new-chat-button"], [data-testid="newChatButton"], [data-testid="create-new-chat-button"], [data-testid="chat-new-button"], [data-testid="fab-new-chat"], button[data-automation-id="newChatButton"], a[data-automation-id="newChatButton"], button[title*="Novo chat" i], button[title*="Nova conversa" i], button[title*="New chat" i], button[title*="New conversation" i], button[title*="새 채팅" i], button[title*="새 대화" i], a[title*="Novo chat" i], a[title*="New chat" i]';
    let sawDisabledButton = false;
    for (const frame of this.page.frames()) {
      const candidates = [];
      for (const role of ['button', 'link', 'menuitem']) {
        candidates.push(...(await frame.getByRole(role, { name }).all()));
      }
      candidates.push(...(await frame.locator(fallbackSelector).all()));
      for (const button of candidates) {
        const [state] = await button
          .evaluate(inspectControls)
          .catch(() => [{ visible: false, enabled: false }]);
        if (!state?.visible) continue;
        if (state.enabled) {
          await button.click();
          return;
        }
        sawDisabledButton = true;
      }
    }
    if (sawDisabledButton) {
      const current = await this.readConversation().catch(() => ({ messages: [] }));
      if (!current.messages?.length) return;
    }
    throw new Error(t('errNewChatButtonNotFound'));
  }
  async protectConversationDraft() {
    if (await this.generationActive()) throw new Error(t('errWebGeneratingSwitch'));
    let composer;
    try {
      composer = await this.getComposer();
    } catch {
      return;
    }
    if ((await readComposer(composer.locator)).text.trim()) throw new Error(t('errWebDraftExistsSwitch'));
    await prepareAttachments(this, composer.locator, composer.frame, '', []);
  }
  async resumeConversation(value) {
    const target = conversationUrl(validateCopilotUrl(value));
    if (!target.restorable) throw new Error(t('errNotRestorableWebUrl'));
    await this.connect();
    if (this.conversationInfo().url === target.url) return;
    await this.protectConversationDraft();
    await this.page.goto(target.url, { waitUntil: 'domcontentloaded' });
    await this.waitForComposer();
    if (this.conversationInfo().url !== target.url) throw new Error(t('errWebConversationNotRestored'));
  }
  async request(
    prompt,
    id,
    onStatus = () => {},
    protocol = { parseReply, mergeReplies, replyIdentity },
    requestOptions = {},
  ) {
    const { parseReply, mergeReplies, replyIdentity } = protocol;
    if (this.busy) throw new Error(t('errAlreadyWaitingCopilot'));
    this.busy = true;
    this.cancelled = false;
    this.lastSend = null;
    this.lastResponse = { stage: 'not-submitted' };
    this.ownedDraft = null;
    let submitted = false;
    try {
      await this.connect();
      let baseline;
      for (let attempt = 0; attempt < 3; attempt++) {
        this.automationActive = false;
        const { locator, frame } = await this.waitForComposer(onStatus);
        this.automationActive = true;
        validateCopilotUrl(this.page.url());
        const draft = (await readComposer(locator)).text;
        if (await this.generationActive()) throw new Error(t('errCopilotGeneratingAnother'));
        if (draft.trim()) {
          if (!isAgentProtocolDraft(draft) || (await readComposer(locator)).text !== draft)
            throw new Error(t('errComposerHasDraft'));
          await locator.fill('');
          onStatus(t('statusClearedLegacyDraft'));
        }
        if (this.cancelled) throw new Error(t('errTaskStopped'));
        baseline = new Set(await this.responseCandidates(id, prompt));
        onStatus(t('statusSendingRequestToCopilot'));
        try {
          await this.writePrompt(locator, prompt);
          await prepareAttachments(this, locator, frame, id, requestOptions.attachments, onStatus);
          if (this.cancelled) throw new Error(t('errTaskStopped'));
          await this.submitPrompt(locator, frame, prompt, baseline, id);
          submitted = true;
          this.pendingAttachments = null;
          break;
        } catch (error) {
          if (
            attempt === 2 ||
            error.code !== 'COMPOSER_REINITIALIZED' ||
            error.notSubmitted !== true ||
            ['clicked', 'unconfirmed'].includes(this.lastSend?.stage)
          )
            throw error;
          onStatus(t('statusComposerReinitializingAfterLogin'));
        }
      }
      this.lastResponse = { stage: 'waiting' };
      onStatus(t('statusSendConfirmedWaitingReply'));
      const deadline = Date.now() + (this.options.timeoutSeconds || 240) * 1000;
      let candidateText = '',
        stableSince = 0,
        lastStage = '',
        conflictSignature = '',
        conflictSince = 0;
      while (Date.now() < deadline) {
        if (this.cancelled) throw new Error(t('errTaskStopped'));
        if (this.page.isClosed()) throw new Error(t('errCopilotBrowserWindowClosed'));
        validateCopilotUrl(this.page.url());
        const blocks = await this.responseCandidates(id, prompt);
        let found,
          matching = 0,
          parseError;
        const parsed = [],
          conflicts = [];
        for (const text of blocks) {
          if (baseline.has(text) || !text.includes(id)) continue;
          matching++;
          try {
            parsed.push(parseReply(text, id));
          } catch (error) {
            parseError = error.code || 'REPLY_NOT_FOUND';
            if (error.code === 'AMBIGUOUS_REPLY') conflicts.push(error);
          }
        }
        if (!conflicts.length) {
          try {
            found = mergeReplies(parsed, id);
          } catch (error) {
            conflicts.push(error);
          }
        }
        const generating = await this.generationActive();
        if (conflicts.length) {
          const signature = createHash('sha256')
            .update(
              [
                ...new Set([
                  ...conflicts.map((error) => error.signature || error.code),
                  ...parsed.map(replyIdentity),
                ]),
              ]
                .sort()
                .join('\0'),
            )
            .digest('hex');
          if (signature !== conflictSignature) {
            conflictSignature = signature;
            conflictSince = Date.now();
          }
          candidateText = '';
          stableSince = 0;
          this.lastResponse = {
            stage: 'json-conflict',
            ...this.responseScan,
            matchingRequestId: matching,
            parsed: false,
            generating,
            parseError: conflicts[0].code,
          };
          if (!generating && Date.now() - conflictSince >= (this.options.responseStableMs ?? 2500))
            throw conflicts[0];
          if (lastStage !== 'json-conflict') onStatus(t('statusCheckingMultipleJson'));
          lastStage = 'json-conflict';
          await this.page.waitForTimeout(500);
          continue;
        }
        conflictSignature = '';
        conflictSince = 0;
        const stage = found ? 'json-confirmed' : matching ? 'json-incomplete' : 'waiting';
        this.lastResponse = {
          stage,
          ...this.responseScan,
          matchingRequestId: matching,
          parsed: Boolean(found),
          generating,
          parseError: found ? null : parseError || null,
        };
        if (found) {
          const signature = replyIdentity(found);
          if (signature !== candidateText) {
            candidateText = signature;
            stableSince = Date.now();
          }
          if (Date.now() - stableSince >= (this.options.responseStableMs ?? 2500) && !generating) {
            this.lastResponse.stage = 'complete';
            this.options.onConversation?.(this.conversationInfo());
            return found;
          }
        } else {
          candidateText = '';
          stableSince = 0;
        }
        if (stage !== lastStage) {
          onStatus(
            found
              ? t('statusJsonConfirmedWaitingDone')
              : matching
                ? t('statusRequestIdFoundCollectingJson')
                : t('statusLookingForReplyArea'),
          );
          lastStage = stage;
        }
        await this.page.waitForTimeout(500);
      }
      const result = this.lastResponse;
      throw new Error(
        t('errResponseTimeout', {
          candidates: result.candidates || 0,
          matching: result.matchingRequestId || 0,
          parsed: result.parsed ? t('diagExecFound') : t('diagExecNotFound'),
          generating: result.generating ? t('diagGeneratingDetected') : t('diagGeneratingEnded'),
        }),
      );
    } finally {
      if (
        !submitted &&
        !['clicked', 'unconfirmed'].includes(this.lastSend?.stage) &&
        this.ownedDraft &&
        this.page &&
        !this.page.isClosed()
      ) {
        try {
          const { locator } = await this.getComposer();
          const draft = await readComposer(locator);
          if (draft.text === this.ownedDraft.text && draft.visibleText === this.ownedDraft.visibleText)
            await locator.fill('');
        } catch {
          /* Never clear a draft that is not exactly the one we inserted. */
        }
      }
      this.busy = false;
      this.automationActive = false;
    }
  }
  async stop() {
    this.cancelled = true;
    if (!this.page || this.page.isClosed()) return;
    try {
      const pattern = getWebUiPattern('stop', '(\\s*\\(.*\\))?');
      for (const frame of this.page.frames()) {
        const buttons = frame.getByRole('button', {
          name: pattern,
        });
        for (const button of await buttons.all())
          if (await button.isVisible()) {
            await button.click({ timeout: 2000 });
            return;
          }
      }
    } catch {
      /* Local cancellation still prevents applying subsequent results. */
    }
  }
  async setLocale(locale) {
    const activeLocale = locale || getLanguagePack().browserLocale;
    const changed = this.options.locale !== activeLocale;
    this.options.locale = activeLocale;
    await syncProfileLocale(this.options.profile, activeLocale);
    if (this.context) {
      try {
        await this.context.setExtraHTTPHeaders({
          'Accept-Language': buildAcceptLanguageHeader(activeLocale),
        });
        const primary = activeLocale.split('-')[0];
        const langs =
          primary && primary.toLowerCase() !== activeLocale.toLowerCase()
            ? [activeLocale, primary]
            : [activeLocale];
        await this.context.addInitScript((languages) => {
          try {
            Object.defineProperty(navigator, 'language', {
              get: () => languages[0],
              configurable: true,
            });
            Object.defineProperty(navigator, 'languages', {
              get: () => languages,
              configurable: true,
            });
          } catch {
            /* Ignore if restricted by page frame. */
          }
        }, langs);
        if (changed && !this.busy && this.page && !this.page.isClosed()) {
          const generating = await this.generationActive().catch(() => false);
          let hasDraft = false;
          try {
            const composer = await this.getComposer();
            hasDraft = Boolean((await readComposer(composer.locator)).text.trim());
          } catch {
            hasDraft = false;
          }
          if (!generating && !hasDraft) {
            await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          }
        }
      } catch {
        /* Context may already be closing. */
      }
    }
  }
  conversationInfo() {
    validateCopilotUrl(this.page.url());
    return conversationUrl(this.page.url());
  }
  async models(onStatus) {
    await this.connect();
    await this.waitForComposer(onStatus);
    this.automationActive = true;
    try {
      return await require('./web-controls').listModels(this, onStatus);
    } finally {
      this.automationActive = false;
    }
  }
  async selectModel(id, onStatus) {
    await this.connect();
    await this.waitForComposer(onStatus);
    this.automationActive = true;
    try {
      return await require('./web-controls').selectModel(this, id, onStatus);
    } finally {
      this.automationActive = false;
    }
  }
  async readConversation() {
    validateCopilotUrl(this.page.url());
    return require('./web-controls').readConversation(this);
  }
  async close() {
    this.cancelled = true;
    if (this.context) await this.context.close();
  }
}
module.exports = { CopilotBrowser, validateCopilotUrl };
