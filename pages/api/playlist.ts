// pages/api/playlist.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  extractPlaylistId,
  extractVideoId,
  fetchPlaylist,
  isMixPlaylistId,
  type PlaylistResult,
} from '../../lib/youtube';

type ResponseData = { error: string } | PlaylistResult;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const target = req.query.url;

  if (!target || typeof target !== 'string' || !target.trim()) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let playlistId = extractPlaylistId(target);

  if (!playlistId) {
    return res.status(400).json({ error: 'Invalid YouTube playlist URL' });
  }

  try {
    // "https://www.youtube.com/watch?v=abc&list=RDxyz" — the mix is anchored to
    // the video in `v`, not to the `list` ID, so rebuild the mix ID from it.
    if (isMixPlaylistId(playlistId)) {
      const videoId = extractVideoId(target);
      if (videoId && !playlistId.endsWith(videoId)) {
        playlistId = `RD${videoId}`;
      }
    }

    const playlist = await fetchPlaylist(playlistId, {
      limit: Number(req.query.limit) || 5000,
    });

    return res.status(200).json(playlist);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch playlist';
    return res.status(500).json({ error: message });
  }
}
