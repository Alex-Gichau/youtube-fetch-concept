import React, { useState } from 'react';

export default function Home() {
  const [input, setInput] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function fetchData() {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/fetch-playlist?playlistUrl=${encodeURIComponent(input)}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Unknown');
      setData(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: 24 }}>
      <h1>YouTube Playlist Fetch</h1>
      <div>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Playlist URL or ID" style={{ width: 400 }} />
        <button onClick={fetchData} disabled={loading}>Fetch</button>
      </div>
      {loading && <p>Loading...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {data && (
        <div>
          <h2>{data.playlist?.snippet?.title || 'Playlist'} — {data.items.length} videos</h2>
          <p>{data.playlist?.snippet?.description}</p>
          <ol>
            {data.items.map((it, idx) => {
              const v = data.videos.find(x => x.id === it.contentDetails.videoId);
              return (
                <li key={idx} style={{ marginBottom: 8 }}>
                  <strong>{v?.snippet?.title || it.snippet.title}</strong>
                  <div>Video ID: {it.contentDetails.videoId}</div>
                  <div>Published: {v?.snippet?.publishedAt || it.snippet.publishedAt}</div>
                  <div>Views: {v?.statistics?.viewCount || 'N/A'}</div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </main>
  );
}
