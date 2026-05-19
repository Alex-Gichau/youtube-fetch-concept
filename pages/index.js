import React, { useState } from 'react';

export default function Home() {
  const [channelId, setChannelId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function fetchData() {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/fetch-playlists?channelId=${encodeURIComponent(channelId)}`);
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
        <input value={channelId} onChange={e => setChannelId(e.target.value)} placeholder="Channel ID" />
        <button onClick={fetchData} disabled={loading}>Fetch</button>
      </div>
      {loading && <p>Loading...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {data && (
        <div>
          <h2>Playlists ({data.playlists.length})</h2>
          {data.playlists.map((p, idx) => (
            <div key={idx} style={{ border: '1px solid #ccc', padding: 8, marginTop: 8 }}>
              <h3>{p.playlist.snippet.title}</h3>
              <p>{p.playlist.snippet.description}</p>
              <p>Videos: {p.items.length}</p>
              <ul>
                {p.videos.map(v => (
                  <li key={v.id}>{v.snippet.title} — {v.statistics.viewCount} views</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
