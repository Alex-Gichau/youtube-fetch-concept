// lib/download-jobs.ts
//
// Background download jobs with live progress.
//
// Why this exists: the previous implementation ran the whole download inside a
// single API request and only then started streaming bytes to the browser. For a
// 200MB video that meant ~2 minutes of silence followed by a giant response —
// and any failure dumped the user onto a raw JSON error page.
//
// This module runs each download as a background job that reports a phase and a
// percentage. The browser polls the job status, and once the file is on disk it
// pulls it through a normal attachment response, which the browser handles as a
// native download.
//
// Job state is persisted to disk rather than kept in memory. Next.js compiles
// every API route into its own bundle, so an in-process Map is not shared
// between /api/download/start, /api/download/status and /api/download/file —
// the status route answers 404 for a job it never heard of. Writing the state
// to a JSON file also keeps it correct if the routes end up in different
// processes.

import { spawn } from 'child_process';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import os from 'os';

import { sanitizeFileName } from './download-utils.js';

const youtubedl = require('youtube-dl-exec');

export type DownloadFormat = 'audio' | 'video';

export type JobPhase =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'processing'
  | 'ready'
  | 'error'
  | 'cancelled';

/**
 * The state of one song inside a batch job.
 *
 * A batch can cover hundreds of songs, so the UI needs to know which one is
 * running right now, which ones are already finished and which ones could not
 * be downloaded at all.
 */
export type BatchItemState = 'pending' | 'downloading' | 'processing' | 'done' | 'skipped';

export interface BatchItemStatus {
  id: string;
  title: string;
  state: BatchItemState;
  /** 0-100 for this song on its own. */
  percent: number;
  bytes?: number;
  /** Why this song was skipped, when it failed. */
  error?: string;
}

export interface JobStatus {
  id: string;
  phase: JobPhase;
  /** 0-100, best effort. */
  percent: number;
  message: string;
  fileName?: string;
  /** Absolute path of the finished file on the server. */
  filePath?: string;
  bytes?: number;
  error?: string;
  /** One entry per song, for batch jobs. */
  items?: BatchItemStatus[];
  createdAt: number;
  updatedAt: number;
}

export interface StartJobInput {
  videoId?: string;
  url?: string;
  title: string;
  format: DownloadFormat;
  /** When set, the whole playlist is zipped and offered as one file. */
  playlistId?: string;
  playlistItems?: { id: string; title: string }[];
}

/** How long a finished job's file stays on disk before it is swept away. */
const FILE_TTL_MS = 10 * 60 * 1000;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_JOBS = 4;

/** How often the per-song list of a batch job is written to disk. */
const ITEMS_WRITE_INTERVAL_MS = 400;

const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'opus', 'wav'];
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mkv', 'm4v'];

/* -------------------------------------------------------------------------- */
/* Concurrency limiter (per process)                                          */
/* -------------------------------------------------------------------------- */

interface Registry {
  running: number;
  queue: (() => void)[];
  /** The yt-dlp child process of each running job, so it can be killed. */
  children: Map<string, import('child_process').ChildProcess>;
  /**
   * Jobs the user asked to cancel, with the time of the request.
   *
   * The entry is kept for a while after the job stops: the runner keeps
   * reporting progress for a moment, and those late updates must not be able
   * to overwrite the cancelled state.
   */
  cancelled: Map<string, number>;
}

const globalScope = globalThis as typeof globalThis & {
  __youtubeDownloadRegistry?: Registry;
};

const registry: Registry = (globalScope.__youtubeDownloadRegistry ??= {
  running: 0,
  queue: [],
  children: new Map(),
  cancelled: new Map(),
});

function isCancelled(jobId: string): boolean {
  return registry.cancelled.has(jobId);
}

/** Forget cancellations that are old enough that no update can still arrive. */
function pruneCancellations(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [jobId, at] of registry.cancelled) {
    if (at < cutoff) registry.cancelled.delete(jobId);
  }
}

