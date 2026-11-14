'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ignore = require('ignore');

const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const blocked = /(^|\/)(\.git|node_modules|\.venv|venv|\.ssh|\.aws|\.azure|\.kube|\.m365-agent)(\/|$)|(^|\/)\.env[^/]*$|\.(pem|key|pfx|p12|jks|keystore)$|(^|\/)(\.npmrc|\.pypirc|\.netrc|\.yarnrc\.ya?ml|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(?:\.(json|ini|toml|ya?ml))?|appsettings(?:\.[^/]*)?\.json)$|\.tfstate(?:\.[^/]*)?$|(^|\/)\.docker\/config\.json$/i;

class WorkspaceStore {
  constructor(root, readText) {
    this.root = path.resolve(root);
    this.readText = readText;
    this.ledger = new Map();
    this.editReads = new Map();
    this.ignores = ignore();
  }
  async initialize() {
    this.root = await fs.realpath(this.root);
    for (const name of ['.gitignore', '.m365agentignore']) {
      try { this.ignores.add(await fs.readFile(path.join(this.root, name), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return this;
  }
  normalize(input) {
    if (typeof input !== 'string' || !input || input.includes('\0') || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) throw new Error('프로젝트 상대 경로만 사용할 수 있습니다.');
    const normalized = input.replace(/\\/g, '/');
    if (normalized.split('/').some(part => !part || part === '.' || part === '..' || /[:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new Error('허용되지 않는 파일 경로입니다.');
    if (blocked.test(normalized) || this.ignores.ignores(normalized)) throw new Error(`제외된 경로입니다: ${normalized}`);
    return normalized;
  }
  async resolve(input, allowMissing = false) {
    const normalized = this.normalize(input);
    const target = path.join(this.root, ...normalized.split('/'));
    let cursor = this.root;
    for (const part of normalized.split('/')) {
      cursor = path.join(cursor, part);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) throw new Error('심볼릭 링크와 정션 경로는 접근하지 않습니다.');
        const real = await fs.realpath(cursor);
        const relative = path.relative(this.root, real);
        if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('프로젝트 밖의 경로입니다.');
      } catch (error) {
        if (allowMissing && error.code === 'ENOENT') break;
        throw error;
      }
    }
    return { normalized, target };
  }
  async listFiles(limit = 250) {
    limit = Math.max(1, Math.min(Number(limit) || 250, 1000));
    const files = [];
    let truncated = false;
    const walk = async (directory, prefix = '') => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= limit) { truncated = true; return; }
        const relative = prefix + entry.name;
        if (entry.isSymbolicLink() || blocked.test(relative)) continue;
        if (this.ignores.ignores(relative + (entry.isDirectory() ? '/' : ''))) continue;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
        else if (entry.isFile()) files.push(relative);
      }
    };
    await walk(this.root);
    return { files, truncated };
  }
  async loadFile(input, diskOnly = false) {
    const { normalized, target } = await this.resolve(input);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('128KB 이하의 텍스트 파일만 읽을 수 있습니다.');
    const content = this.readText && !diskOnly ? await this.readText(target) : new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(target));
    if (content.includes('\0') || Buffer.byteLength(content, 'utf8') > 128 * 1024) throw new Error('바이너리 또는 너무 큰 파일입니다.');
    const hash = digest(content);
    return { path: normalized, hash, content };
  }
  async readFile(input, options) {
    const file = await this.loadFile(input);
    let result = file;
    if (options) {
      const lines = file.content.split('\n');
      const start = options.startLine ?? 1, count = options.lineCount ?? 80;
      const maxCharacters = options.maxCharacters ?? 8000;
      if (!Number.isInteger(start) || start < 1 || start > lines.length || !Number.isInteger(count) || count < 1 || count > 200 || !Number.isInteger(maxCharacters) || maxCharacters < 128 || maxCharacters > 22000) throw new Error('줄 범위가 올바르지 않습니다. startLine>=1, lineCount=1~200.');
      let content = '', end = start - 1;
      for (let index = start - 1; index < Math.min(lines.length, start - 1 + count); index++) {
        const line = lines[index] + (index < lines.length - 1 ? '\n' : '');
        if (content.length + line.length > maxCharacters) break;
        content += line;
        end = index + 1;
      }
      if (end < start) throw new Error('한 줄이 읽기 한도를 넘습니다. search_text로 필요한 부분을 검색하세요.');
      result = { ...file, content, startLine: start, endLine: end, totalLines: lines.length, complete: start === 1 && end === lines.length, nextLine: end < lines.length ? end + 1 : null };
    }
    if (!options || result.complete) this.ledger.set(file.path, file.hash);
    let observed = this.editReads.get(file.path);
    if (!observed || observed.hash !== file.hash) observed = { hash: file.hash, chunks: [] };
    if (!observed.chunks.includes(result.content)) observed.chunks.push(result.content);
    observed.chunks = observed.chunks.slice(-40);
    this.editReads.set(file.path, observed);
    return result;
  }
  async search(query, paths) {
    if (typeof query !== 'string' || !query || query.length > 200) throw new Error('검색어는 1~200자여야 합니다.');
    const files = paths || (await this.listFiles(500)).files;
    if (!Array.isArray(files) || files.length > 500) throw new Error('검색 파일 수는 최대 500개입니다.');
    const matches = [];
    for (const filename of files) {
      let file;
      try { file = await this.loadFile(filename, true); } catch { continue; }
      for (const [index, line] of file.content.split(/\r?\n/).entries()) {
        if (line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: file.path, line: index + 1, text: line.slice(0, 400) });
        if (matches.length >= 40) return { matches, truncated: true };
      }
    }
    return { matches, truncated: false };
  }
  async prepareChanges(files) {
    if (!Array.isArray(files) || !files.length || files.length > 30) throw new Error('변경 파일은 1~30개여야 합니다.');
    const seen = new Set();
    const changes = [];
    let bytes = 0;
    for (const file of files) {
      if (!file || !['create', 'replace', 'edit'].includes(file.action) || (file.action !== 'edit' && typeof file.content !== 'string')) throw new Error('지원하지 않는 변경 형식입니다.');
      const { normalized, target } = await this.resolve(file.path, file.action === 'create');
      const key = normalized.toLowerCase();
      if (seen.has(key)) throw new Error('동일 파일을 중복 변경할 수 없습니다.');
      seen.add(key);
      let original = null;
      let content = file.content;
      if (file.action === 'create') {
        try { await fs.lstat(target); throw new Error(`이미 존재하는 파일입니다: ${normalized}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (file.baseHash !== null) throw new Error('새 파일의 baseHash는 null이어야 합니다.');
      } else if (file.action === 'replace') {
        if (this.ledger.get(normalized) !== file.baseHash) throw new Error(`먼저 파일을 읽고 정확한 hash를 사용해야 합니다: ${normalized}`);
        original = await this.loadFile(normalized);
        if (original.hash !== file.baseHash) throw new Error(`읽은 뒤 변경된 파일입니다. 다시 읽어야 합니다: ${normalized}`);
      } else {
        const observed = this.editReads.get(normalized);
        if (!observed || observed.hash !== file.baseHash) throw new Error(`먼저 수정할 줄을 읽고 정확한 hash를 사용해야 합니다: ${normalized}`);
        original = await this.loadFile(normalized);
        if (original.hash !== file.baseHash) throw new Error(`읽은 뒤 변경된 파일입니다. 다시 읽어야 합니다: ${normalized}`);
        if (!Array.isArray(file.edits) || file.edits.length < 1 || file.edits.length > 20) throw new Error('부분 수정은 1~20개의 oldText/newText 쌍이어야 합니다.');
        const crlf = original.content.includes('\r\n') && !original.content.replace(/\r\n/g, '').includes('\n');
        const eol = text => crlf ? text.replace(/\r?\n/g, '\r\n') : text;
        const spans = file.edits.map(edit => {
          if (!edit || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string' || edit.oldText.includes('\0') || edit.newText.includes('\0')) throw new Error('부분 수정의 텍스트가 올바르지 않습니다.');
          const oldText = eol(edit.oldText), newText = eol(edit.newText);
          if (!observed.chunks.some(chunk => chunk.includes(oldText))) throw new Error('수정할 oldText가 읽은 범위에 없습니다. 해당 줄을 먼저 읽으세요.');
          const start = original.content.indexOf(oldText);
          if (start < 0 || original.content.indexOf(oldText, start + 1) >= 0) throw new Error('oldText는 파일에서 정확히 한 번 나타나야 합니다. 앞뒤 문맥을 더 포함하세요.');
          return { start, end: start + oldText.length, text: newText };
        }).sort((a, b) => a.start - b.start);
        for (let index = 1; index < spans.length; index++) if (spans[index].start < spans[index - 1].end) throw new Error('부분 수정 범위가 겹칩니다.');
        content = original.content;
        for (const span of spans.reverse()) content = content.slice(0, span.start) + span.text + content.slice(span.end);
      }
      bytes += Buffer.byteLength(content, 'utf8');
      if (bytes > 512 * 1024 || Buffer.byteLength(content, 'utf8') > 128 * 1024 || content.includes('\0')) throw new Error('변경 내용이 너무 크거나 텍스트가 아닙니다.');
      changes.push({ ...file, content, path: normalized, target, original: original?.content ?? '', expectedHash: original?.hash ?? null });
    }
    return changes;
  }
  async verifyChanges(changes) {
    for (const change of changes) {
      await this.resolve(change.path, change.action === 'create');
      if (change.action === 'create') {
        try { await fs.lstat(change.target); throw new Error(`새 파일 경로가 이미 생겼습니다: ${change.path}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else if ((await this.loadFile(change.path)).hash !== change.expectedHash) throw new Error(`미리보기 이후 파일이 변경되었습니다: ${change.path}`);
    }
  }
}
module.exports = { WorkspaceStore, digest };
