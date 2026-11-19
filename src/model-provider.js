'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { CopilotBrowser } = require('./browser');
const protocol = require('./model-protocol');

class ExperimentalModelProvider {
  constructor(context, vscode, createBrowser = (options) => new CopilotBrowser(options)) {
    this.context = context;
    this.vscode = vscode;
    this.createBrowser = createBrowser;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this.changed.event;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.generation = 0;
    this.disposed = false;
    this.browser = null;
    this.closing = Promise.resolve();
    this.interruptActive = null;
    this.output = vscode.window?.createOutputChannel?.('M365 Web Model');
    this.config = () => vscode.workspace.getConfiguration('m365Agent');
  }

  assertAvailable(token, generation = this.generation) {
    if (this.disposed || token.isCancellationRequested) throw new this.vscode.CancellationError();
    if (!this.config().get('experimental.modelProvider.enabled', false))
      throw new Error('실험용 모델 제공자가 꺼져 있습니다.');
    if (generation !== this.generation) throw new this.vscode.CancellationError();
    if (!this.vscode.workspace.isTrusted)
      throw new Error('신뢰할 수 있는 작업 영역에서만 모델을 사용할 수 있습니다.');
  }

  async provideLanguageModelChatInformation(_options, token) {
    if (
      this.disposed ||
      token.isCancellationRequested ||
      !this.vscode.workspace.isTrusted ||
      !this.config().get('experimental.modelProvider.enabled', false)
    )
      return [];
    // This is a bridge to the actual current web model, not a claim about its identity/context window.
    return [
      {
        id: 'web-current-experimental',
        name: 'M365 Web (Experimental)',
        family: 'm365-web',
        version: '1',
        // Match provideTokenCount's byte/3 units, leaving room for the bridge envelope.
        maxInputTokens: Math.max(1, Math.floor((this.promptLimit() - 2000) / 3)),
        maxOutputTokens: 4096,
        tooltip: '전용 브라우저의 현재 웹 모델 · 응답 완료 후 전달 · 입력 글자 한도 별도 적용',
        detail: '웹 자동화 · 실험용 · VS Code 도구 정책 적용',
        capabilities: { imageInput: false, toolCalling: true },
      },
    ];
  }

  async provideTokenCount(_model, value, token) {
    this.assertAvailable(token);
    return protocol.estimateTokens(
      typeof value === 'string' ? value : JSON.stringify(protocol.convertMessages([value], this.vscode)),
    );
  }

