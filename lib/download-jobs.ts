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

async function writeState(job: JobStatus): Promise<void> {
  await fs.mkdir(path.dirname(statePath(job.id)), { recursive: true });
  await fs.writeFile(statePath(job.id), JSON.stringify(job), 'utf8');
}

async function readState(jobId: string): Promise<JobStatus | null> {
  try {
    const raw = await fs.readFile(statePath(jobId), 'utf8');
    return JSON.parse(raw) as JobStatus;
  } catch {
    return null;
  }
}

async function removeState(jobId: string): Promise<void> {
  await fs.rm(statePath(jobId), { force: true }).catch(() => undefined);
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
  onEvent?: (event: YtDlpEvent) => void
): Promise<void> {
  let lastError: Error | null = null;

  for (const strategy of PLAYER_CLIENT_STRATEGIES) {
    await touch(job, {
      phase: 'resolving',
      percent: 0,
      message:
        strategy.label === 'default'
          ? 'Resolving video formats…'
          : `Resolving video formats (retry via ${strategy.label})…`,
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

async function runBatch(job: JobStatus, input: StartJobInput): Promise<void> {
  const AdmZip = require('adm-zip');
  const items = input.playlistItems ?? [];

  if (!items.length) throw new Error('That playlist has no videos to download.');

  const dir = await jobDir(job.id);
  const zipName = `${sanitizeStem(input.title, 'youtube-playlist')}-${input.format}.zip`;
  const archivePath = path.join(dir, zipName);
  const produced: string[] = [];
  const failures: string[] = [];

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
      const base = (index / items.length) * 100;

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
                Math.round(base + (event.percent / 100) * (100 / items.length))
              );
              void touch(job, {
                phase: 'downloading',
                percent: overall,
                bytes: event.bytes,
                message: `Downloading ${index + 1} of ${items.length}: ${item.title}`,
              });
            } else {
              void touch(job, {
                phase: 'processing',
                percent: 99,
                message: `Converting ${index + 1} of ${items.length}: ${item.title}`,
              });
            }
          }
        );
      } catch (error) {
        // One unavailable or region-blocked video must not lose the whole
        // playlist — skip it and keep going.
        const message = error instanceof Error ? error.message : 'Download failed';
        failures.push(`${item.title}: ${message}`);
        void touch(job, {
          phase: 'downloading',
          percent: Math.round(((index + 1) / items.length) * 100),
          message: `Skipped ${index + 1} of ${items.length} (unavailable) — continuing…`,
        });
        continue;
      }

      const filePath = await findOutput(itemDir, input.format);
      if (filePath) produced.push(filePath);
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
  return readState(id);
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
