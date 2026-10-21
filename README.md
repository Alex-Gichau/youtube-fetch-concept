# YouTube Fetch Concept

Paste a YouTube playlist link (or search by name) and get every item back as a
song row, with one-click audio and video downloads.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

## How it works

No YouTube Data API key is required. The app reads the public playlist or
search page, pulls the embedded `ytInitialData` JSON out of the HTML, and then
follows YouTube's own continuation tokens to page through the rest of the list.

```text
pages/index.js               UI — search/playlist toggle, song rows, download buttons
pages/api/playlist.ts        API route — GET  /api/playlist?url=<playlist url>
pages/api/search.ts          API route — GET  /api/search?query=<name>
pages/api/download/start.ts  API route — POST /api/download/start
pages/api/download/status.ts API route — GET  /api/download/status?jobId=
pages/api/download/file.ts   API route — GET  /api/download/file?jobId=
pages/api/download/cancel.ts API route — POST /api/download/cancel?jobId=
lib/youtube.ts               Playlist + search fetching and parsing
lib/download-jobs.ts         Background download jobs (yt-dlp), on-disk state
lib/download-client.js       Browser helper: start -> poll -> download
lib/download-utils.js        Filename sanitising (shared by server and tests)
lib/search-utils.js          Input classification (URL vs. search term)
styles/globals.css           Dark theme, song rows, progress bars
```

### API

```text
GET /api/playlist?url=https://www.youtube.com/playlist?list=PL...
GET /api/search?query=hulvey
```

```jsonc
{
  "playlistId": "PL...",
  "title": "Top Trending Videos of the Week",
  "channel": "YouTube",
  "videoCount": 19,
  "videoCountLabel": "19 videos",
  "videos": [
    {
      "id": "Vh4O04Bpovw",
      "title": "I Explored A $200,000,000 Forgotten Space Colony",
      "channel": "Yes Theory",
      "channelAvatar": "https://yt3.ggpht.com/...",
      "duration": "16:09",
      "views": "7.4M",
      "publishedAt": "6y ago",
      "thumbnail": "https://i.ytimg.com/vi/Vh4O04Bpovw/hqdefault.jpg",
      "url": "https://www.youtube.com/watch?v=Vh4O04Bpovw"
    }
  ]
}
```

Search results use the same shape, with `"isSearch": true` and a synthetic
`playlistId` of `search:<query>`.

### Accepted inputs

- `https://www.youtube.com/playlist?list=PL...`
- `https://www.youtube.com/watch?v=...&list=PL...`
- A bare playlist ID (`PL...`)
- A bare video URL — resolves to that video's playlist/mix
- Any name ("hulvey") — switches to search mode

### Mix (radio) playlists

YouTube's auto-generated mixes (`RD…`, e.g. `RDdUVs5Ocou8I`) are supported too:

- `https://youtube.com/playlist?list=RDdUVs5Ocou8I`
- `https://www.youtube.com/watch?v=dUVs5Ocou8I&list=RDdUVs5Ocou8I`

These need a different source: YouTube answers the mix's playlist page with
*"This playlist type is unviewable."*, so the items are read from the mix rail
on the watch page instead. A mix is randomised per request, so the exact list
(and its order) can differ between loads. Mixes are finite — there is no
continuation endpoint for them, so you get the ~20 videos YouTube suggests.

## Downloads

Downloads run as **background jobs** with live progress, rather than as one
long request.

```text
POST /api/download/start           { videoId | url | playlistId, title, format, limit? }
  -> 202 { jobId, status, count? }

GET  /api/download/status?jobId=   -> { phase, percent, message, bytes, fileName }
GET  /api/download/file?jobId=     -> the file, as an attachment
POST /api/download/cancel?jobId=   -> { cancelled }
```

`format` is `audio` (192 kbps MP3) or `video` (MP4, capped at 720p). `limit`
caps how many playlist items a batch job downloads.

The browser starts a job, polls the status endpoint every 700 ms, shows a
progress bar on the row, and then triggers a normal browser download once the
file is ready. The file is served as an `attachment`, so it streams straight to
disk — a 200 MB video never sits in memory or in a blob.

A running job can be cancelled from the UI, which kills the yt-dlp process and
discards the partial files.

**Playlist mode** (`playlistId` set) downloads every item into a ZIP archive.
One unavailable video is skipped rather than failing the whole batch, and the
final message reports how many of the total were retrieved.

### Why it is built this way

The first implementation did the whole download inside a single API request and
only then started sending bytes. That produced two visible problems: the
browser sat on a blank page for minutes with no feedback, and any failure
dumped the user onto a raw JSON error page that looked like "nothing
downloaded".

Two further details are worth knowing if you change this code:

- **Job state lives on disk**, in `<tmp>/youtube-fetch-concept/jobs/`. Next.js
  compiles every API route into its own bundle, so an in-memory `Map` is not
  shared between `/api/download/start`, `/api/download/status` and
  `/api/download/file` — the status route would answer 404 for a job it never
  heard of.
- **Every job gets its own directory**, and every item of a batch gets its own
  sub-directory. A shared directory plus stem-prefix matching once let a video
  job pick up a leftover `.m4a` from a previous audio job.

YouTube also blocks some public videos for yt-dlp's default player client
(`HTTP Error 403: Forbidden`). `lib/download-jobs.ts` retries the same URL with
alternate player clients (`android`, `ios`, `tv`, `web_safari`) before giving
up.

## Tests

```bash
node --test lib/download-utils.test.js lib/search-utils.test.js lib/download-client.test.js
```

There are also end-to-end scripts in `scripts/` that drive a running server:

```bash
npm run build && npx next start -p 3107

node scripts/test-job-flow.js     # single audio + video + a failure case
node scripts/test-batch-flow.js   # playlist -> ZIP
node scripts/test-cancel.js        # cancel a running job
```

They read `BASE_URL` from the environment (default `http://localhost:3107`),
and `scripts/test-batch-flow.js` accepts `LIMIT` and `PLAYLIST_ID`.

## Notes

- The YouTube Data API is capped at 50 items per request and needs a key.
  This approach walks the playlist's continuation tokens instead, so it returns
  the whole list (a 1653-video channel playlist loads in ~10s).
- `lib/youtube.ts` depends on YouTube's internal page structure. If YouTube
  changes it, `extractItems()` in that file is the place to update.
- `.env` is not required. If you want to add a `YOUTUBE_API_KEY` later, it is
  not read by the current implementation.