function acquireSlot(): Promise<void> {
  if (registry.running < MAX_CONCURRENT_JOBS) {
    registry.running += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    registry.queue.push(() => {
      registry.running += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  registry.running = Math.max(0, registry.running - 1);
  const next = registry.queue.shift();
  if (next) next();
}

/* -------------------------------------------------------------------------- */
/* On-disk job storage                                                        */
/* -------------------------------------------------------------------------- */

async function rootDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'youtube-fetch-concept');
  await fs.mkdir(path.join(dir, 'jobs'), { recursive: true });
  return dir;
}

async function jobDir(jobId: string): Promise<string> {
  const dir = path.join(await rootDir(), 'jobs', jobId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function statePath(jobId: string): string {
  return path.join(os.tmpdir(), 'youtube-fetch-concept', 'jobs', `${jobId}.json`);
}

/**
 * The per-song list of a batch job lives in its own file.
 *
 * A batch can be hundreds of songs long, and the list only changes while a
 * song is running. Keeping it out of the main state file means the status
 * route stays cheap to poll and the progress updates stay small.
 */
function itemsPath(jobId: string): string {
  return path.join(os.tmpdir(), 'youtube-fetch-concept', 'jobs', `${jobId}.items.json`);
}

/**
 * Every write to the jobs directory goes through this queue.
 *
 * `touch()` is fired from yt-dlp's event handler without being awaited, so two
 * writes can be in flight at the same time. Writing the same file twice at
 * once can interleave and leave a half-written JSON file behind.
 */
let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => undefined);
  return next;
}

/**
 * Write a file so a reader never sees a half-written version.
 *
 * `fs.writeFile` truncates the target first and fills it afterwards, so a
 * status poll that lands in that window reads an empty or partial file. The
 * parse then fails and the status route answers 404 for a job that is very
 * much alive. Writing to a temporary file and renaming it over the target
 * avoids this: the rename is atomic, so a reader sees either the old file or
 * the new one, never a broken one.
 *
 * Windows refuses to rename over a file that somebody else has open
 * (`EPERM`), and the status route reads the state file constantly. The
 * rename is therefore retried for a moment — the reader only holds the file
 * for microseconds — and falls back to a direct write if it still fails.
 */
async function renameWithRetry(temp: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rename(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;

      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }

  // The reader is holding on longer than expected. Write straight to the
  // target instead — a reader may catch a partial file, but that is far
  // better than losing the update entirely.
  await fs.writeFile(target, await fs.readFile(temp, 'utf8'), 'utf8');
  await fs.rm(temp, { force: true }).catch(() => undefined);
}

async function writeJsonAtomic(target: string, payload: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, payload, 'utf8');

  try {
    await renameWithRetry(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeState(job: JobStatus): Promise<void> {
  const payload = JSON.stringify(job);
  const target = statePath(job.id);

  await enqueueWrite(() => writeJsonAtomic(target, payload));
}

async function writeItems(jobId: string, items: BatchItemStatus[]): Promise<void> {
  const payload = JSON.stringify(items);
  const target = itemsPath(jobId);

  await enqueueWrite(() => writeJsonAtomic(target, payload));
}

async function readItems(jobId: string): Promise<BatchItemStatus[] | null> {
  try {
    const raw = await fs.readFile(itemsPath(jobId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BatchItemStatus[]) : null;
  } catch {
    return null;
  }
}

async function readState(jobId: string): Promise<JobStatus | null> {
  const target = statePath(jobId);

  // The state is written atomically, so a parse failure should not happen.
  // It still gets a couple of retries, because a "job not found" answer for a
  // job that is running would be a confusing lie.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = await fs.readFile(target, 'utf8');
      return JSON.parse(raw) as JobStatus;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      // A missing file is a real answer; anything else is worth retrying.
      if (code === 'ENOENT') return null;

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  return null;
}

async function removeState(jobId: string): Promise<void> {
  await enqueueWrite(async () => {
    await fs.rm(statePath(jobId), { force: true }).catch(() => undefined);
    await fs.rm(itemsPath(jobId), { force: true }).catch(() => undefined);
  });
  await removeJobFiles(jobId);
}

/** Delete a job's working directory but keep its state file. */
async function removeJobFiles(jobId: string): Promise<void> {
  await fs
    .rm(path.join(await rootDir(), 'jobs', jobId), { recursive: true, force: true })
    .catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Job state                                                                  */
/* -------------------------------------------------------------------------- */

async function touch(job: JobStatus, patch: Partial<JobStatus>): Promise<void> {
  // A cancelled job must stay cancelled. The runner keeps reporting progress
  // for a moment after the user cancels, and those late updates would
  // otherwise overwrite the cancelled state.
  if (isCancelled(job.id) && patch.phase !== 'cancelled') return;

  Object.assign(job, patch, { updatedAt: Date.now() });
  await writeState(job);
}

/** Remove jobs whose files or state have outlived their TTL. */
async function sweep(): Promise<void> {
  const jobsRoot = path.join(await rootDir(), 'jobs');

  let entries: string[];
  try {
    entries = await fs.readdir(jobsRoot);
  } catch {
    return;
  }

  const now = Date.now();

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    // The per-song list of a batch job lives in a sibling file.
    if (entry.endsWith('.items.json')) continue;

    const jobId = entry.slice(0, -'.json'.length);
    const state = await readState(jobId);
    if (!state) continue;

    if (state.phase === 'ready' && now - state.updatedAt > FILE_TTL_MS) {
      await removeState(jobId);
      continue;
    }

    if (now - state.updatedAt > JOB_TTL_MS) {
      await removeState(jobId);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* yt-dlp driver                                                              */
/* -------------------------------------------------------------------------- */

/**
 * yt-dlp progress lines look like:
 *   dl|downloading|2096128|4007026
 * We ask yt-dlp for a machine readable template and parse it.
 */
const PROGRESS_TEMPLATE =
  'dl|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s';

function parseProgressLine(line: string): { percent: number; bytes: number } | null {
  if (!line.startsWith('dl|')) return null;

  const parts = line.split('|');
  if (parts.length < 4) return null;

  const status = parts[1];
  const downloaded = Number(parts[2]);
  const total = Number(parts[3]);

  if (status === 'finished') return { percent: 100, bytes: downloaded || total || 0 };
  if (!Number.isFinite(downloaded) || !Number.isFinite(total) || total <= 0) return null;

  return { percent: Math.min(99, Math.round((downloaded / total) * 100)), bytes: downloaded };
}

/** Pick a sane default quality so we do not pull 1080p/222MB by default. */
function buildFormatArgs(format: DownloadFormat): Record<string, string | boolean> {
  if (format === 'audio') {
    return {
      format: 'bestaudio[ext=m4a]/bestaudio/best',
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '192K',
    };
  }

  // Cap at 720p: 1080p is ~4x the bytes for little practical gain here.
  return {
    format:
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    mergeOutputFormat: 'mp4',
  };
}

/**
 * YouTube blocks some videos for the default ("web") player client with
 * `HTTP Error 403: Forbidden` even though the video is perfectly public.
 * Retrying the same URL with a different player client usually works, so each
 * strategy is tried in turn until one succeeds.
 *
 * Order matters: the default client is tried first because it produces the
 * best quality ladders, and the fallbacks only kick in when it is blocked.
 */
const PLAYER_CLIENT_STRATEGIES: { label: string; extractorArgs?: string }[] = [
  { label: 'default' },
  { label: 'android', extractorArgs: 'youtube:player_client=android,web' },
  { label: 'ios', extractorArgs: 'youtube:player_client=ios,web' },
  { label: 'tv', extractorArgs: 'youtube:player_client=tv' },
  { label: 'web_safari', extractorArgs: 'youtube:player_client=web_safari' },
];

/** Errors that are worth retrying with another player client. */
function isRetryableError(message: string): boolean {
  return /403|Forbidden|unable to download video data|HTTP Error 5\d\d/i.test(message);
}

function buildArgs(
  format: DownloadFormat,
  outputTemplate: string,
  extractorArgs?: string
): Record<string, string | boolean> {
  return {
    noPlaylist: true,
    noWarnings: true,
    noColor: true,
    newline: true,
    output: outputTemplate,
    progressTemplate: PROGRESS_TEMPLATE,
    noCheckCertificates: true,
    noPart: true,
    ...(extractorArgs ? { extractorArgs } : {}),
    ...buildFormatArgs(format),
  };
}

/** yt-dlp puts the useful part of the failure on stderr; dig it out. */
function extractError(stderr: string): string {
  if (!stderr) return '';

  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const errorLines = lines.filter((line) => /^error/i.test(line));
  if (errorLines.length) return errorLines.slice(-3).join(' ');

  const warning = [...lines]
    .reverse()
    .find((line) => /unable|failed|not available|forbidden|private/i.test(line));

  return warning || '';
}

type YtDlpEvent =
  | { type: 'progress'; percent: number; bytes: number }
  | { type: 'processing'; message: string };

async function runYtDlpWithStrategy(
  job: JobStatus,
  url: string,
  outputTemplate: string,
  format: DownloadFormat,
  extractorArgs: string | undefined,
  onEvent?: (event: YtDlpEvent) => void
): Promise<void> {
  const args = youtubedl.args(buildArgs(format, outputTemplate, extractorArgs));

  await new Promise<void>((resolve, reject) => {
    const child = spawn(youtubedl.constants.YOUTUBE_DL_PATH, [...args, '--', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    registry.children.set(job.id, child);

    let stdoutBuffer = '';
    let stderrBuffer = '';

    const handleLine = (line: string) => {
      const progress = parseProgressLine(line);
      if (progress) {
        onEvent?.({ type: 'progress', percent: progress.percent, bytes: progress.bytes });
        return;
      }

      if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
        onEvent?.({ type: 'processing', message: 'Converting media…' });
        return;
      }

      if (line.includes('[download] Destination:')) {
        onEvent?.({ type: 'progress', percent: 1, bytes: 0 });
      }
    };

    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      if (stderrBuffer.length > 8000) stderrBuffer = stderrBuffer.slice(-8000);
    });

    child.on('error', (error) => reject(error));

    child.on('close', (code) => {
      registry.children.delete(job.id);

      const tail = stdoutBuffer.trim();
      if (tail) handleLine(tail);

      if (isCancelled(job.id)) {
        reject(new Error('The download was cancelled.'));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      const message = extractError(stderrBuffer) || `yt-dlp exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

/**
 * Run yt-dlp, retrying with alternate player clients when YouTube blocks the
 * default one with a 403.
 */
async function runYtDlp(
  job: JobStatus,
  url: string,
  outputTemplate: string,
  format: DownloadFormat,
  onEvent?: (event: YtDlpEvent) => void,
  label?: string
): Promise<void> {
  let lastError: Error | null = null;

  for (const strategy of PLAYER_CLIENT_STRATEGIES) {
    const prefix = label ? `${label} — ` : '';
    await touch(job, {
      phase: 'resolving',
      // The overall percentage must not jump back to zero when the next song
      // of a batch starts — that would make the bar move backwards.
      percent: job.percent,
      message:
        strategy.label === 'default'
          ? `${prefix}Resolving video formats…`
          : `${prefix}Resolving video formats (retry via ${strategy.label})…`,
    });

    try {
      await runYtDlpWithStrategy(
        job,
        url,
        outputTemplate,
        format,
        strategy.extractorArgs,
        onEvent
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(message);

      // A blocked video is worth another client; an unavailable one is not.
      if (!isRetryableError(message)) throw lastError;
    }
  }

  throw lastError ?? new Error('The download failed.');
}

/**
 * Find the file yt-dlp produced.
 *
 * Each job gets its own directory, and each item of a batch gets its own
 * sub-directory, so a lookup can never return a file belonging to a different
 * item. The extension preference list is honoured in order, so a leftover
 * `.m4a` source never wins over the `.mp3` we actually asked for.
 */
async function findOutput(dir: string, format: DownloadFormat): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }

  const preferred = format === 'audio' ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
  const fallback = format === 'audio' ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS;

  const pick = (allowed: string[]) => {
    for (const ext of allowed) {
      const match = files.find((file) => {
        const fileExt = path.extname(file).slice(1).toLowerCase();
        // Skip yt-dlp's merge intermediates (video.f137.mp4) and partials.
        return fileExt === ext && !/\.f\d+/i.test(file);
      });
      if (match) return match;
    }
    return undefined;
  };

  const match = pick(preferred) ?? pick(fallback);

  return match ? path.join(dir, match) : null;
}

/* -------------------------------------------------------------------------- */
/* Job runners                                                                */
/* -------------------------------------------------------------------------- */

function sanitizeStem(title: string, fallback: string): string {
  return sanitizeFileName(title) || fallback;
}

async function runSingle(job: JobStatus, input: StartJobInput): Promise<void> {
  const url =
    input.url || `https://www.youtube.com/watch?v=${encodeURIComponent(input.videoId || '')}`;

  const dir = await jobDir(job.id);
  const stem = sanitizeStem(input.title, input.videoId || 'youtube-download');
  const outputTemplate = path.join(dir, `${stem}.%(ext)s`);

  await runYtDlp(job, url, outputTemplate, input.format, (event) => {
    if (event.type === 'progress') {
      void touch(job, {
        phase: 'downloading',
        percent: event.percent,
        bytes: event.bytes,
        message: 'Downloading…',
      });
    } else {
      void touch(job, { phase: 'processing', percent: 99, message: event.message });
    }
  });

  const filePath = await findOutput(dir, input.format);
  if (!filePath) throw new Error('The download finished but no file was created.');

  const stat = await fs.stat(filePath);

  await touch(job, {
    phase: 'ready',
    percent: 100,
    message: 'Ready to download',
    fileName: path.basename(filePath),
    filePath,
    bytes: stat.size,
  });
}

/**
 * Keeps the per-song list of a batch job up to date.
 *
 * The list is written to its own file so the main state file stays small no
 * matter how many songs the playlist holds. Progress events arrive many times
 * per second, so writes are throttled; a state change (a song finishing, being
 * skipped, or the next one starting) is always written straight away.
 */
class BatchTracker {
  private readonly jobId: string;
  private readonly items: BatchItemStatus[];
  private lastWrite = 0;

  constructor(jobId: string, items: BatchItemStatus[]) {
    this.jobId = jobId;
    this.items = items;
  }

  /** The live list. The UI receives a copy of this. */
  get list(): BatchItemStatus[] {
    return this.items;
  }

  /** Update one song and publish the list. */
  update(index: number, patch: Partial<BatchItemStatus>, immediate = false): void {
    const item = this.items[index];
    if (!item) return;

    Object.assign(item, patch);
    this.publish(immediate);
  }

  /** Write the list to disk now. */
  async flush(): Promise<void> {
    this.lastWrite = Date.now();
    await writeItems(this.jobId, this.items);
  }

  private publish(immediate: boolean): void {
    const now = Date.now();
    if (!immediate && now - this.lastWrite < ITEMS_WRITE_INTERVAL_MS) return;

    this.lastWrite = now;
    void writeItems(this.jobId, this.items);
  }
}

async function runBatch(job: JobStatus, input: StartJobInput): Promise<void> {
  const AdmZip = require('adm-zip');
  const items = input.playlistItems ?? [];

  if (!items.length) throw new Error('That playlist has no videos to download.');

  const dir = await jobDir(job.id);
  const zipName = `${sanitizeStem(input.title, 'youtube-playlist')}-${input.format}.zip`;
  const archivePath = path.join(dir, zipName);
  const produced: string[] = [];
  const failures: string[] = [];

  // Every song of the playlist starts out as pending, so the UI can show the
  // full queue right away.
  const tracker = new BatchTracker(
    job.id,
    items.map((item) => ({
      id: item.id,
      title: item.title,
      state: 'pending' as const,
      percent: 0,
    }))
  );

  await tracker.flush();

  try {
    for (let index = 0; index < items.length; index += 1) {
      if (isCancelled(job.id)) throw new Error('The download was cancelled.');

      const item = items[index];

      // Each item downloads into its own sub-directory so a lookup can never
      // return a file that belongs to a different item.
      const itemDir = path.join(dir, String(index));
      await fs.mkdir(itemDir, { recursive: true });

      const stem = sanitizeStem(item.title, item.id);
      const outputTemplate = path.join(itemDir, `${stem}.%(ext)s`);

      // Overall progress = completed items + the current item's progress.
      // The bar must never move backwards, so every phase of this item stays
      // inside the slice of the bar that belongs to it.
      const span = 100 / items.length;
      const base = index * span;
      const label = `${index + 1} of ${items.length}: ${item.title}`;

      tracker.update(index, { state: 'downloading', percent: 0, error: undefined }, true);

      try {
        await runYtDlp(
          job,
          `https://www.youtube.com/watch?v=${item.id}`,
          outputTemplate,
          input.format,
          (event) => {
            if (event.type === 'progress') {
              const overall = Math.min(
                99,
                Math.round(base + (event.percent / 100) * span)
              );
              tracker.update(index, { percent: event.percent, bytes: event.bytes });
              void touch(job, {
                phase: 'downloading',
                percent: overall,
                bytes: event.bytes,
                message: `Downloading ${label}`,
              });
            } else {
              tracker.update(index, { state: 'processing', percent: 100 });
              void touch(job, {
                phase: 'processing',
                // Converting counts as almost done, but the slot is only
                // closed once the song has actually been produced.
                percent: Math.min(99, Math.round(base + span * 0.95)),
                message: `Converting ${label}`,
              });
            }
          },
          label
        );
      } catch (error) {
        // One unavailable or region-blocked video must not lose the whole
        // playlist — skip it and keep going.
        const message = error instanceof Error ? error.message : 'Download failed';
        failures.push(`${item.title}: ${message}`);
        tracker.update(index, { state: 'skipped', percent: 0, error: message }, true);
        void touch(job, {
          phase: 'downloading',
          // A skipped song closes its slice of the bar, so the bar keeps
          // moving forward instead of jumping over the songs still to come.
          percent: Math.min(99, Math.round(base + span)),
          message: `Skipped ${label} (unavailable) — continuing…`,
        });
        continue;
      }

      const filePath = await findOutput(itemDir, input.format);

      if (filePath) {
        produced.push(filePath);
        tracker.update(index, { state: 'done', percent: 100, error: undefined }, true);
      } else {
        failures.push(`${item.title}: no media file was produced`);
        tracker.update(
          index,
          { state: 'skipped', percent: 0, error: 'No media file was produced.' },
          true
        );
      }
    }

    if (!produced.length) {
      const detail = failures.length ? ` ${failures[0]}` : '';
      throw new Error(`No media files were produced for this playlist.${detail}`);
    }

    await touch(job, { phase: 'processing', percent: 99, message: 'Building ZIP archive…' });

    const zip = new AdmZip();
    for (const filePath of produced) {
      zip.addLocalFile(filePath, '', path.basename(filePath));
    }
    zip.writeZip(archivePath);

    const stat = await fs.stat(archivePath);

    // Make sure the final list is on disk before the job is reported as ready.
    await tracker.flush();

    await touch(job, {
      phase: 'ready',
      percent: 100,
      message: failures.length
        ? `Ready to download — ${produced.length} of ${items.length} videos (${failures.length} unavailable)`
        : 'Ready to download',
      fileName: zipName,
      filePath: archivePath,
      bytes: stat.size,
    });
  } finally {
    await Promise.allSettled(
      produced.map((file) => fs.unlink(file).catch(() => undefined))
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function startDownloadJob(input: StartJobInput): Promise<JobStatus> {
  await sweep();
  pruneCancellations();

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();

  const job: JobStatus = {
    id,
    phase: 'queued',
    percent: 0,
    message: 'Queued…',
    createdAt: now,
    updatedAt: now,
  };

  await writeState(job);

  const run = async () => {
    try {
      if (isCancelled(job.id)) {
        await touch(job, {
          phase: 'cancelled',
          percent: 0,
          message: 'Cancelled',
          error: 'The download was cancelled.',
        });
        return;
      }

      if (input.playlistId && input.playlistItems?.length) {
        await runBatch(job, input);
      } else {
        await runSingle(job, input);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Download failed';

      if (isCancelled(job.id)) {
        await touch(job, {
          phase: 'cancelled',
          percent: 0,
          message: 'Cancelled',
          error: 'The download was cancelled.',
        });
        return;
      }

      await touch(job, {
        phase: 'error',
        percent: 0,
        message: 'Download failed',
        error: message,
      });
    } finally {
      registry.children.delete(job.id);
      releaseSlot();

      if (isCancelled(job.id)) {
        // Drop the partial files the cancelled download left behind, but keep
        // the state file so the status route can still report "cancelled".
        await removeJobFiles(job.id);
      }
    }
  };

  void acquireSlot().then(() => {
    void run();
  });

  return job;
}

/** Stop a running job and clean up whatever it had downloaded so far. */
export async function cancelDownloadJob(id: string): Promise<boolean> {
  const job = await readState(id);
  if (!job) return false;

  if (job.phase === 'ready' || job.phase === 'error' || job.phase === 'cancelled') {
    return false;
  }

  registry.cancelled.set(id, Date.now());

  const child = registry.children.get(id);
  if (child) {
    try {
      child.kill();
    } catch {
      // The process may already be gone.
    }
  }

  await touch(job, {
    phase: 'cancelled',
    percent: 0,
    message: 'Cancelled',
    error: 'The download was cancelled.',
  });

  return true;
}

export async function getDownloadJob(id: string): Promise<JobStatus | null> {
  await sweep();
  const job = await readState(id);
  if (!job) return null;

  // The per-song list is kept in its own file, so attach it on the way out.
  const items = await readItems(id);
  if (items) job.items = items;

  return job;
}

export async function getJobFilePath(id: string): Promise<string | null> {
  const job = await readState(id);
  if (!job || job.phase !== 'ready' || !job.filePath) return null;
  return job.filePath;
}

export async function markJobConsumed(id: string): Promise<void> {
  await removeState(id);
}

/** Stream a finished job's file to the browser as an attachment. */
export async function streamJobFile(
  id: string,
  res: {
    setHeader: (name: string, value: string) => void;
    end: (chunk?: unknown) => void;
  }
): Promise<boolean> {
  const filePath = await getJobFilePath(id);
  if (!filePath) return false;

  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();

  const mimeType =
    ext === '.mp3'
      ? 'audio/mpeg'
      : ext === '.m4a'
        ? 'audio/mp4'
        : ext === '.mp4'
          ? 'video/mp4'
          : ext === '.webm'
            ? 'video/webm'
            : ext === '.zip'
              ? 'application/zip'
              : 'application/octet-stream';

  const stat = await fs.stat(filePath);

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  );

  await new Promise<void>((resolve) => {
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      res.end();
      resolve();
    });
    stream.on('close', () => resolve());
    stream.pipe(res as unknown as NodeJS.WritableStream);
  });

  await markJobConsumed(id);
  return true;
}
