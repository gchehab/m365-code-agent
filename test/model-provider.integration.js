'use strict';
const assert = require('node:assert/strict');
const { cleanText } = require('../src/model-conversations');

module.exports = async function checkNativeModelProvider(vscode, provider) {
  assert.ok(provider, 'stable model provider API registers in the real VS Code host');
  const config = vscode.workspace.getConfiguration('m365Agent');
  const setting = 'experimental.modelProvider.enabled';
  const previous = config.inspect(setting).globalValue;
  const originalFactory = provider.createBrowser;
  const token = new vscode.CancellationTokenSource();
  const trace = [];
  try {
    assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, token.token), []);
    await config.update(setting, true, vscode.ConfigurationTarget.Global);
    provider.refresh();
    const registered = await vscode.lm.selectChatModels({ vendor: 'm365-code-agent' });
    assert.ok(registered.some(model => model.id === 'web-current-experimental'), 'native registry discovers the opt-in model');
    const [model] = await provider.provideLanguageModelChatInformation({ silent: true }, token.token);
    provider.createBrowser = options => {
      assert.match(options.profile, /model-provider-profile$/);
      assert.equal(options.embedded, false);
      let url = 'https://m365.cloud.microsoft/chat';
      return {
        async connect() {}, async waitForComposer() {}, async newChat() { trace.push('newChat'); url = 'https://m365.cloud.microsoft/chat?threadId=native'; },
        conversationInfo() { return { url, restorable: url.includes('threadId=') }; },
        async resumeConversation(value) { assert.equal(value, url); },
        async stop() {}, async close() { trace.push('close'); },
        async request(prompt, id, _status, protocol) {
          const data = JSON.parse(prompt.split('DATA: ')[1]);
          if (data.tools.length > 40) {
            assert.equal(data.tools.length, 48);
            assert.equal(data.messages[0].role, 'system');
          }
          const result = data.messages.flatMap(message => message.content).find(part => part.type === 'tool_result');
          if (result) {
            assert.match(result.id, /^m365_[a-f0-9]{32}$/);
            assert.equal(result.content[0].text, 'actual host result');
          }
          return protocol.parseReply(JSON.stringify({ requestId: id, kind: 'model', text: result ? '완료' : '', toolCalls: result ? [] : [{ id: 'native-call', name: 'test_native_lookup', input: { query: 'hello' } }] }), id);
        },
      };
    };
    const parts = [];
    const tool = { name: 'test_native_lookup', description: 'Private host lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
    const messages = [vscode.LanguageModelChatMessage.User('조회해줘')];
    await provider.provideLanguageModelChatResponse(model, messages, { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required }, { report: part => parts.push(part) }, token.token);
    assert.ok(parts[1] instanceof vscode.LanguageModelToolCallPart);
    assert.match(parts[1].callId, /^m365_[a-f0-9]{32}$/);
    messages.push(vscode.LanguageModelChatMessage.Assistant([...parts]));
    messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(parts[1].callId, [new vscode.LanguageModelTextPart('actual host result')])]));
    await provider.provideLanguageModelChatResponse(model, messages, { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: part => parts.push(part) }, token.token);
    assert.ok(parts[2] instanceof vscode.LanguageModelTextPart);
    assert.equal(cleanText(parts[2].value), '완료');
    assert.deepEqual(trace, ['newChat'], 'tool round trips reuse the same web conversation');
    messages.push(vscode.LanguageModelChatMessage.Assistant([parts[2]]));
    messages.push(vscode.LanguageModelChatMessage.User('다시 확인해줘'));
    // Agent-shaped input: preserve System instructions and more than 40 full schemas in one request.
    const agentTools = Array.from({ length: 48 }, (_, index) => ({ ...tool, name: `agent_lookup_${index}`, description: 'Native Agent tool definition. '.repeat(8) }));
    agentTools[0] = tool;
    const agentMessages = [{ role: 3, content: [new vscode.LanguageModelTextPart('Host system instructions. '.repeat(80))] }, ...messages];
    const agentParts = [];
    await provider.provideLanguageModelChatResponse(model, agentMessages, { tools: agentTools, toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: part => agentParts.push(part) }, token.token);
    assert.equal(cleanText(agentParts.at(-1).value), '완료');
    assert.deepEqual(trace, ['newChat']);
    console.log('Experimental model provider: native registration, discovery and tool call/result round-trip passed.');
  } finally {
    await provider.retireBrowser();
    provider.createBrowser = originalFactory;
    token.dispose();
    await config.update(setting, previous, vscode.ConfigurationTarget.Global);
    provider.refresh();
  }
};