  promptLimit() {
    return this.config().get('experimental.modelProvider.maxPromptCharacters', 60000);
  }

  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const started = Date.now();
    this.trace({ event: 'request', messages: messages.length, tools: options.tools?.length || 0 });
    try {
      await this.respond(model, messages, options, progress, token);
      this.trace({ event: 'complete', elapsedMs: Date.now() - started });
    } catch (error) {
      this.trace({ event: 'failed', code: error.code || error.name, elapsedMs: Date.now() - started });
      throw error;
    }
  }

  trace(event) {
    try {
      if (!this.disposed) this.output?.appendLine(JSON.stringify(event));
    } catch {
      // A disposed output channel must never change a model request's outcome.
    }
  }

  async respond(model, messages, options, progress, token) {
    const generation = this.generation;
    const check = () => this.assertAvailable(token, generation);
    check();
    if (model.id !== 'web-current-experimental') throw new Error('알 수 없는 실험용 모델입니다.');
    const converted = protocol.convertMessages(messages, this.vscode);
    const tools = (options.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const required = options.toolMode === this.vscode.LanguageModelChatToolMode.Required;
    const id = randomUUID();
    this.trace({
      event: 'converted',
      roles: converted.map((message) => message.role),
      messageCharacters: JSON.stringify(converted).length,
      toolCharacters: JSON.stringify(tools).length,
      limit: this.promptLimit(),
    });
    let prepared = protocol.prepareModelPrompt(id, converted, { tools, required }, this.promptLimit());
    await this.enqueue(async () => {
      check();
      const browser = await this.ensureBrowser();
      browser.cancelled = false;
      let stopping = Promise.resolve();
      let succeeded = false;
      const interrupt = () => {
        stopping = stopping.then(() => browser.stop()).catch(() => {});
      };
      this.interruptActive = interrupt;
      const cancellation = token.onCancellationRequested(interrupt);
      try {
        check();
        this.trace({ event: 'browser-connect' });
        await browser.connect();
        check();
        await browser.waitForComposer();
        check();
        // A fresh web chat for EVERY turn prevents other VS Code chats/old tools leaking into this one.
        // This turn's prepared history is explicitly supplied again. Failure aborts before submission.
        await browser.newChat();
        this.trace({ event: 'new-chat' });
        check();
        prepared = protocol.prepareModelPrompt(
          id,
          converted,
          { tools, required },
          Math.min(this.promptLimit(), browser.promptCharacterLimit ?? Infinity),
        );
        let reply;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            reply = await browser.request(prepared.prompt, id, () => {}, protocol);
            this.trace({
              event: 'response',
              textCharacters: reply.text.length,
              toolCalls: reply.toolCalls.length,
            });
            break;
          } catch (error) {
            if (
              attempt ||
              error.code !== 'PROMPT_LIMIT' ||
              error.notSubmitted !== true ||
              !Number.isFinite(error.maxCharacters) ||
              error.maxCharacters <= 0 ||
              error.maxCharacters >= prepared.prompt.length ||
              ['clicked', 'unconfirmed'].includes(browser.lastSend?.stage)
            )
              throw error;
            check();
            // Rebuild only after a confirmed pre-submit rejection. Never retry an uncertain submission.
            prepared = protocol.prepareModelPrompt(id, converted, { tools, required }, error.maxCharacters);
          }
        }
        check();
        protocol.validateCalls(reply, tools, required, converted);
        // DOM responses become available only once the complete JSON is validated.
        if (prepared.omittedMessages || prepared.referencedTextParts)
          progress.report(
            new this.vscode.LanguageModelTextPart(
              `> 문맥 축소: 오래된 메시지 ${prepared.omittedMessages}개 생략, 반복 사용자 텍스트 ${prepared.referencedTextParts || 0}개 참조 처리. System 지시·사용자 요청·최근 도구 교환·도구 정의는 유지했습니다.\n\n`,
            ),
          );
        check();
        if (reply.text) progress.report(new this.vscode.LanguageModelTextPart(reply.text));
        for (const call of reply.toolCalls) {
          check();
          progress.report(new this.vscode.LanguageModelToolCallPart(call.id, call.name, call.input));
        }
        succeeded = true;
      } finally {
        cancellation.dispose();
        this.interruptActive = null;
        await stopping;
        // Keep successful sessions warm. Retire failures/cancellation so late generation cannot reach the next turn.
        if (!succeeded || token.isCancellationRequested || this.disposed || generation !== this.generation)
          await this.retireBrowser(browser);
      }
    }, token);
  }

  enqueue(work, token) {
    if (this.pending >= 8)
      return Promise.reject(
        new Error('실험용 모델 요청이 8개 대기 중입니다. 진행 중인 요청을 마친 뒤 다시 시도하세요.'),
      );
    this.pending++;
    return new Promise((resolve, reject) => {
      const cancellation = token.onCancellationRequested(() => reject(new this.vscode.CancellationError()));
      const run = this.tail.then(async () => {
        this.assertAvailable(token);
        return work();
      });
      this.tail = run.then(
        () => {},
        () => {},
      );
      run.then(resolve, reject).finally(() => {
        this.pending--;
        cancellation.dispose();
      });
    });
  }

  async ensureBrowser() {
    await this.closing.catch(() => {});
    if (this.browser) return this.browser;
    const config = this.config();
    const profile = path.join(this.context.globalStorageUri.fsPath, 'model-provider-profile');
    await fs.mkdir(profile, { recursive: true });
    this.browser = this.createBrowser({
      profile,
      url: config.get('copilotUrl'),
      channel: config.get('browserChannel', 'msedge'),
      embedded: false,
      composerSelector: config.get('composerSelector'),
      sendButtonSelector: config.get('sendButtonSelector'),
      responseSelector: config.get('responseSelector'),
      timeoutSeconds: config.get('responseTimeoutSeconds', 240),
      loginTimeoutSeconds: config.get('loginTimeoutSeconds', 600),
      modelButtonSelector: config.get('modelButtonSelector'),
    });
    return this.browser;
  }

  retireBrowser(browser = this.browser) {
    if (!browser || browser !== this.browser) return this.closing;
    this.browser = null;
    this.closing = this.closing.catch(() => {}).then(() => browser.close());
    return this.closing;
  }

  refresh() {
    this.changed.fire();
    // A configuration change invalidates captured requests and retires the old browser settings.
    this.generation++;
    if (this.interruptActive) this.interruptActive();
    else this.retireBrowser().catch(() => {});
  }

  dispose() {
    this.disposed = true;
    this.changed.dispose();
    this.output?.dispose();
    return this.retireBrowser().catch(() => {});
  }
}

function registerModelProvider(context, vscode) {
  if (!vscode.lm?.registerLanguageModelChatProvider) return;
  const provider = new ExperimentalModelProvider(context, vscode);
  context.subscriptions.push(
    provider,
    vscode.lm.registerLanguageModelChatProvider('m365-code-agent', provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        [
          'experimental.modelProvider',
          'copilotUrl',
          'browserChannel',
          'composerSelector',
          'sendButtonSelector',
          'responseSelector',
          'responseTimeoutSeconds',
          'loginTimeoutSeconds',
          'modelButtonSelector',
        ].some((key) => event.affectsConfiguration('m365Agent.' + key))
      )
        provider.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => provider.refresh()),
  );
  return provider;
}

module.exports = { ExperimentalModelProvider, registerModelProvider };
