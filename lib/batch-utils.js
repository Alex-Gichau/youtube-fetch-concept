// lib/batch-utils.js
//
// Helpers for the per-song list of a batch (playlist) download.
//
// The server sends one entry per song with a state, so the UI can show which
// song is running, tick the ones that are finished and mark the ones that
// could not be downloaded. The pure logic lives here so it can be tested
// without a browser.

/** The states a song can be in during a batch download. */
const BATCH_ITEM_STATES = ['pending', 'downloading', 'processing', 'done', 'skipped'];

/** The states that mean the song is finished, one way or another. */
const BATCH_FINISHED_STATES = new Set(['done', 'skipped']);

/**
 * The glyph shown in front of a song.
 *
 * A tick marks a song that made it into the archive, a cross marks one that
 * could not be downloaded, a filled dot marks the song that is running right
 * now and an empty circle marks one that is still waiting.
 */
function batchItemMarker(item) {
  switch (item && item.state) {
    case 'done':
      return '✓';
    case 'skipped':
      return '✕';
    case 'downloading':
    case 'processing':
      return '●';
    default:
      return '○';
  }
}

/** A short label for the state of a song. */
function batchItemStateLabel(item) {
  switch (item && item.state) {
    case 'done':
      return 'Done';
    case 'skipped':
      return 'Skipped';
    case 'downloading':
      return 'Downloading';
    case 'processing':
      return 'Converting';
    default:
      return 'Queued';
  }
}

/**
 * Count how the batch is going.
 */
function batchSummary(items) {
  const list = Array.isArray(items) ? items : [];

  const summary = {
    total: list.length,
    done: 0,
    skipped: 0,
    pending: 0,
    currentIndex: -1,
    finished: 0,
  };

  list.forEach((item, index) => {
    const state = item && item.state;

    if (state === 'done') summary.done += 1;
    else if (state === 'skipped') summary.skipped += 1;
    else if (state === 'pending') summary.pending += 1;

    if (state === 'downloading' || state === 'processing') {
      summary.currentIndex = index;
    }
  });

  summary.finished = summary.done + summary.skipped;

  return summary;
}

/** The song that is running right now, if any. */
function currentBatchItem(items) {
  const list = Array.isArray(items) ? items : [];
  const summary = batchSummary(list);

  if (summary.currentIndex < 0) return null;
  return list[summary.currentIndex] || null;
}

/**
 * A one line summary of the batch, shown next to the overall progress bar.
 */
function batchSummaryText(items) {
  const { total, done, skipped, pending } = batchSummary(items);

  if (!total) return '';

  const parts = [`${done} of ${total} done`];

  if (skipped) parts.push(`${skipped} skipped`);
  if (pending) parts.push(`${pending} waiting`);

  return parts.join(' · ');
}

/**
 * The slice of the list that is worth showing.
 *
 * A playlist can hold hundreds of songs. Rendering all of them on every poll
 * is wasteful, so only a window around the song that is running right now is
 * kept.
 *
 * Each entry comes back with its `position` in the full list, so the caller
 * can key it stably while the window slides along.
 */
function visibleBatchItems(items, currentIndex, windowSize) {
  const list = Array.isArray(items) ? items : [];
  const size = windowSize === undefined ? 60 : Math.max(1, Math.floor(windowSize));

  let start = 0;

  if (list.length > size) {
    const half = Math.max(1, Math.floor(size / 2));
    const anchor = Number.isFinite(currentIndex) ? currentIndex : 0;

    start = Math.max(0, anchor - half);
    start = Math.min(start, list.length - size);
  }

  const end = Math.min(list.length, start + size);

  return list.slice(start, end).map((item, offset) => ({
    ...item,
    position: start + offset,
  }));
}

module.exports = {
  BATCH_ITEM_STATES,
  BATCH_FINISHED_STATES,
  batchItemMarker,
  batchItemStateLabel,
  batchSummary,
  currentBatchItem,
  batchSummaryText,
  visibleBatchItems,
};
