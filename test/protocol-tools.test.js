'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildPrompt, parseReply } = require('../src/protocol');
const { CodingAgent } = require('../src/agent');
const { WorkspaceStore } = require('../src/workspace');
const { ChangeController } = require('../src/changes');

test('advertised command requests reach host approval and return actual host outcomes', async (t) => {
  for (const accepted of [true, false]) {
    await t.test(accepted ? 'approved execution' : 'rejected execution', async (t) => {
      const temp = await fs.realpath(os.tmpdir());
      const root = await fs.mkdtemp(path.join(temp, 'm365-command-protocol-'));
      t.after(async () => {
        assert.equal(path.dirname(root), temp);
        await fs.rm(root, { recursive: true, force: true });
      });
      const store = await new WorkspaceStore(root).initialize();
      const commands = [];
      let notifyApproval;
      const approval = new Promise((resolve) => {
        notifyApproval = resolve;
      });
      const host = {
        changedFiles: new Map(),
        previews: new Map(),
        stopRequested: false,
        post(event) {
          if (event.type === 'commandApproval') notifyApproval(event);
        },
        output: { appendLine() {}, append() {}, show() {} },
        config: () => ({ get: (_name, fallback) => fallback }),
        runner: {
          async run(command, cwd) {
            commands.push({ command, cwd });
            return { command, exitCode: 0, output: 'host tests passed' };
          },
        },
      };
      const controller = new ChangeController(host, {});
      let rounds = 0;
      const agent = new CodingAgent({
        store,
        emit() {},
        runCommand: (command) => controller.runCommand(command, root),
        transport: {
          async request(prompt, requestId) {
            const instructions = prompt.split('DATA: ')[0];
            assert.match(instructions, /Tools: [^;]*run_command\(command\)/);
            assert.match(instructions, /VS Code host JSON actions, not Copilot built-ins/);
            if (++rounds === 1) {
              const example = JSON.parse(instructions.match(/Command request: (\{.*?\})\. /)[1]);
              example.requestId = requestId;
              return parseReply(JSON.stringify(example), requestId);
            }
            const data = JSON.parse(prompt.split('DATA: ')[1]);
            const observation = data.history.findLast((entry) => entry.kind === 'tool_results')
              .observations[0];
            assert.equal(observation.call.name, 'run_command');
            assert.equal(observation.call.command, 'npm test');
            if (accepted) {
              assert.equal(observation.result.exitCode, 0);
              assert.equal(observation.result.output, 'host tests passed');
            } else {
              assert.equal(observation.result.approved, false);
              assert.equal(observation.result.exitCode, undefined);
            }
            return { kind: 'done', message: accepted ? '테스트 통과 확인' : '실행 거절 확인' };
          },
        },
      });
      const running = agent.run('npm test를 실행해줘.');
      try {
        const pending = await Promise.race([
          approval,
          running.then(() => {
            throw new Error('Command completed without requesting approval');
          }),
        ]);
        assert.equal(pending.command, 'npm test');
        assert.deepEqual(commands, [], 'the command must not run before approval');
        host.pending.resolve(accepted);
        assert.equal((await running).status, 'done');
        assert.deepEqual(commands, accepted ? [{ command: 'npm test', cwd: root }] : []);
        assert.equal(rounds, 2);
      } finally {
        host.pending?.resolve(false);
        await running.catch(() => {});
      }
    });
  }
});

test('read-only prompts never advertise command execution even with automatic approval', () => {
  for (const mode of ['ask', 'plan']) {
    for (const autoApprove of [false, true]) {
      const prompt = buildPrompt({
        id: 'read-only',
        task: 'Explain the project.',
        workspace: 'demo',
        mode,
        autoApprove,
      });
      const instructions = prompt.split('DATA: ')[0];
      assert.doesNotMatch(instructions, /run_command|Command request:/);
      assert.match(instructions, /NEVER edit or run commands/);
      assert.match(instructions, /Tools: [^;]*read_file/);
    }
  }
});
