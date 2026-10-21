// lib/youtube.ts
// Key-free YouTube playlist extraction.
//
// YouTube's public playlist page embeds a `ytInitialData` JSON blob containing the
// first page of items, plus a continuation token used to page through the rest.
// This module walks that structure so we can return the *full* playlist without
// requiring a YouTube Data API key.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BASE_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+1',
};

export interface PlaylistVideo {
  id: string;
  title: string;
  channel: string;
  channelAvatar?: string;
  duration?: string;
  views?: string;
  publishedAt?: string;
  thumbnail: string;
  url: string;
}

export interface PlaylistResult {
  playlistId: string;
  title: string;
  channel?: string;
  videoCount: number;
  /** The playlist's own count label, e.g. "19 videos" (when YouTube provides it). */
  videoCountLabel?: string;
  /** True for YouTube's auto-generated "mix" (RD…) playlists. */
  isMix?: boolean;
  /** True when the result list came from a keyword search rather than a playlist ID. */
  isSearch?: boolean;
  videos: PlaylistVideo[];
}

/**
 * A "mix" (radio) playlist. YouTube renders these on the watch page rather than
 * the playlist page, and the playlist page itself returns
 * "This playlist type is unviewable."
 */
const MIX_ID_PREFIX = 'RD';
const MIX_ID_PATTERN = /^RD([A-Za-z0-9_-]{11})$/;

export function isMixPlaylistId(playlistId: string): boolean {
  return MIX_ID_PATTERN.test(playlistId);
}

/** The video ID an RD mix is anchored to (e.g. RDdUVs5Ocou8I -> dUVs5Ocou8I). */
function mixAnchorVideoId(playlistId: string): string | null {
  const match = MIX_ID_PATTERN.exec(playlistId);
  return match ? match[1] : null;
}

/** Extract a playlist ID from any of the URL shapes YouTube hands out. */
export function extractPlaylistId(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  // A bare playlist ID (e.g. "PLxxxx") pasted straight into the box.
  if (/^[A-Za-z0-9_-]{13,}$/.test(raw) && !raw.includes('/') && !raw.includes('.')) {
    return raw;
  }

  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const fromQuery = url.searchParams.get('list');
    if (fromQuery) return fromQuery;
  } catch {
    // fall through to the regex below
  }

  const match = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/** Extract the `v=` video ID from a watch URL, if there is one. */
export function extractVideoId(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const fromQuery = url.searchParams.get('v');
    if (fromQuery) return fromQuery;
  } catch {
    // fall through to the regex below
  }

  const match = raw.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Grab a balanced JSON object that starts at the first `{` following `marker`.
 * Naive regexes break on nested braces, so we track depth and string state.
 */
function extractJsonAfter(source: string, marker: string): any | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return null;

  const start = source.indexOf('{', markerIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/** Read a text node that may be `{ content }` or the legacy `{ simpleText }` shape. */
function readText(node: any): string | undefined {
  if (!node) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node.content === 'string') return node.content;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) {
    const joined = node.runs.map((run: any) => run?.text ?? '').join('');
    return joined || undefined;
  }
  return undefined;
}

/** Depth-first walk over every node in a JSON tree. */
function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const key of Object.keys(node)) walk(node[key], visit);
}

interface ParsedItem {
  id: string;
  title: string;
  channel: string;
  channelAvatar?: string;
  duration?: string;
  views?: string;
  publishedAt?: string;
  thumbnail: string;
  /** `LOCKUP_CONTENT_TYPE_*` — lets callers skip playlists/channels in a mix. */
  contentType?: string;
}

/** Pull the playlist items out of a `ytInitialData`-shaped tree. */
function extractItems(data: any): ParsedItem[] {
  const items: ParsedItem[] = [];

  walk(data, (node) => {
    // Modern renderer (current YouTube web).
    const lockup = node.lockupViewModel;
    if (lockup?.contentId && lockup?.contentType !== 'LOCKUP_CONTENT_TYPE_CHANNEL') {
      const meta = lockup.metadata?.lockupMetadataViewModel;
      const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows ?? [];

      const channel = readText(rows[0]?.metadataParts?.[0]?.text);
      const views = readText(rows[1]?.metadataParts?.[0]?.text);
      const publishedAt = readText(rows[1]?.metadataParts?.[1]?.text);

      const overlays = lockup.contentImage?.thumbnailViewModel?.overlays ?? [];
      const badges = overlays[0]?.thumbnailBottomOverlayViewModel?.badges ?? [];
      const duration = badges[0]?.thumbnailBadgeViewModel?.text;

      const avatar = meta?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.[0]?.url;

      const sources = lockup.contentImage?.thumbnailViewModel?.image?.sources ?? [];
      const thumbnail = sources.length ? sources[sources.length - 1].url : '';

      items.push({
        id: lockup.contentId,
        title: readText(meta?.title) ?? 'Untitled video',
        channel: channel ?? 'Unknown channel',
        channelAvatar: avatar,
        duration,
        views,
        publishedAt,
        thumbnail,
        contentType: lockup.contentType,
      });
      return;
    }

    // Legacy renderer (older YouTube web markup) — kept as a fallback.
    const legacy = node.playlistVideoRenderer;
    if (legacy?.videoId) {
      const thumbnails = legacy.thumbnail?.thumbnails ?? [];
      items.push({
        id: legacy.videoId,
        title: readText(legacy.title) ?? 'Untitled video',
        channel: readText(legacy.shortBylineText) ?? 'Unknown channel',
        duration: readText(legacy.lengthText),
        publishedAt: readText(legacy.publishedTimeText),
        views: readText(legacy.viewCountText),
        thumbnail: thumbnails.length ? thumbnails[thumbnails.length - 1].url : '',
        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      });
    }
  });

  return items;
}

