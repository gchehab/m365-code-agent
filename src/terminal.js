'use strict';
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');

function outputDecoder(encoding = 'utf8') {
  const decoder = new TextDecoder(encoding === 'cp949' ? 'euc-kr' : 'utf-8');
  return { write: chunk => decoder.decode(chunk, { stream: true }), end: () => decoder.decode() };
}

// The caller must obtain approval for the exact command before invoking this runner.
class CommandRunner {
  async run(command, cwd, onOutput = () => {}, timeoutMs = 120000) {
    if (this.child) throw new Error('이미 명령이 실행 중입니다.');
    if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\0\r\n]/.test(command)) throw new Error('명령은 1~2,000자의 한 줄로 입력해야 합니다.');
    return new Promise((resolve, reject) => {
      let output = '', truncated = false, timedOut = false, cancelled = false, finished = false;
      const encoding = this.encoding || 'utf8';
      const shellCommand = process.platform === 'win32' ? `chcp ${encoding === 'cp949' ? '949' : '65001'}>nul && ${command}` : command;
      const child = spawn(shellCommand, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      const stdout = outputDecoder(encoding), stderr = outputDecoder(encoding);
      const append = text => {
        if (!text) return;
        onOutput(text);
        output += text;
        if (output.length > 12000) { output = output.slice(-12000); truncated = true; }
      };
      child.stdout.on('data', data => append(stdout.write(data)));
      child.stderr.on('data', data => append(stderr.write(data)));
      const finish = (error, code) => {
        if (finished) return;
        finished = true;
        append(stdout.end()); append(stderr.end());
        clearTimeout(timer);
        this.child = null;
        this.cancel = null;
        if (error) reject(error);
        else resolve({ command, exitCode: code, timedOut, cancelled, truncated, output, encoding });
      };
      this.cancel = () => {
        cancelled = true;
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGTERM');
      };
      const timer = setTimeout(() => { timedOut = true; this.cancel?.(); }, timeoutMs);
      child.on('error', error => finish(error));
      child.on('close', code => finish(null, code));
    });
  }
  stop() { this.cancel?.(); }
}
module.exports = { CommandRunner, outputDecoder };
