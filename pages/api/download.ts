import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';

import { fetchPlaylist } from '../../lib/youtube';
import { sanitizeFileName } from '../../lib/download-utils.js';

const youtubedl = require('youtube-dl-exec');

function sendFileResponse(res: NextApiResponse, filePath: string, fileName: string) {
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
            : ext === '.wav'
              ? 'audio/wav'
              : ext === '.opus'
                ? 'audio/opus'
                : ext === '.zip'
                  ? 'application/zip'
                  : 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName.replace(/"/g, '\\"')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  );

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.writableEnded) {
      res.status(500).json({ error: 'Failed to stream the requested file.' });
    }
  });

  stream.on('close', () => {
    fs.unlink(filePath).catch(() => undefined);
  });

  stream.pipe(res);
}

const SUPPORTED_FORMATS = new Set(['audio', 'video']);
const ALLOWED_EXTENSIONS = new Set(['mp3', 'mp4', 'm4a', 'webm', 'm4v', 'wav', 'opus']);

function getTextQuery(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value.trim();
  return undefined;
}

async function ensureTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'youtube-fetch-concept');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function findDownloadedFile(dir: string, prefix: string): Promise<string | null> {
  const files = await fs.readdir(dir);
  const match = files.find((file) => {
    const ext = path.extname(file).slice(1).toLowerCase();
    return file.startsWith(`${prefix}.`) && ALLOWED_EXTENSIONS.has(ext);
  });

  return match ? path.join(dir, match) : null;
}

async function downloadSingleVideo(url: string, title: string, format: 'audio' | 'video') {
  const dir = await ensureTempDir();
  const stem = sanitizeFileName(title || 'youtube-download') || 'youtube-download';
  const output = path.join(dir, `${stem}.%(ext)s`);

  await youtubedl(url, {
    noWarnings: true,
    noCheckCertificates: true,
    noColor: true,
    noPlaylist: true,
    output,
    format: format === 'audio' ? 'bestaudio/best' : 'bestvideo+bestaudio/best',
    ...(format === 'audio'
      ? {
          extractAudio: true,
          audioFormat: 'mp3',
          audioQuality: '0',
        }
      : {
          mergeOutputFormat: 'mp4',
        }),
  });

  const filePath = await findDownloadedFile(dir, stem);
  if (!filePath) {
    throw new Error('The media download finished but no file was created.');
  }

  return { filePath, fileName: path.basename(filePath) };
}

async function downloadPlaylistBatch(playlistId: string, title: string, format: 'audio' | 'video') {
  const playlist = await fetchPlaylist(playlistId, { limit: 5000 });
  const videos = playlist.videos ?? [];

  if (!videos.length) {
    throw new Error('That playlist has no videos available to download.');
  }

  const dir = await ensureTempDir();
  const zipName = `${sanitizeFileName(title || 'youtube-download') || 'youtube-download'}-${format}.zip`;
  const archivePath = path.join(dir, zipName);
  const downloaded: string[] = [];

  try {
    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index];
      const fileStem = sanitizeFileName(`${video.title || `video-${index + 1}`}`) || `video-${index + 1}`;
      const output = path.join(dir, `${fileStem}.%(ext)s`);

      await youtubedl(`https://www.youtube.com/watch?v=${video.id}`, {
        noWarnings: true,
        noCheckCertificates: true,
        noColor: true,
        noPlaylist: true,
        output,
        format: format === 'audio' ? 'bestaudio/best' : 'bestvideo+bestaudio/best',
        ...(format === 'audio'
          ? {
              extractAudio: true,
              audioFormat: 'mp3',
              audioQuality: '0',
            }
          : {
              mergeOutputFormat: 'mp4',
            }),
      });

      const created = await findDownloadedFile(dir, fileStem);
      if (created) downloaded.push(created);
    }

    if (!downloaded.length) {
      throw new Error('No downloadable media files were produced for this playlist.');
    }

    const zip = new AdmZip();
    for (const filePath of downloaded) {
      zip.addLocalFile(filePath, '', path.basename(filePath));
    }

    zip.writeZip(archivePath);

    return { filePath: archivePath, fileName: zipName };
  } finally {
    await Promise.allSettled(
      downloaded.map((filePath) => fs.unlink(filePath).catch(() => undefined))
    );
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const mode = getTextQuery(req.query.mode) ?? 'single';
  const format = getTextQuery(req.query.format) === 'audio' ? 'audio' : 'video';
  const title = getTextQuery(req.query.title) ?? 'youtube-download';

  if (!SUPPORTED_FORMATS.has(format)) {
    return res.status(400).json({ error: 'Unsupported format' });
  }

  try {
    if (mode === 'batch') {
      const playlistId = getTextQuery(req.query.playlistId);
      if (!playlistId) {
        return res.status(400).json({ error: 'Playlist ID is required for batch downloads' });
      }

      const { filePath, fileName } = await downloadPlaylistBatch(playlistId, title, format);
      return sendFileResponse(res, filePath, fileName);
    }

    const videoId = getTextQuery(req.query.videoId);
    const videoUrl = getTextQuery(req.query.url);
    const url = videoUrl || (videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : undefined);

    if (!url) {
      return res.status(400).json({ error: 'Video URL or video ID is required' });
    }

    const { filePath, fileName } = await downloadSingleVideo(url, title, format);
    return sendFileResponse(res, filePath, fileName);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to download media';
    return res.status(500).json({ error: message });
  }
}
