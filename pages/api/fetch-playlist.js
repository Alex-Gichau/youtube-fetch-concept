const API_KEY = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

function parsePlaylistId(input) {
  if (!input) return null;
  try {
    // If it's already an ID (no scheme), return directly
    if (!input.includes('http')) return input;
    const u = new URL(input);
    // /playlist?list=ID
    if (u.searchParams.get('list')) return u.searchParams.get('list');
    // watch?v=...&list=ID
    if (u.searchParams.get('list')) return u.searchParams.get('list');
    // fallback: try to extract "list=" in hash or pathname
    const all = u.href;
    const m = all.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    return null;
  } catch (e) {
    return null;
  }
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
  if (!videoIds || videoIds.length === 0) return [];
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

async function fetchPlaylistInfo(playlistId) {
  const url = new URL(`${YT_BASE}/playlists`);
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('id', playlistId);
  url.searchParams.set('key', API_KEY);
  const r = await fetch(url.toString());
  const j = await r.json();
  return (j.items && j.items[0]) || null;
}

export default async function handler(req, res) {
  try {
    const { playlistUrl } = req.query;
    if (!API_KEY) return res.status(500).json({ error: 'Missing YOUTUBE_API_KEY' });
    if (!playlistUrl) return res.status(400).json({ error: 'playlistUrl required' });

    const playlistId = parsePlaylistId(playlistUrl);
    if (!playlistId) return res.status(400).json({ error: 'Invalid playlist URL or ID' });

    const playlistInfo = await fetchPlaylistInfo(playlistId);
    const items = await fetchAllPlaylistItems(playlistId);
    const videoIds = items.map(i => i.contentDetails.videoId).filter(Boolean);
    const videos = await fetchVideoDetails(videoIds);

    res.status(200).json({ playlist: playlistInfo, items, videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
