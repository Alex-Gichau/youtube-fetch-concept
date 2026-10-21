const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDownloadRequest, sanitizeFileName } = require('./download-utils.js');

test('buildDownloadRequest creates a valid single-track payload', () => {
  const payload = buildDownloadRequest({
    videoId: 'dUVs5Ocou8I',
    title: 'My Test Video',
    format: 'audio',
    mode: 'single',
  });

  assert.equal(payload.videoId, 'dUVs5Ocou8I');
  assert.equal(payload.format, 'audio');
  assert.equal(payload.mode, 'single');
  assert.match(payload.fileName, /My Test Video/);
  assert.match(payload.fileName, /\.mp3|\.webm|\.m4a/);
});

test('sanitizeFileName strips unsafe characters', () => {
  assert.equal(sanitizeFileName('A/B:C * ? " < > |'), 'A_B_C_');
});
