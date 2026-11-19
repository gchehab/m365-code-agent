'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { prepareAttachments, attachmentKind } = require('../src/attachments');
const ffmpeg = require('ffmpeg-static');
const execute = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm365-attachment-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, bytes) => { const file = path.join(root, name); await fs.writeFile(file, bytes); return file; };
  return { root, write };
}
test('images, PDF and Office attachments preserve original binary bytes and MIME types', async t => {
  const { write } = await fixture(t);
  const cases = [ ['image.PNG', 'image/png'], ['report.pdf', 'application/pdf'], ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['table.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'] ];
  const bytes = Buffer.from([0, 255, 200, 10, 0, 13]);
  const files = await Promise.all(cases.map(([name]) => write(name, bytes)));
  const prepared = await prepareAttachments(files);
  assert.equal(prepared.uploads.length, 5);
  prepared.uploads.forEach((upload, index) => { assert.equal(upload.name, cases[index][0]); assert.equal(upload.mimeType, cases[index][1]); assert.deepEqual(upload.buffer, bytes); });
  assert.equal(prepared.context[0].kind, 'image');
  assert.equal(prepared.context[1].kind, 'document');
  assert.equal(JSON.stringify(prepared.context).includes(files[0]), false);
  assert.equal(attachmentKind('letter.docm'), 'document');
  assert.equal(attachmentKind('source.js'), null);
});
test('attachment selection rejects unsupported, empty, oversized, excessive and linked files', async t => {
  const { root, write } = await fixture(t);
  const file = await write('report.pdf', Buffer.alloc(10));
  await assert.rejects(prepareAttachments([file], { maxFileBytes: 9 }), /이하/);
  await assert.rejects(prepareAttachments([file, file], { maxTotalBytes: 15 }), /이하/);
  await assert.rejects(prepareAttachments([await write('empty.pdf', '')]), /비어/);
  await assert.rejects(prepareAttachments([await write('source.js', 'x')]), /지원하지/);
  await assert.rejects(prepareAttachments(['report.pdf']), /절대 경로/);
  await assert.rejects(prepareAttachments(Array(6).fill(file)), /최대 5개/);
  await assert.rejects(prepareAttachments([file], { cancelled: () => true }), /중지/);
  const folder = path.join(root, 'folder.pdf'); await fs.mkdir(folder);
  await assert.rejects(prepareAttachments([folder]), /일반 파일/);
  const link = path.join(root, 'linked.pdf');
  try { await fs.symlink(file, link); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(prepareAttachments([link]), /링크/);
});
test('video attachments extract three real JPEG frames with explicit sampling and audio limitations', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'clip.mp4');
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5:duration=3', '-c:v', 'mpeg4', '-y', file], { windowsHide: true, timeout: 30000 });
  const prepared = await prepareAttachments([file]);
  assert.equal(prepared.uploads.length, 3);
  assert.equal(prepared.context[0].durationSeconds, 3);
  assert.deepEqual(prepared.context[0].sampledFrameSeconds, [0.5, 1.5, 2.5]);
  assert.match(prepared.context[0].note, /Audio.*not analyzed/);
  for (const upload of prepared.uploads) {
    assert.equal(upload.mimeType, 'image/jpeg');
    assert.equal(upload.buffer.readUInt16BE(), 0xffd8);
    assert.equal(upload.buffer.readUInt16BE(upload.buffer.length - 2), 0xffd9);
    assert.ok(upload.buffer.length > 1000);
  }
  assert.notDeepEqual(prepared.uploads[0].buffer, prepared.uploads[2].buffer);
  await assert.rejects(prepareAttachments([file, file]), /장면 이미지 3개/);
});
test('invalid video fails without leaving temporary extracted files', async t => {
  const { write } = await fixture(t);
  const before = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('m365-attachment-') && !name.startsWith('m365-attachment-test-')));
  await assert.rejects(prepareAttachments([await write('invalid.mp4', 'not a video')]), /비디오 트랙/);
  const after = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('m365-attachment-') && !name.startsWith('m365-attachment-test-') && !before.has(name));
  assert.deepEqual(after, []);
});
test('same-name files retain distinct upload names and video cancellation cleans extraction state', async t => {
  const { root, write } = await fixture(t);
  const file = await write('report.pdf', Buffer.from('one'));
  await fs.mkdir(path.join(root, 'other'));
  const other = path.join(root, 'other', 'report.pdf'); await fs.writeFile(other, 'two');
  const prepared = await prepareAttachments([file, other]);
  assert.deepEqual(prepared.uploads.map(upload => upload.name), ['report.pdf', 'report-2.pdf']);
  assert.deepEqual(prepared.context.map(metadata => metadata.uploadedFiles), [['report.pdf'], ['report-2.pdf']]);
  assert.equal(prepared.uploads[1].buffer.toString(), 'two');
  const video = path.join(root, 'clip.mp4');
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=red:size=160x90:duration=1', '-c:v', 'mpeg4', '-y', video], { windowsHide: true, timeout: 30000 });
  let stopped = false;
  const before = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('m365-attachment-') && !name.startsWith('m365-attachment-test-')));
  await assert.rejects(prepareAttachments([video], { cancelled: () => stopped, onStatus: status => { if (status.includes('(1/3)')) stopped = true; } }), /중지/);
  const after = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('m365-attachment-') && !name.startsWith('m365-attachment-test-') && !before.has(name));
  assert.deepEqual(after, []);
});

test('Windows short filename aliases are accepted as ordinary selected files', async t => {
  if (process.platform !== 'win32') return t.skip('Windows 8.3 alias behavior');
  const { write } = await fixture(t);
  const bytes = Buffer.from('ordinary binary attachment');
  const file = await write('attachment-with-a-long-filename.pdf', bytes);
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$f = New-Object -ComObject Scripting.FileSystemObject; $f.GetFile($env:M365_ATTACHMENT_TEST_PATH).ShortPath'], { windowsHide: true, timeout: 30000, env: { ...process.env, M365_ATTACHMENT_TEST_PATH: file } });
  const shortPath = stdout.trim();
  assert.ok(shortPath);
  if (shortPath.toLowerCase() === file.toLowerCase()) return t.skip('8.3 aliases disabled on this filesystem');
  assert.notEqual((await fs.realpath(shortPath)).toLowerCase(), shortPath.toLowerCase());
  const prepared = await prepareAttachments([shortPath]);
  assert.deepEqual(prepared.uploads[0].buffer, bytes);
  assert.equal(prepared.uploads[0].mimeType, 'application/pdf');
});

test('attachments reject linked parent directories including Windows junctions', async t => {
  const { root } = await fixture(t);
  const actual = path.join(root, 'actual');
  await fs.mkdir(actual);
  await fs.writeFile(path.join(actual, 'report.pdf'), 'ordinary data');
  const alias = path.join(root, 'directory-alias');
  await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
  await assert.rejects(prepareAttachments([path.join(alias, 'report.pdf')]), /링크/);
  assert.equal((await prepareAttachments([path.join(actual, 'report.pdf')])).uploads[0].buffer.toString(), 'ordinary data');
});
