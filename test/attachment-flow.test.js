'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore } = require('../src/workspace');
const { CodingAgent } = require('../src/agent');
const { buildPrompt } = require('../src/protocol');

test('agent uploads binary bytes once, preserves them on an unsent retry, and retains metadata on tool rounds', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm365-attachment-flow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'source.txt'), 'workspace text');
  const store = await new WorkspaceStore(root).initialize();
  const upload = { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from([0, 255, 9]) };
  const metadata = [{ name: upload.name, kind: 'image', uploadedFiles: [upload.name] }];
  let requests = 0, firstId;
  const agent = new CodingAgent({
    store, mode: 'ask', attachments: [upload], attachmentContext: metadata, emit() {},
    transport: {
      async request(prompt, id, _status, _protocol, options) {
        requests++;
        assert.deepEqual(JSON.parse(prompt.split('DATA: ')[1]).attachments, metadata);
        assert.equal(prompt.includes(upload.buffer.toString('base64')), false);
        if (requests === 1) {
          firstId = id;
          assert.deepEqual(options.attachments, [upload]);
          throw Object.assign(new Error('unsent length rejection'), { code: 'PROMPT_LIMIT', notSubmitted: true, maxCharacters: 4000 });
        }
        if (requests === 2) {
          assert.equal(id, firstId);
          assert.deepEqual(options.attachments, [upload]);
          return { kind: 'tools', calls: [{ name: 'read_file', path: 'source.txt' }] };
        }
        assert.deepEqual(options.attachments, []);
        return { kind: 'done', message: 'analyzed' };
      },
    },
  });
  await agent.run('Analyze this image', JSON.stringify([{ path: 'large.txt', content: 'x'.repeat(10000) }]));
  assert.equal(requests, 3);
  assert.deepEqual(agent.attachments, []);
});

test('video frame timestamps and incomplete coverage survive text-context compaction', () => {
  const metadata = [{ name: 'clip.mp4', kind: 'video', sampledFrameSeconds: [1, 3, 5], note: 'Only three frames; audio and unsampled scenes were not analyzed.' }];
  const prompt = buildPrompt({
    id: 'video-context', task: 'Analyze the video', workspace: 'test', mode: 'ask',
    attachments: metadata, maxCharacters: 4000,
    extraContext: [{ path: 'large.txt', content: 'x'.repeat(10000) }],
  });
  const data = JSON.parse(prompt.split('DATA: ')[1]);
  assert.deepEqual(data.attachments, metadata);
  assert.ok(data.context[0].omitted);
  assert.ok(prompt.length <= 4000);
  assert.match(prompt, /audio and unsampled scenes were not analyzed/);
});
