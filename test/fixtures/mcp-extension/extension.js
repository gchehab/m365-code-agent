'use strict';
const vscode = require('vscode');
function activate(context) {
  const calls = [];
  context.subscriptions.push(vscode.lm.registerTool('m365_agent_mcp_fixture_lookup', {
    invoke(options, token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      calls.push(options.input);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('fixture documentation: ' + options.input.query)]);
    },
  }));
  return { calls };
}
module.exports = { activate };
