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
  assert.match(payload.fileName, /My.*Video/);
  assert.match(payload.fileName, /\.mp3|\.webm|\.m4a/);
});

test('sanitizeFileName strips unsafe characters', () => {
  assert.equal(sanitizeFileName('A/B:C * ? " < > |'), 'A_B_C');
});

test('sanitizeFileName normalizes smart quotes and apostrophes for a browser-safe header', () => {
  assert.equal(sanitizeFileName("Hulvey, Torey D’Shaun - Love Like That (Official Audio)"), 'Hulvey_Torey_D_Shaun_Love_Like_That_Official_Audio');
});

test('sanitizeFileName keeps the result ASCII-only so headers never break', () => {
  const result = sanitizeFileName('Café "Écriture" — naïve');
  assert.match(result, /^[\x20-\x7E]+$/);
});

test('sanitizeFileName falls back when there is nothing usable', () => {
  assert.equal(sanitizeFileName('***'), 'youtube-download');
  assert.equal(sanitizeFileName(''), 'youtube-download');
});