/** Collect every continuation token present in a tree. */
function extractTokens(data: any): string[] {
  const tokens: string[] = [];
  walk(data, (node) => {
    for (const key of Object.keys(node)) {
      if (key === 'token' && typeof node[key] === 'string') tokens.push(node[key]);
    }
  });
  return tokens;
}

/**
 * True when YouTube answered with an alert instead of playlist content —
 * e.g. "This playlist type is unviewable." for RD (mix) playlists.
 */
function isUnviewablePlaylist(data: any): boolean {
  const alerts = data?.alerts;
  if (!Array.isArray(alerts)) return false;

  return alerts.some((alert: any) => {
    const text = readText(alert?.alertRenderer?.text);
    return typeof text === 'string' && /unviewable|not available|private/i.test(text);
  });
}

/** Read the playlist title / channel out of the page header. */
function extractHeader(data: any): {
  title?: string;
  channel?: string;
  videoCountLabel?: string;
} {
  let title: string | undefined;
  let channel: string | undefined;
  let videoCountLabel: string | undefined;

  walk(data, (node) => {
    if (!title) {
      const header =
        node.pageHeaderViewModel ??
        (node.pageHeaderRenderer ? { title: node.pageHeaderRenderer.pageTitle } : undefined);
      const raw = readText(header?.title);
      if (raw) title = raw;
    }
  });

  // The owner sits in the header's avatar stack ("by SomeChannel"); the other
  // metadata parts are things like "Playlist" and "19 videos", which we skip.
  walk(data, (node) => {
    const header =
      node.pageHeaderViewModel ??
      (node.pageHeaderRenderer ? { content: node.pageHeaderRenderer } : undefined);
    const rows = header?.metadata?.contentMetadataViewModel?.metadataRows ?? [];

    for (const row of rows) {
      for (const part of row.metadataParts ?? []) {
        const stackText = readText(part.avatarStack?.avatarStackViewModel?.text);
        if (stackText) {
          channel = stackText.replace(/^by\s+/i, '').trim();
          continue;
        }

        const text = readText(part.text);
        if (!text) continue;
        if (/^\d[\d,]*\s+videos?$/i.test(text)) videoCountLabel = text;
      }
    }
  });

  return { title, channel, videoCountLabel };
}

export interface FetchOptions {
  /** Maximum number of items to return. */
  limit?: number;
  /** Maximum number of continuation requests to perform. */
  maxPages?: number;
  signal?: AbortSignal;
}

/**
 * Fetch a YouTube "mix" (auto-generated radio playlist, e.g. RDdUVs5Ocou8I).
 *
 * The playlist page for a mix returns "This playlist type is unviewable.", so we
 * read the mix from the watch page instead: its "up next" rail is the mix list.
 */
async function fetchMixPlaylist(
  playlistId: string,
  options: FetchOptions = {}
): Promise<PlaylistResult> {
  const { limit = 500, signal } = options;

  const anchorId = mixAnchorVideoId(playlistId);
  if (!anchorId) {
    throw new Error('That does not look like a valid mix playlist ID');
  }

  // `playnext=1` makes YouTube render the mix rail on the playlist page, which
  // carries more entries than the watch page's sidebar.
  const pageUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(
    playlistId
  )}&playnext=1&hl=en`;

  const res = await fetch(pageUrl, { headers: BASE_HEADERS, signal });
  if (!res.ok) {
    throw new Error(`YouTube returned ${res.status} for that mix`);
  }

  const html = await res.text();
  const data = extractJsonAfter(html, 'ytInitialData');

  if (!data) {
    throw new Error('Could not read mix data from YouTube (the page structure may have changed)');
  }

  const rawItems = extractItems(data);

  // A mix can include nested playlists and the mix itself — keep only videos,
  // and drop the mix's own entry.
  const seen = new Set<string>();
  const items = rawItems.filter((item) => {
    if (item.contentType && item.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return false;
    if (item.id === playlistId || item.id === anchorId) return false;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  const videos: PlaylistVideo[] = items.slice(0, limit).map((item) => ({
    id: item.id,
    title: item.title,
    channel: item.channel,
    channelAvatar: item.channelAvatar,
    duration: item.duration,
    views: item.views,
    publishedAt: item.publishedAt,
    thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${item.id}`,
  }));

  const title = videos[0]
    ? `Mix · ${videos[0].channel}`
    : 'YouTube Mix';

  return {
    playlistId,
    title,
    channel: videos[0]?.channel,
    videoCount: videos.length,
    videoCountLabel: `${videos.length} videos`,
    isMix: true,
    videos,
  };
}

