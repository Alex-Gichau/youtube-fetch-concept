import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import { isSearchInput, normalizeSearchQuery } from '../lib/search-utils.js';
import {
  cancelDownload,
  formatBytes,
  isCancelledError,
  phaseLabel,
  runDownload,
} from '../lib/download-client.js';
import {
  buildPageList,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  paginate,
} from '../lib/pagination-utils.js';
import {
  batchItemMarker,
  batchItemStateLabel,
  batchSummary,
  batchSummaryText,
  currentBatchItem,
  visibleBatchItems,
} from '../lib/batch-utils.js';

export default function Home() {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('search');
  const [playlist, setPlaylist] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Infinite scroll: how many rows we've revealed so far. Rows per page is
  // still the step size; the sentinel at the bottom loads the next batch.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState(new Set());
  const [visibleCount, setVisibleCount] = useState(DEFAULT_PAGE_SIZE);
  const sentinelRef = useRef(null);

  // Per-download state keyed by `${videoId}:${format}`.
  const [downloads, setDownloads] = useState({});

  const updateDownload = (key, patch) => {
    setDownloads((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }));
  };

  const toggleSelect = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllOnPage = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const video of current.items) next.add(video.id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const handleSelectedDownload = async (format) => {
    if (!selected.size) return;

    const chosen = videos.filter((video) => selected.has(video.id));

    for (const video of chosen) {
      handleSingleDownload(video, format);
    }
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
    setPage(1);
    setVisibleCount(pageSize);

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

  // The visible slice of rows for the current page. With infinite scroll we
  // reveal `visibleCount` rows at once, growing it as the user scrolls.
  const current = useMemo(
    () => paginate(videos, 1, visibleCount),
    [videos, visibleCount]
  );

  const pageNumbers = useMemo(
    () => buildPageList(current.page, current.pageCount),
    [current.page, current.pageCount]
  );

  // Infinite scroll: when the sentinel near the bottom of the list comes into
  // view, reveal the next page-sized batch of rows.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisibleCount((count) => {
              if (count >= videos.length) return count;
              return Math.min(count + pageSize, videos.length);
            });
          }
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [videos.length, pageSize]);

  const handlePageChange = (nextPage) => {
    setPage(nextPage);
    // Bring the new page into view instead of leaving the user mid-list.
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const target = document.getElementById('song-list-top');
        if (target) {
          const top = target.getBoundingClientRect().top + window.scrollY - 16;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      });
    }
  };

  const handlePageSizeChange = (nextSize) => {
    setPageSize(nextSize);
    setPage(1);
    setVisibleCount(nextSize);
  };

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

                  const items = state.items ?? [];
                  const summary = batchSummary(items);
                  const currentItem = currentBatchItem(items);
                  const visibleItems = visibleBatchItems(items, summary.currentIndex);
                  const firstVisible = visibleItems[0]?.position ?? 0;
                  const lastVisible = visibleItems.length
                    ? visibleItems[visibleItems.length - 1].position + 1
                    : 0;
                  const hiddenAbove = firstVisible;
                  const hiddenBelow = summary.total - lastVisible;

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

                      {items.length > 0 && (
                        <div className="batch-list">
                          <div className="batch-list-head">
                            <span className="batch-list-title">Songs</span>
                            <span className="batch-list-count">
                              {batchSummaryText(items)}
                            </span>
                          </div>

                          {currentItem && (
                            <p className="batch-current">
                              <span className="batch-current-marker" aria-hidden="true">
                                ●
                              </span>
                              <span className="batch-current-title">{currentItem.title}</span>
                              <span className="batch-current-state">
                                {batchItemStateLabel(currentItem)}
                                {currentItem.state === 'downloading' && currentItem.percent
                                  ? ` ${currentItem.percent}%`
                                  : ''}
                              </span>
                            </p>
                          )}

                          <ol className="batch-items" aria-label="Songs in this download">
                            {hiddenAbove > 0 && (
                              <li className="batch-items-more">
                                {hiddenAbove} earlier {hiddenAbove === 1 ? 'song' : 'songs'}
                              </li>
                            )}
                            {visibleItems.map((item) => {
                              const isCurrent =
                                item.state === 'downloading' || item.state === 'processing';

                              return (
                                <li
                                  key={item.id}
                                  className={`batch-item is-${item.state}${
                                    isCurrent ? ' is-current' : ''
                                  }`}
                                >
                                  <span className="batch-item-marker" aria-hidden="true">
                                    {batchItemMarker(item)}
                                  </span>
                                  <span className="batch-item-title">{item.title}</span>
                                  <span className="batch-item-state">
                                    {item.state === 'downloading' && item.percent
                                      ? `${item.percent}%`
                                      : batchItemStateLabel(item)}
                                  </span>
                                </li>
                              );
                            })}
                            {hiddenBelow > 0 && (
                              <li className="batch-items-more">
                                {hiddenBelow} more {hiddenBelow === 1 ? 'song' : 'songs'}
                              </li>
                            )}
                          </ol>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {videos.length > 0 && (
          <>
            <nav className="pagination pagination-top" aria-label="Pagination (top)">
              <PaginationControls />
            </nav>

            <div className="bulk-actions selection-actions">
              <span className="selection-count">
                {selected.size
                  ? `${selected.size} selected`
                  : 'Select songs to download them as a batch'}
              </span>
              <button type="button" onClick={selectAllOnPage}>Select page</button>
              <button type="button" onClick={clearSelection} disabled={!selected.size}>
                Clear
              </button>
              {['audio', 'video'].map((format) => (
                <button
                  type="button"
                  key={format}
                  onClick={() => handleSelectedDownload(format)}
                  disabled={!selected.size}
                >
                  Download selected {format}
                </button>
              ))}
            </div>

            <div className="song-list" role="list" id="song-list-top">
              {current.items.map((video) => (
              <article className="song-row" key={video.id} role="listitem">
                <label className="song-select">
                  <input
                    type="checkbox"
                    checked={selected.has(video.id)}
                    onChange={() => toggleSelect(video.id)}
                    aria-label={`Select ${video.title}`}
                  />
                </label>
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

            <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />

            {/*
              The nav stays visible even when everything fits on one page, so
              the "rows per page" selector cannot disappear and strand the
              user on the size they just picked.
            */}
            <nav className="pagination" aria-label="Pagination">
              <div className="pagination-meta">
                <span>
                  {current.pageCount > 1
                    ? `Showing ${current.from}–${current.to} of ${current.total}`
                    : `Showing all ${current.total} ${
                        current.total === 1 ? 'video' : 'videos'
                      }`}
                </span>
                <label className="pagination-size">
                  Rows
                  <select
                    value={pageSize}
                    onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                    aria-label="Rows per page"
                  >
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {current.pageCount > 1 && (
                <div className="pagination-controls">
                  <button
                    type="button"
                    className="page-button"
                    onClick={() => handlePageChange(current.page - 1)}
                    disabled={!current.hasPrev}
                    aria-label="Previous page"
                  >
                    Prev
                  </button>

                  {pageNumbers.map((entry, index) =>
                    entry === '…' ? (
                      <span className="page-gap" key={`gap-${index}`} aria-hidden="true">
                        …
                      </span>
                    ) : (
                      <button
                        type="button"
                        key={entry}
                        className={`page-button${
                          entry === current.page ? ' is-active' : ''
                        }`}
                        onClick={() => handlePageChange(entry)}
                        aria-current={entry === current.page ? 'page' : undefined}
                        aria-label={`Page ${entry}`}
                      >
                        {entry}
                      </button>
                    )
                  )}

                  <button
                    type="button"
                    className="page-button"
                    onClick={() => handlePageChange(current.page + 1)}
                    disabled={!current.hasNext}
                    aria-label="Next page"
                  >
                    Next
                  </button>
                </div>
              )}
            </nav>
          </>
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
