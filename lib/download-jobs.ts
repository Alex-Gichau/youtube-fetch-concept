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

import { spawn } from 'child_process';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import os from 'os';

const youtubedl = require('youtube-dl-exec');

export type DownloadFormat = 'audio' | 'video';

export type JobPhase = 'queued' | 'resolving' | 'downloading' | 'processing' | 'ready' | 'error';

export interface JobStatus {
  id: string;
  phase: JobPhase;
  /** 0-100, best effort. */
  percent: number;
  message: string;
  fileName?: string;
  filePath?: string;
  bytes?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

interface Job extends JobStatus {
  cleanup: () => Promise<void>;
}

const JOBS = new Map<string, Job>();

/** How long a finished job's file stays on disk before it is swept away. */
const FILE_TTL_MS = 10 * 60 * 1000;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_JOBS = 4;

let running = 0;
const queue: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT_JOBS) {
    running += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    queue.push(() => {
      running += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  running = Math.max(0, running - 1);
  const next = queue.shift();
  if (next) next();
}

function touch(job: Job, patch: Partial<JobStatus>): void {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

async function ensureTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'youtube-fetch-concept');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * yt-dlp progress lines look like:
 *   download:downloading|  52.3%|2096128|4007026
 * We ask yt-dlp for a machine readable template and parse it.
 */
const PROGRESS_TEMPLATE = 'dl|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s';

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
function buildFormatArgs(format: DownloadFormat) {
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
    format: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    mergeOutputFormat: 'mp4',
  };
}

function buildArgs(
  format: DownloadFormat,
  outputTemplate: string
): Record<string, string | boolean> {
  const base: Record<string, string | boolean> = {
    noPlaylist: true,
    noWarnings: true,
    noColor: true,
    newline: true,
    output: outputTemplate,
    progressTemplate: PROGRESS_TEMPLATE,
    noCheckCertificates: true,
  };

  return { ...base, ...buildFormatArgs(format) } as Record<string, string | boolean>;
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

function sanitizeStem(title: string, fallback: string): string {
  const cleaned = (title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '')
    .replace(/([a-zA-Z0-9])['"]([a-zA-Z0-9])/g, '$1_$2')
    .replace(/['"]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return cleaned || fallback;
}

async function runYtDlp(
  job: Job,
  url: string,
  outputTemplate: string,
  format: DownloadFormat
): Promise<void> {
  const args = youtubedl.args(buildArgs(format, outputTemplate));

  touch(job, { phase: 'resolving', percent: 0, message: 'Resolving video formats…' });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(youtubedl.constants.YOUTUBE_DL_PATH, [...args, '--', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    const handleLine = (line: string) => {
      const progress = parseProgressLine(line);
      if (progress) {
        touch(job, {
          phase: 'downloading',
          percent: progress.percent,
          bytes: progress.bytes,
          message: 'Downloading…',
        });
        return;
      }

      if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
        touch(job, { phase: 'processing', percent: 99, message: 'Converting media…' });
        return;
      }

      if (line.includes('[download] Destination:')) {
        touch(job, { phase: 'downloading', percent: 1, message: 'Downloading…' });
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
      const tail = stdoutBuffer.trim();
      if (tail) handleLine(tail);

      if (code === 0) {
        resolve();
        return;
      }

      const message = extractError(stderrBuffer) || `yt-dlp exited with code ${code}`;
      reject(new Error(message));
    });
  });
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

  const warning = [...lines].reverse().find((line) => /unable|failed|not available|forbidden/i.test(line));
  return warning || '';
}

/** Find the file yt-dlp produced for a given stem. */
async function findOutput(dir: string, stem: string): Promise<string | null> {
  const files = await fs.readdir(dir);
  const match = files.find((file) => file.startsWith(`${stem}.`) && !file.includes('.f'));
  return match ? path.join(dir, match) : null;
}

async function runSingle(job: Job, input: StartJobInput, dir: string): Promise<void> {
  const url =
    input.url || `https://www.youtube.com/watch?v=${encodeURIComponent(input.videoId || '')}`;

  const stem = sanitizeStem(input.title, input.videoId || 'youtube-download');
  const outputTemplate = path.join(dir, `${stem}.%(ext)s`);

  await runYtDlp(job, url, outputTemplate, input.format);

  const filePath = await findOutput(dir, stem);
  if (!filePath) throw new Error('The download finished but no file was created.');

  const stat = await fs.stat(filePath);

  touch(job, {
    phase: 'ready',
    percent: 100,
    message: 'Ready to download',
    fileName: path.basename(filePath),
    filePath,
    bytes: stat.size,
  });
}

async function runBatch(job: Job, input: StartJobInput, dir: string): Promise<void> {
  const AdmZip = require('adm-zip');
  const items = input.playlistItems ?? [];

  if (!items.length) throw new Error('That playlist has no videos to download.');

  const zipName = `${sanitizeStem(input.title, 'youtube-playlist')}-${input.format}.zip`;
  const archivePath = path.join(dir, zipName);
  const produced: string[] = [];

  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      touch(job, {
        phase: 'downloading',
        percent: Math.round((index / items.length) * 100),
        message: `Downloading ${index + 1} of ${items.length}: ${item.title}`,
      });

      const stem = sanitizeStem(item.title, item.id);
      const outputTemplate = path.join(dir, `${stem}.%(ext)s`);

      await runYtDlp(job, `https://www.youtube.com/watch?v=${item.id}`, outputTemplate, input.format);

      const filePath = await findOutput(dir, stem);
      if (filePath) produced.push(filePath);
    }

    if (!produced.length) throw new Error('No media files were produced for this playlist.');

    touch(job, { phase: 'processing', percent: 99, message: 'Building ZIP archive…' });

    const zip = new AdmZip();
    for (const filePath of produced) {
      zip.addLocalFile(filePath, '', path.basename(filePath));
    }
    zip.writeZip(archivePath);

    const stat = await fs.stat(archivePath);

    touch(job, {
      phase: 'ready',
      percent: 100,
      message: 'Ready to download',
      fileName: zipName,
      filePath: archivePath,
      bytes: stat.size,
    });
  } finally {
    await Promise.allSettled(produced.map((file) => fs.unlink(file).catch(() => undefined)));
  }
}

function sweep(): void {
  const now = Date.now();

  for (const [id, job] of JOBS.entries()) {
    if (job.phase === 'ready' && now - job.updatedAt > FILE_TTL_MS) {
      job.cleanup();
      JOBS.delete(id);
      continue;
    }

    if (now - job.updatedAt > JOB_TTL_MS) {
      JOBS.delete(id);
    }
  }
}

export function startDownloadJob(input: StartJobInput): JobStatus {
  sweep();

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();

  const job: Job = {
    id,
    phase: 'queued',
    percent: 0,
    message: 'Queued…',
    createdAt: now,
    updatedAt: now,
    cleanup: async () => undefined,
  };

  JOBS.set(id, job);

  const run = async () => {
    try {
      const dir = await ensureTempDir();
      const isBatch = Boolean(input.playlistId && input.playlistItems?.length);

      if (isBatch) {
        await runBatch(job, input, dir);
      } else {
        await runSingle(job, input, dir);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Download failed';
      touch(job, { phase: 'error', percent: 0, message: 'Download failed', error: message });
    } finally {
      releaseSlot();
    }
  };

  acquireSlot().then(() => {
    void run();
  });

  return {
    id: job.id,
    phase: job.phase,
    percent: job.percent,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function getDownloadJob(id: string): JobStatus | null {
  sweep();

  const job = JOBS.get(id);
  if (!job) return null;

  return {
    id: job.id,
    phase: job.phase,
    percent: job.percent,
    message: job.message,
    fileName: job.fileName,
    filePath: job.filePath,
    bytes: job.bytes,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function getJobFilePath(id: string): string | null {
  const job = JOBS.get(id);
  if (!job || job.phase !== 'ready' || !job.filePath) return null;
  return job.filePath;
}

export function markJobConsumed(id: string): void {
  const job = JOBS.get(id);
  if (job) {
    job.cleanup();
    JOBS.delete(id);
  }
}

/** Stream a finished job's file to the browser as an attachment. */
export async function streamJobFile(
  id: string,
  res: {
    setHeader: (name: string, value: string) => void;
    end: (chunk?: unknown) => void;
    status: (code: number) => { json: (body: unknown) => void };
  }
): Promise<boolean> {
  const filePath = getJobFilePath(id);
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
          : ext === '.zip'
            ? 'application/zip'
            : 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String((await fs.stat(filePath)).size));
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

  markJobConsumed(id);
  return true;
}
