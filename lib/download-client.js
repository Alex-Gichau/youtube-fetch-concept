// lib/download-client.js
//
// Browser-side helper for driving a background download job:
//   1. POST  /api/download/start   -> { jobId }
//   2. GET   /api/download/status  -> { phase, percent, message, error }
//   3. GET   /api/download/file    -> the actual attachment
//
// The old flow used `window.location.href = '/api/download?…'`, which navigated
// the whole page away, showed no progress, and turned any server error into a
// raw JSON page. This keeps the app in place and reports what is happening.

const POLL_INTERVAL_MS = 700;
const MAX_POLLS = 2000;

export const TERMINAL_PHASES = new Set(['ready', 'error', 'cancelled']);

/** Format a byte count for the progress readout. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Human readable label for each job phase. */
export function phaseLabel(phase) {
  switch (phase) {
    case 'queued':
      return 'Queued';
    case 'resolving':
      return 'Resolving formats';
    case 'downloading':
      return 'Downloading';
    case 'processing':
      return 'Converting';
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Working';
  }
}

async function postStart(payload) {
  const response = await fetch('/api/download/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || 'Could not start the download');
  }

  if (!data?.jobId) {
    throw new Error('The server did not return a download job');
  }

  return data.jobId;
}

async function pollStatus(jobId, onUpdate) {
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const response = await fetch(`/api/download/status?jobId=${encodeURIComponent(jobId)}`);
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || 'Lost track of the download');
    }

    if (onUpdate) onUpdate(data);

    if (TERMINAL_PHASES.has(data.phase)) return data;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error('The download took too long and was stopped');
}

/** Ask the server to stop a running job. */
export async function cancelDownload(jobId) {
  const response = await fetch(
    `/api/download/cancel?jobId=${encodeURIComponent(jobId)}`,
    { method: 'POST' }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || 'Could not cancel the download');
  }

  return data?.cancelled === true;
}

/**
 * Was this failure a cancellation rather than a real error?
 *
 * Cancelling is a user action, not a failure, so the UI shows it differently
 * and leaves the button enabled.
 */
export function isCancelledError(error) {
  const message = error?.message || '';
  return /cancelled|canceled/i.test(message);
}

/**
 * Run one download end to end.
 *
 * @param {object} options
 * @param {object} options.payload   body for /api/download/start
 * @param {function} options.onUpdate called with each status snapshot
 * @param {function} options.onJobId  called with the job id, so the UI can offer a cancel button
 * @returns {Promise<object>} the final status (phase 'ready')
 */
export async function runDownload({ payload, onUpdate, onJobId }) {
  const jobId = await postStart(payload);

  if (onJobId) onJobId(jobId);

  const finalStatus = await pollStatus(jobId, onUpdate);

  if (finalStatus.phase === 'error') {
    throw new Error(finalStatus.error || 'The download failed');
  }

  if (finalStatus.phase === 'cancelled') {
    throw new Error(finalStatus.error || 'The download was cancelled');
  }

  // Hand the file to the browser as a normal attachment.
  const link = document.createElement('a');
  link.href = `/api/download/file?jobId=${encodeURIComponent(jobId)}`;
  link.download = finalStatus.fileName || 'youtube-download';
  document.body.appendChild(link);
  link.click();
  link.remove();

  return finalStatus;
}
