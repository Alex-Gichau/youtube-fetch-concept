import { useState } from 'react';
import Head from 'next/head';
import { isSearchInput, normalizeSearchQuery } from '../lib/search-utils.js';

export default function Home() {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('search');
  const [playlist, setPlaylist] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const triggerDownload = (params) => {
    const query = new URLSearchParams(params).toString();
    window.location.href = `/api/download?${query}`;
  };

  const handleBulkDownload = (format) => {
    if (!playlist?.playlistId) return;
    triggerDownload({
      playlistId: playlist.playlistId,
      title: playlist.title,
      format,
      mode: 'batch',
    });
  };

  const handleSingleDownload = (video, format) => {
    triggerDownload({
      videoId: video.id,
      title: video.title,
      format,
      mode: 'single',
    });
  };

  const handleFetch = async (e) => {
    e.preventDefault();
    const trimmed = normalizeSearchQuery(url);

    if (!trimmed) {
      setError(mode === 'search' ? 'Please enter a YouTube video or artist name' : 'Please enter a YouTube playlist URL');
      return;
    }

    setLoading(true);
    setError('');
    setPlaylist(null);

    try {
      const endpoint = mode === 'search' || isSearchInput(trimmed) ? '/api/search' : '/api/playlist';
      const queryKey = endpoint === '/api/search' ? 'query' : 'url';
      const response = await fetch(`${endpoint}?${queryKey}=${encodeURIComponent(trimmed)}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch the playlist');
      }

      setPlaylist(data);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const videos = playlist?.videos ?? [];

  return (
    <>
      <Head>
        <title>YouTube Playlist Fetcher</title>
        <meta
          name="description"
          content="Paste a YouTube playlist link and get every video as a song row."
        />
      </Head>

      <main className="container">
        <header className="masthead">
          <h1>YouTube Playlist Fetcher</h1>
          <p>Paste a playlist link and every item shows up as a song row.</p>
        </header>

        <form className="search-form" onSubmit={handleFetch}>
          <div className="mode-toggle" role="tablist" aria-label="Fetch mode">
            <button
              type="button"
              className={mode === 'playlist' ? 'active' : ''}
              onClick={() => setMode('playlist')}
            >
              Playlist URL
            </button>
            <button
              type="button"
              className={mode === 'search' ? 'active' : ''}
              onClick={() => setMode('search')}
            >
              Search by name
            </button>
          </div>

          <div className="search-controls">
            <input
              type="text"
              placeholder={
                mode === 'search'
                  ? 'Search YouTube by song, artist, or video title'
                  : 'https://www.youtube.com/playlist?list=PL...'
              }
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label={mode === 'search' ? 'YouTube search query' : 'YouTube playlist URL'}
            />
            <button type="submit" disabled={loading}>
              {loading ? 'Fetching…' : 'Fetch'}
            </button>
          </div>
        </form>

        {error && (
          <div className="status status-error" role="alert">
            {error}
          </div>
        )}

        {loading && <div className="status status-loading">Loading playlist items…</div>}

        {playlist && !loading && (
          <div className="summary">
            <h2>{playlist.title}</h2>
            <span>
              {playlist.videoCountLabel ||
                `${playlist.videoCount} ${playlist.videoCount === 1 ? 'video' : 'videos'}`}
              {playlist.channel ? ` · ${playlist.channel}` : ''}
            </span>

            {!playlist.isSearch && (
              <div className="bulk-actions">
                <button type="button" onClick={() => handleBulkDownload('audio')}>
                  Download all audio
                </button>
                <button type="button" onClick={() => handleBulkDownload('video')}>
                  Download all video
                </button>
              </div>
            )}
          </div>
        )}

        {videos.length > 0 && (
          <div className="song-list" role="list">
            {videos.map((video) => (
              <article className="song-row" key={video.id} role="listitem">
                <a
                  className="song-thumb"
                  href={video.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${video.title}`}
                >
                  <img src={video.thumbnail} alt={video.title} loading="lazy" />
                  {video.duration && <span className="song-duration">{video.duration}</span>}
                </a>

                <div className="song-main">
                  <a
                    className="song-title"
                    href={video.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {video.title}
                  </a>

                  <div className="song-meta-row">
                    {video.channelAvatar && <img className="song-avatar" src={video.channelAvatar} alt="" />}
                    <span>{video.channel}</span>
                  </div>

                  <div className="song-meta">
                    {video.views && <span>{video.views} views</span>}
                    {video.publishedAt && <span>{video.publishedAt}</span>}
                  </div>
                </div>

                <div className="song-actions">
                  <button type="button" onClick={() => handleSingleDownload(video, 'audio')}>
                    Download audio
                  </button>
                  <button type="button" onClick={() => handleSingleDownload(video, 'video')}>
                    Download video
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        {playlist && !loading && videos.length === 0 && (
          <div className="empty">
            That playlist returned no videos. It may be empty, private, or unavailable.
          </div>
        )}
      </main>
    </>
  );
}
