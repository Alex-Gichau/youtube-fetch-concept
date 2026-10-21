// pages/api/download/start.ts
//
// Starts a background download job and returns its id immediately, so the UI
// never has to wait on a long-running request.
import type { NextApiRequest, NextApiResponse } from 'next';

import { startDownloadJob, type DownloadFormat } from '../../../lib/download-jobs';
import { fetchPlaylist } from '../../../lib/youtube';

type ResponseData =
  | { error: string }
  | { jobId: string; status: string };

function getText(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const format: DownloadFormat = body.format === 'audio' ? 'audio' : 'video';
  const title = getText(body.title as string) ?? 'youtube-download';
  const videoId = getText(body.videoId as string);
  const url = getText(body.url as string);
  const playlistId = getText(body.playlistId as string);

  try {
    if (playlistId) {
      // Batch mode: resolve the playlist, then download every item into a ZIP.
      const playlist = await fetchPlaylist(playlistId, { limit: 5000 });
      const items = (playlist.videos ?? []).map((video) => ({
        id: video.id,
        title: video.title,
      }));

      if (!items.length) throw new Error('That playlist has no videos to download.');

      const job = startDownloadJob({
        playlistId,
        playlistItems: items,
        title: playlist.title || title,
        format,
      });

      return res.status(202).json({ jobId: job.id, status: job.phase });
    }

    if (!videoId && !url) {
      return res.status(400).json({ error: 'Video ID or URL is required' });
    }

    const job = startDownloadJob({ videoId, url, title, format });

    return res.status(202).json({ jobId: job.id, status: job.phase });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start the download';
    return res.status(500).json({ error: message });
  }
}
