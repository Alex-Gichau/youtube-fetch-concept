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
lib/pagination-utils.js      Page slicing + page-number strip (shared by UI and tests)
styles/globals.css           Dark theme, song rows, progress bars, pagination
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

GET  /api/download/status?jobId=   -> { phase, percent, message, bytes, fileName, items? }
GET  /api/download/file?jobId=     -> the file, as an attachment
POST /api/download/cancel?jobId=   -> { cancelled }
```

`items` is only present for a batch job. It holds one entry per song:
`{ id, title, state, percent, bytes?, error? }`, where `state` is one of
`pending`, `downloading`, `processing`, `done` or `skipped`.

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

### The per-song list

A batch can cover hundreds of songs, so a single percentage bar says very
little about what is happening. While a batch runs, the UI shows the whole
queue of songs and ticks them off one by one:

```text
●  Please, Just Drive Me Home"—Tired Nurse…      Downloading 24%
✓  indie tribe - ROB HELL (Official Music Video)  Done
✓  Hulvey, Torey D'Shaun, Alex Jean — Love Like…  Done
○  IN CHRIST | Blessed in Christ | Ephesians 1:3   Queued
```

| Marker | Meaning |
| --- | --- |
| `●` | The song being downloaded or converted right now |
| `✓` | The song finished and is in the ZIP |
| `✕` | The song was unavailable and was skipped |
| `○` | The song is still queued |

The song that is running right now also gets its own line above the list, with
its own percentage, so it is never scrolled out of sight.

The list comes from the server: `runBatch` keeps one entry per song and
publishes it in the job status. The per-song list is written to its own file
(`<jobId>.items.json`) rather than into the main state file, so the status
route stays cheap to poll no matter how long the playlist is. Progress
updates are throttled to one write every 400 ms; a state change (a song
finishing, being skipped, or the next one starting) is written straight away.

The overall bar is **monotonic** — it never moves backwards. Each song owns a
slice of the bar (`100 / songCount` percent) and every phase of that song
stays inside its slice, so the bar creeps forward steadily instead of
jumping to 99% and back to 0% at every song boundary.

`lib/batch-utils.js` holds the pure helpers the UI shares with the unit
tests: the markers, the state labels, the counts and the windowing that keeps
a 500-song list from re-rendering in full on every poll.

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

## Responsive layout

The page is built mobile-first and adapts in `styles/globals.css`:

| Width | Layout |
| --- | --- |
| > 900px | Three columns: 180px thumbnail · title · 190px action stack |
| ≤ 900px | Tracks shrink to 148px / 168px so the title keeps a readable column |
| ≤ 720px | Actions move under the title and span the full row; buttons sit side by side |
| ≤ 560px | Compact list: a 120px poster beside the title, 44px touch targets |
| ≤ 380px | Poster shrinks to 96px and the type scales down |

Other details worth knowing:

- The thumbnail is always 16:9, either from a fixed height or from
  `padding-bottom: 56.25%` on phones (a percentage height would collapse).
- The two fixed grid tracks live in the `--thumb-w` / `--actions-w` custom
  properties on `.song-row`, so a breakpoint only overrides two numbers.
- `@media (pointer: coarse)` raises hit areas to 44px on touch devices, and
  `@media (prefers-reduced-motion: reduce)` disables the hover lift and the
  progress-bar transition.
- The container respects `env(safe-area-inset-*)` so notched phones do not clip
  content.

At 360px a song row is about 158px tall instead of the 407px it used to be
when the thumbnail spanned the full width.

The batch song list follows the same ladder: the scroll window shrinks from
260px to 200px on a phone, and the running song's title is clamped to two
lines so a long name cannot push the list off the screen.

## Pagination

The song rows are paginated. The default is **10 rows per page**, and the
"Rows" selector offers 10, 20 and 50 — never fewer than 10.

Pagination is done in the browser, not on the server: `/api/playlist` and
`/api/search` already return every item, so there is no need to ask YouTube
for one page at a time. `lib/pagination-utils.js` holds the pure helpers
(`paginate`, `buildPageList`) that the UI and the unit tests share.

The page-number strip always shows the first and last page plus the current
page and its neighbours, with `…` marking the gaps (e.g. `1 … 6 7 8 … 25`).
Changing the page scrolls the list back into view, and changing the page size
returns to page 1.

The "Rows per page" selector stays visible even when everything fits on a
single page — otherwise picking a large size would remove the control and
strand you on it.

## Tests

```bash
node --test lib/download-utils.test.js lib/search-utils.test.js lib/download-client.test.js lib/pagination-utils.test.js lib/batch-utils.test.js
```

There are also end-to-end scripts in `scripts/` that drive a running server:

```bash
npm run build && npx next start -p 3107

node scripts/test-job-flow.js       # single audio + video + a failure case
node scripts/test-batch-flow.js     # playlist -> ZIP
node scripts/test-batch-items.js    # per-song list: states, ticks, ordering
node scripts/test-cancel.js         # cancel a running job
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
