// app/page.tsx
'use client';

import { useState, FormEvent } from 'react';

interface Video {
  id: string;
  title: string;
  channel: string;
  publishedAt: string;
  thumbnail: string;
}

export default function PlaylistFetcher() {
  const [url, setUrl] = useState('');
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);
    setError(null);
    setVideos([]);

    try {
      const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch videos');
      }

      setVideos(data.videos);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-8">
      <header className="text-center space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">YouTube Playlist Fetcher</h1>
        <p className="text-slate-500">Paste a YouTube playlist URL to view all videos in a table</p>
      </header>

      {/* Search Bar Form */}
      <form onSubmit={handleSubmit} className="flex gap-2 max-w-2xl mx-auto">
        <input
          type="url"
          placeholder="https://www.youtube.com/playlist?list=PL..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Fetching...' : 'Fetch'}
        </button>
      </form>

      {/* Error Message */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg max-w-2xl mx-auto text-sm text-center">
          {error}
        </div>
      )}

      {/* Results Table */}
      {videos.length > 0 && (
        <div className="overflow-x-auto border rounded-lg shadow-sm">
          <table className="w-full text-left text-sm text-slate-700">
            <thead className="bg-slate-100 text-slate-900 border-b">
              <tr>
                <th className="p-4 w-12">#</th>
                <th className="p-4 w-32">Thumbnail</th>
                <th className="p-4">Title</th>
                <th className="p-4">Channel</th>
                <th className="p-4 w-32">Published</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {videos.map((video, index) => (
                <tr key={video.id} className="hover:bg-slate-50">
                  <td className="p-4 font-medium text-slate-400">{index + 1}</td>
                  <td className="p-4">
                    <img
                      src={video.thumbnail}
                      alt={video.title}
                      className="w-24 h-14 object-cover rounded"
                    />
                  </td>
                  <td className="p-4 font-medium text-slate-900">
                    <a
                      href={`https://www.youtube.com/watch?v=${video.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline text-blue-600 line-clamp-2"
                    >
                      {video.title}
                    </a>
                  </td>
                  <td className="p-4 text-slate-500">{video.channel}</td>
                  <td className="p-4 text-slate-500 whitespace-nowrap">{video.publishedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}