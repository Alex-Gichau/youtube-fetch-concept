const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BATCH_ITEM_STATES,
  BATCH_FINISHED_STATES,
  batchItemMarker,
  batchItemStateLabel,
  batchSummary,
  currentBatchItem,
  batchSummaryText,
  visibleBatchItems,
} = require('./batch-utils.js');

const makeItems = (states) =>
  states.map((state, index) => ({
    id: `id-${index}`,
    title: `Song ${index + 1}`,
    state,
    percent: state === 'done' ? 100 : 0,
  }));

test('every state a song can have is known', () => {
  assert.deepEqual(BATCH_ITEM_STATES, [
    'pending',
    'downloading',
    'processing',
    'done',
    'skipped',
  ]);
});

test('done and skipped are the finished states', () => {
  assert.equal(BATCH_FINISHED_STATES.has('done'), true);
  assert.equal(BATCH_FINISHED_STATES.has('skipped'), true);
  assert.equal(BATCH_FINISHED_STATES.has('pending'), false);
  assert.equal(BATCH_FINISHED_STATES.has('downloading'), false);
});

test('a finished song gets a tick and a skipped one gets a cross', () => {
  assert.equal(batchItemMarker({ state: 'done' }), '✓');
  assert.equal(batchItemMarker({ state: 'skipped' }), '✕');
  assert.equal(batchItemMarker({ state: 'downloading' }), '●');
  assert.equal(batchItemMarker({ state: 'processing' }), '●');
  assert.equal(batchItemMarker({ state: 'pending' }), '○');
  assert.equal(batchItemMarker(null), '○');
});

test('each state has a readable label', () => {
  assert.equal(batchItemStateLabel({ state: 'done' }), 'Done');
  assert.equal(batchItemStateLabel({ state: 'skipped' }), 'Skipped');
  assert.equal(batchItemStateLabel({ state: 'downloading' }), 'Downloading');
  assert.equal(batchItemStateLabel({ state: 'processing' }), 'Converting');
  assert.equal(batchItemStateLabel({ state: 'pending' }), 'Queued');
});

test('the summary counts done, skipped and pending songs', () => {
  const summary = batchSummary(
    makeItems(['done', 'done', 'skipped', 'downloading', 'pending'])
  );

  assert.equal(summary.total, 5);
  assert.equal(summary.done, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.finished, 3);
  assert.equal(summary.currentIndex, 3);
});

test('the summary of an empty list is empty', () => {
  const summary = batchSummary([]);

  assert.equal(summary.total, 0);
  assert.equal(summary.done, 0);
  assert.equal(summary.finished, 0);
  assert.equal(summary.currentIndex, -1);
});

test('the summary survives a missing list', () => {
  assert.equal(batchSummary(undefined).total, 0);
  assert.equal(batchSummary(null).total, 0);
});

test('the running song is the one being downloaded', () => {
  const items = makeItems(['done', 'downloading', 'pending']);
  const current = currentBatchItem(items);

  assert.equal(current.title, 'Song 2');
});

test('there is no running song when nothing is in flight', () => {
  assert.equal(currentBatchItem(makeItems(['done', 'pending'])), null);
  assert.equal(currentBatchItem([]), null);
});

test('the summary text reads like a sentence', () => {
  const text = batchSummaryText(makeItems(['done', 'skipped', 'downloading', 'pending']));

  assert.equal(text, '1 of 4 done · 1 skipped · 1 waiting');
});

test('the summary text is empty without songs', () => {
  assert.equal(batchSummaryText([]), '');
});

test('a short list is shown in full', () => {
  const items = makeItems(['pending', 'pending', 'pending']);
  const window = visibleBatchItems(items, 1, 60);

  assert.equal(window.length, 3);
  assert.deepEqual(
    window.map((item) => item.position),
    [0, 1, 2]
  );
});

test('a long list is trimmed to a window around the running song', () => {
  const items = makeItems(new Array(500).fill('pending'));
  const window = visibleBatchItems(items, 250, 60);

  assert.equal(window.length, 60);
  assert.equal(window[0].title, 'Song 221');
  assert.equal(window[window.length - 1].title, 'Song 280');
  assert.equal(window[0].position, 220);
});

test('the window stays inside the list at the edges', () => {
  const items = makeItems(new Array(500).fill('pending'));
  const window = visibleBatchItems(items, 0, 60);

  assert.equal(window.length, 60);
  assert.equal(window[0].title, 'Song 1');
  assert.equal(window[window.length - 1].title, 'Song 60');
});

test('the window is clamped to the end of the list', () => {
  const items = makeItems(new Array(500).fill('pending'));
  const window = visibleBatchItems(items, 499, 60);

  assert.equal(window.length, 60);
  assert.equal(window[window.length - 1].title, 'Song 500');
  assert.equal(window[window.length - 1].position, 499);
});
