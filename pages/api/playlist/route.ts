// app/api/playlist/route.ts
import { NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';

function extractPlaylistId(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    return url.searchParams.get('list');
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  const playlistId = extractPlaylistId(targetUrl);
  if (!playlistId) {
    return NextResponse.json({ error: 'Invalid YouTube Playlist URL' }, { status: 400 });
  }

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;

  try {
    const res = await fetch(rssUrl, { next: { revalidate: 3600 } }); // Cache for 1 hour

    if (!res.ok) {
      return NextResponse.json({ error: 'Playlist feed not found or private' }, { status: res.status });
    }

    const xmlText = await res.text();

    // Configure fast-xml-parser to handle namespaces (yt:, media:)
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });

    const parsedData = parser.parse(xmlText);
    const entries = parsedData?.feed?.entry;

    if (!entries) {
      return NextResponse.json({ videos: [] });
    }

    // Ensure entries is always an array (fast-xml-parser turns single-item lists into objects)
    const entryList = Array.isArray(entries) ? entries : [entries];

    const videos = entryList.map((entry: any) => {
      const videoId = entry['yt:videoId'];
      return {
        id: videoId,
        title: entry.title,
        channel: entry.author?.name || 'Unknown Channel',
        publishedAt: new Date(entry.published).toLocaleDateString(),
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    });

    return NextResponse.json({ videos });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch RSS feed' }, { status: 500 });
  }
}