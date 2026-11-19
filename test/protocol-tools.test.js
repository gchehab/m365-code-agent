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
const { CommandRunner, commandEnvironment } = require('../src/terminal');

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
            assert.deepEqual(data.environment, commandEnvironment(root));
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

test('advertised shell syntax executes in the advertised directory and returns real results', async (t) => {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'm365 shell protocol-'));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = await new WorkspaceStore(root).initialize();
  const runner = new CommandRunner();
  t.after(() => runner.stop());
  let rounds = 0;
  const agent = new CodingAgent({
    store,
    emit() {},
    runCommand: command => runner.run(command, root),
    transport: {
      async request(prompt) {
        const data = JSON.parse(prompt.split('DATA: ')[1]);
        assert.deepEqual(data.environment, commandEnvironment(root));
        assert.match(prompt, /background process, not the VS Code terminal/);
        if (++rounds === 1) {
          const node = '"' + process.execPath + '"';
          const inspect = `${node} -e "console.log(JSON.stringify({cwd:process.cwd(),probe:process.env.M365_AGENT_EXECUTION_PROBE}));process.exit(7)"`;
          return { kind: 'tools', calls: [{ name: 'run_command', command:
            data.environment.platform === 'win32'
              ? `set M365_AGENT_EXECUTION_PROBE=shell-ok&& ${inspect}`
              : `M365_AGENT_EXECUTION_PROBE=shell-ok ${inspect}` }] };
        }
        const observation = data.history.findLast(entry => entry.kind === 'tool_results').observations[0];
        assert.equal(observation.result.exitCode, 7);
        assert.deepEqual(JSON.parse(observation.result.output.trim()), { cwd: root, probe: 'shell-ok' });
        return { kind: 'done', message: '실제 실행 환경 확인' };
      },
    },
  });
  assert.equal((await agent.run('현재 셸과 작업 폴더에서 명령을 검증해줘.')).status, 'done');
  assert.equal(rounds, 2);
});

test('execution environment survives context reduction without advertising a command in read-only modes', () => {
  const environment = commandEnvironment(process.cwd());
  const options = { id: 'shell-budget', task: 'Run the tests.', workspace: 'demo', environment,
    maxCharacters: 4000, history: [{ role: 'assistant', text: 'x'.repeat(10000) }] };
  const prompt = buildPrompt(options);
  assert.ok(prompt.length <= options.maxCharacters);
  assert.deepEqual(JSON.parse(prompt.split('DATA: ')[1]).environment, environment);
  for (const mode of ['ask', 'plan']) {
    const readOnly = buildPrompt({ ...options, mode });
    assert.equal(JSON.parse(readOnly.split('DATA: ')[1]).environment, undefined);
    assert.doesNotMatch(readOnly.split('DATA: ')[0], /run_command|Command request:/);
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
