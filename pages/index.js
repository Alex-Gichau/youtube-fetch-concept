import { useState } from 'react';
import Head from 'next/head';
import { isSearchInput, normalizeSearchQuery } from '../lib/search-utils.js';
import {
  cancelDownload,
  formatBytes,
  isCancelledError,
  phaseLabel,
  runDownload,
} from '../lib/download-client.js';

export default function Home() {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('search');
  const [playlist, setPlaylist] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Per-download state keyed by `${videoId}:${format}`.
  const [downloads, setDownloads] = useState({});

  const updateDownload = (key, patch) => {
    setDownloads((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }));
  };

  const handleSingleDownload = async (video, format) => {
    const key = `${video.id}:${format}`;

    updateDownload(key, { phase: 'queued', percent: 0, message: 'Starting…', error: '' });

    try {
      await runDownload({
        payload: {
          videoId: video.id,
          title: video.title,
          format,
        },
        onUpdate: (status) => updateDownload(key, status),
        onJobId: (jobId) => updateDownload(key, { jobId }),
      });
    } catch (err) {
      if (isCancelledError(err)) {
        updateDownload(key, {
          phase: 'cancelled',
          error: '',
          message: 'Cancelled',
        });
        return;
      }

      updateDownload(key, {
        phase: 'error',
        error: err.message || 'The download failed',
        message: 'Failed',
      });
    }
  };

  const handleBulkDownload = async (format) => {
    if (!playlist?.playlistId) return;

    const key = `playlist:${format}`;

    updateDownload(key, { phase: 'queued', percent: 0, message: 'Starting…', error: '' });

    try {
      await runDownload({
        payload: {
          playlistId: playlist.playlistId,
          title: playlist.title,
          format,
        },
        onUpdate: (status) => updateDownload(key, status),
        onJobId: (jobId) => updateDownload(key, { jobId }),
      });
    } catch (err) {
      if (isCancelledError(err)) {
        updateDownload(key, {
          phase: 'cancelled',
          error: '',
          message: 'Cancelled',
        });
        return;
      }

      updateDownload(key, {
        phase: 'error',
        error: err.message || 'The download failed',
        message: 'Failed',
      });
    }
  };

  const handleCancel = async (key) => {
    const jobId = downloads[key]?.jobId;
    if (!jobId) return;

    updateDownload(key, { phase: 'cancelled', message: 'Cancelling…' });

    try {
      await cancelDownload(jobId);
    } catch (err) {
      // The job may have finished on its own while we were cancelling.
      updateDownload(key, {
        phase: 'error',
        error: err.message || 'Could not cancel the download',
        message: 'Failed',
      });
    }
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
                {['audio', 'video'].map((format) => {
                  const state = downloads[`playlist:${format}`];
                  const running =
                    state &&
                    state.phase !== 'ready' &&
                    state.phase !== 'error' &&
                    state.phase !== 'cancelled';
                  const failed = state?.phase === 'error';

                  return (
                    <button
                      type="button"
                      key={format}
                      onClick={() => handleBulkDownload(format)}
                      disabled={Boolean(running)}
                    >
                      {failed ? `Retry all ${format}` : `Download all ${format}`}
                    </button>
                  );
                })}
              </div>
            )}

            {!playlist.isSearch && (downloads['playlist:audio'] || downloads['playlist:video']) && (
              <div className="bulk-progress">
                {['audio', 'video'].map((format) => {
                  const state = downloads[`playlist:${format}`];
                  if (!state) return null;

                  const running =
                    state.phase !== 'ready' &&
                    state.phase !== 'error' &&
                    state.phase !== 'cancelled';

                  return (
                    <div
                      className={`progress-block${state.phase === 'error' ? ' is-error' : ''}`}
                      key={format}
                    >
                      <div className="progress-line">
                        <strong>{format === 'audio' ? 'All audio' : 'All video'}</strong>
                        <span>{phaseLabel(state.phase)}</span>
                        {running && <span>{state.percent}%</span>}
                        {running && (
                          <button
                            type="button"
                            className="cancel-button"
                            onClick={() => handleCancel(`playlist:${format}`)}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                      {state.error ? (
                        <p className="progress-error">{state.error}</p>
                      ) : (
                        <>
                          <div className="progress-track">
                            <div
                              className="progress-fill"
                              style={{ width: `${state.percent || 0}%` }}
                            />
                          </div>
                          <p className="progress-note">
                            {state.message}
                            {state.bytes ? ` · ${formatBytes(state.bytes)}` : ''}
                          </p>
                        </>
                      )}
                    </div>
                  );
                })}
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
                  {['audio', 'video'].map((format) => {
                    const state = downloads[`${video.id}:${format}`];
                    const running =
                      state &&
                      state.phase !== 'ready' &&
                      state.phase !== 'error' &&
                      state.phase !== 'cancelled';
                    const failed = state?.phase === 'error';

                    return (
                      <button
                        type="button"
                        key={format}
                        onClick={() => handleSingleDownload(video, format)}
                        disabled={Boolean(running)}
                      >
                        {failed
                          ? `Retry ${format}`
                          : `Download ${format}`}
                      </button>
                    );
                  })}

                  {['audio', 'video'].map((format) => {
                    const state = downloads[`${video.id}:${format}`];
                    if (!state) return null;

                    const running =
                      state.phase !== 'ready' &&
                      state.phase !== 'error' &&
                      state.phase !== 'cancelled';

                    return (
                      <div
                        className={`row-progress${state.phase === 'error' ? ' is-error' : ''}`}
                        key={format}
                      >
                        <div className="row-progress-head">
                          <span>{format === 'audio' ? 'Audio' : 'Video'}</span>
                          <span>
                            {state.phase === 'error'
                              ? 'Failed'
                              : state.phase === 'cancelled'
                                ? 'Cancelled'
                                : state.phase === 'ready'
                                  ? 'Saved'
                                  : `${phaseLabel(state.phase)}${
                                      state.phase === 'downloading' ? ` ${state.percent}%` : ''
                                    }`}
                          </span>
                          {running && (
                            <button
                              type="button"
                              className="cancel-button"
                              onClick={() => handleCancel(`${video.id}:${format}`)}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                        {state.error ? (
                          <p className="progress-error">{state.error}</p>
                        ) : (
                          <>
                            <div className="progress-track">
                              <div
                                className="progress-fill"
                                style={{ width: `${state.percent || 0}%` }}
                              />
                            </div>
                            {state.bytes ? (
                              <p className="progress-note">{formatBytes(state.bytes)}</p>
                            ) : null}
                          </>
                        )}
                      </div>
                    );
                  })}
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
