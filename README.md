# YouTube Fetch Concept

Paste a YouTube playlist link, get every item in that playlist back as a song row.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

## How it works

No YouTube Data API key is required. The app reads the public playlist page,
pulls the embedded `ytInitialData` JSON out of the HTML, and then follows
YouTube's own continuation tokens to page through the rest of the playlist.

```
pages/index.js        UI — search box + responsive card grid
pages/api/playlist.ts API route — GET /api/playlist?url=<playlist url>
lib/youtube.ts        Playlist fetching + parsing logic
styles/globals.css    Dark theme, card grid, responsive rules
```

### API

```
GET /api/playlist?url=https://www.youtube.com/playlist?list=PL...
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

### Accepted inputs

- `https://www.youtube.com/playlist?list=PL...`
- `https://www.youtube.com/watch?v=...&list=PL...`
- A bare playlist ID (`PL...`)

### Mix (radio) playlists

YouTube's auto-generated mixes (`RD…`, e.g. `RDdUVs5Ocou8I`) are supported too:

- `https://youtube.com/playlist?list=RDdUVs5Ocou8I`
- `https://www.youtube.com/watch?v=dUVs5Ocou8I&list=RDdUVs5Ocou8I`

These need a different source: YouTube answers the mix's playlist page with
*"This playlist type is unviewable."*, so the items are read from the mix rail
on the watch page instead. A mix is randomised per request, so the exact list
(and its order) can differ between loads. Mixes are finite — there is no
continuation endpoint for them, so you get the ~20 videos YouTube suggests.

## Notes

- The YouTube Data API is capped at 50 items per request and needs a key.
  This approach walks the playlist's continuation tokens instead, so it returns
  the whole list (a 1653-video channel playlist loads in ~10s).
- `lib/youtube.ts` depends on YouTube's internal page structure. If YouTube
  changes it, `extractItems()` in that file is the place to update.
- `.env` is not required. If you want to add a `YOUTUBE_API_KEY` later, it is
  not read by the current implementation.

