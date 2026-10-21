const test = require('node:test');
const assert = require('node:assert/strict');

// The client helper is browser-facing ESM, so it is imported dynamically here.
let client;

test.before(async () => {
  client = await import('./download-client.js');
});

test('formatBytes renders a human readable size', () => {
  assert.equal(client.formatBytes(0), '');
  assert.equal(client.formatBytes(1024), '1.0 KB');
  assert.equal(client.formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(client.formatBytes(1536 * 1024), '1.5 MB');
});

test('phaseLabel covers every job phase', () => {
  assert.equal(client.phaseLabel('queued'), 'Queued');
  assert.equal(client.phaseLabel('resolving'), 'Resolving formats');
  assert.equal(client.phaseLabel('downloading'), 'Downloading');
  assert.equal(client.phaseLabel('processing'), 'Converting');
  assert.equal(client.phaseLabel('ready'), 'Ready');
  assert.equal(client.phaseLabel('error'), 'Failed');
  assert.equal(client.phaseLabel('cancelled'), 'Cancelled');
});

test('cancelled is a terminal phase', () => {
  assert.equal(client.TERMINAL_PHASES.has('cancelled'), true);
  assert.equal(client.TERMINAL_PHASES.has('ready'), true);
  assert.equal(client.TERMINAL_PHASES.has('error'), true);
  assert.equal(client.TERMINAL_PHASES.has('downloading'), false);
});

test('isCancelledError tells a cancellation apart from a real failure', () => {
  assert.equal(client.isCancelledError(new Error('The download was cancelled.')), true);
  assert.equal(client.isCancelledError(new Error('The download was canceled')), true);
  assert.equal(
    client.isCancelledError(new Error('ERROR: [youtube] notavalidid: This video is unavailable')),
    false
  );
  assert.equal(client.isCancelledError(new Error('boom')), false);
});