/**
 * Fetch every item of a YouTube playlist.
 * Uses the public playlist page + continuation endpoint, so no API key is needed.
 */
export async function fetchSearchResults(
  query: string,
  options: FetchOptions = {}
): Promise<PlaylistResult> {
  const { limit = 20, signal } = options;
  const rawQuery = (query || '').trim();

  if (!rawQuery) {
    throw new Error('Search query is required');
  }

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(rawQuery)}&hl=en`;
  const pageRes = await fetch(searchUrl, { headers: BASE_HEADERS, signal });

  if (!pageRes.ok) {
    throw new Error(`YouTube returned ${pageRes.status} for that search`);
  }

  const html = await pageRes.text();
  const initialData = extractJsonAfter(html, 'ytInitialData');

  if (!initialData) {
    throw new Error('Could not read search results from YouTube (the page structure may have changed)');
  }

  const items = extractItems(initialData).filter((item) => {
    if (item.contentType && item.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return false;
    return Boolean(item.id && item.title);
  });

  const seen = new Set<string>();
  const videos: PlaylistVideo[] = [];

  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    videos.push({
      id: item.id,
      title: item.title,
      channel: item.channel,
      channelAvatar: item.channelAvatar,
      duration: item.duration,
      views: item.views,
      publishedAt: item.publishedAt,
      thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${item.id}`,
    });

    if (videos.length >= limit) break;
  }

  return {
    playlistId: `search:${encodeURIComponent(rawQuery)}`,
    title: `Search: ${rawQuery}`,
    videoCount: videos.length,
    videoCountLabel: `${videos.length} videos`,
    isSearch: true,
    videos,
  };
}

export async function fetchPlaylist(
  playlistId: string,
  options: FetchOptions = {}
): Promise<PlaylistResult> {
  const { limit = 5000, maxPages = 30, signal } = options;

  if (isMixPlaylistId(playlistId)) {
    return fetchMixPlaylist(playlistId, options);
  }

  const pageUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}&hl=en`;
  const pageRes = await fetch(pageUrl, { headers: BASE_HEADERS, signal });

  if (!pageRes.ok) {
    if (pageRes.status === 404) {
      throw new Error(
        'Playlist not found. It may be private, deleted, or the link may be wrong.'
      );
    }
    throw new Error(`YouTube returned ${pageRes.status} for that playlist`);
  }

  const html = await pageRes.text();
  const initialData = extractJsonAfter(html, 'ytInitialData');

  if (!initialData) {
    throw new Error('Could not read playlist data from YouTube (the page structure may have changed)');
  }

  // YouTube answers a mix ID with "This playlist type is unviewable." — catch
  // that here so we can fall back to the mix reader.
  if (isUnviewablePlaylist(initialData)) {
    return fetchMixPlaylist(playlistId, options);
  }

  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
  const clientVersion = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];
  const visitorData = (html.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1];

  const header = extractHeader(initialData);
  const items = extractItems(initialData);

  // Page through the remaining items.
  const seen = new Set(items.map((item) => item.id));
  const tokens = extractTokens(initialData);

  if (apiKey && tokens.length > 0) {
    let token = tokens[0];
    let page = 0;

    while (token && page < maxPages && items.length < limit) {
      page++;

      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/browse?prettyPrint=false&key=${apiKey}`,
        {
          method: 'POST',
          headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: clientVersion || '2.20240304.00.00',
                hl: 'en',
                gl: 'US',
                visitorData,
              },
            },
            continuation: token,
          }),
        }
      );

      if (!res.ok) break;

      const json = await res.json();
      const pageItems = extractItems(json);

      for (const item of pageItems) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }

      const nextTokens = extractTokens(json);
      token = nextTokens.length ? nextTokens[0] : undefined;
    }
  }

  const videos: PlaylistVideo[] = items.slice(0, limit).map((item) => ({
    id: item.id,
    title: item.title,
    channel: item.channel,
    channelAvatar: item.channelAvatar,
    duration: item.duration,
    views: item.views,
    publishedAt: item.publishedAt,
    thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${item.id}`,
  }));

  return {
    playlistId,
    title: header.title ?? 'YouTube Playlist',
    channel: header.channel,
    videoCount: videos.length,
    videoCountLabel: header.videoCountLabel,
    videos,
  };
}
