import fetch from 'node-fetch';

const API_KEY = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

async function fetchAllPlaylistsFromChannel(channelId) {
  let playlists = [];
  let nextPageToken = '';
  do {
    const url = new URL(`${YT_BASE}/playlists`);
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('channelId', channelId);
    url.searchParams.set('maxResults', '50');
    if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
    url.searchParams.set('key', API_KEY);
    const r = await fetch(url.toString());
    const j = await r.json();
    playlists = playlists.concat(j.items || []);
    nextPageToken = j.nextPageToken || '';
  } while (nextPageToken);
  return playlists;
}

async function fetchAllPlaylistItems(playlistId) {
  let items = [];
  let nextPageToken = '';
  do {
    const url = new URL(`${YT_BASE}/playlistItems`);
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('maxResults', '50');
    if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
    url.searchParams.set('key', API_KEY);
    const r = await fetch(url.toString());
    const j = await r.json();
    items = items.concat(j.items || []);
    nextPageToken = j.nextPageToken || '';
  } while (nextPageToken);
  return items;
}

async function fetchVideoDetails(videoIds) {
  const chunks = [];
  for (let i = 0; i < videoIds.length; i += 50) chunks.push(videoIds.slice(i, i + 50));
  const results = [];
  for (const chunk of chunks) {
    const url = new URL(`${YT_BASE}/videos`);
    url.searchParams.set('part', 'snippet,contentDetails,statistics');
    url.searchParams.set('id', chunk.join(','));
    url.searchParams.set('key', API_KEY);
    const r = await fetch(url.toString());
    const j = await r.json();
    results.push(...(j.items || []));
  }
  return results;
}

export default async function handler(req, res) {
  try {
    const { channelId } = req.query;
    if (!API_KEY) return res.status(500).json({ error: 'Missing YOUTUBE_API_KEY' });
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const playlists = await fetchAllPlaylistsFromChannel(channelId);
    const enriched = [];
    for (const p of playlists) {
      const items = await fetchAllPlaylistItems(p.id);
      const videoIds = items.map(i => i.contentDetails.videoId).filter(Boolean);
      const videos = await fetchVideoDetails(videoIds);
      enriched.push({ playlist: p, items, videos });
    }
    res.status(200).json({ playlists: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
