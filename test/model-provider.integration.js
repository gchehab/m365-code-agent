'use strict';
const assert = require('node:assert/strict');

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
      return {
        async connect() {}, async waitForComposer() {}, async newChat() { trace.push('newChat'); },
        async stop() {}, async close() { trace.push('close'); },
        async request(prompt, id, _status, protocol) {
          const data = JSON.parse(prompt.split('DATA: ')[1]);
          if (data.tools.length > 40) {
            assert.equal(data.tools.length, 48);
            assert.equal(data.messages[0].role, 'system');
          }
          const result = data.messages.flatMap(message => message.content).find(part => part.type === 'tool_result');
          if (result) {
            assert.equal(result.id, 'native-call');
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
    assert.ok(parts[0] instanceof vscode.LanguageModelToolCallPart);
    assert.equal(parts[0].callId, 'native-call');
    messages.push(vscode.LanguageModelChatMessage.Assistant([parts[0]]));
    messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart('native-call', [new vscode.LanguageModelTextPart('actual host result')])]));
    await provider.provideLanguageModelChatResponse(model, messages, { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: part => parts.push(part) }, token.token);
    assert.ok(parts[1] instanceof vscode.LanguageModelTextPart);
    assert.equal(parts[1].value, '완료');
    assert.deepEqual(trace, ['newChat', 'newChat'], 'successful turns keep the browser warm');
    // Agent-shaped input: preserve System instructions and more than 40 full schemas in one request.
    const agentTools = Array.from({ length: 48 }, (_, index) => ({ ...tool, name: `agent_lookup_${index}`, description: 'Native Agent tool definition. '.repeat(8) }));
    agentTools[0] = tool;
    const agentMessages = [{ role: 3, content: [new vscode.LanguageModelTextPart('Host system instructions. '.repeat(80))] }, ...messages];
    const agentParts = [];
    await provider.provideLanguageModelChatResponse(model, agentMessages, { tools: agentTools, toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: part => agentParts.push(part) }, token.token);
    assert.equal(agentParts.at(-1).value, '완료');
    console.log('Experimental model provider: native registration, discovery and tool call/result round-trip passed.');
  } finally {
    await provider.retireBrowser();
    provider.createBrowser = originalFactory;
    token.dispose();
    await config.update(setting, previous, vscode.ConfigurationTarget.Global);
    provider.refresh();
  }
};
