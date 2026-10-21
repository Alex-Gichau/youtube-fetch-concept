// Check whether a pre-merged (video+audio in one stream) MP4 format exists,
// which lets us skip the slow ffmpeg merge step entirely.
const { execFileSync } = require('child_process');
const fs = require('fs');

const BIN = 'e:/Documents/Coding Projects/youtube-fetch-concept/node_modules/youtube-dl-exec/bin/yt-dlp.exe';
const VIDEO = 'https://www.youtube.com/watch?v=5lyb3mDBEW0';

const raw = execFileSync(BIN, ['-J', '--no-warnings', '--no-playlist', VIDEO], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

const meta = JSON.parse(raw);

const combined = meta.formats.filter(
  (f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none'
);
const videoOnly = meta.formats.filter((f) => f.vcodec !== 'none' && f.acodec === 'none');
const audioOnly = meta.formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none');

const describe = (f) => ({
  id: f.format_id,
  ext: f.ext,
  height: f.height ?? null,
  fps: f.fps ?? null,
  tbr: f.tbr ?? null,
  size: f.filesize ?? f.filesize_approx ?? null,
  note: f.format_note ?? null,
  proto: f.protocol,
  acodec: f.acodec,
  vcodec: f.vcodec,
});

const report = {
  title: meta.title,
  duration: meta.duration,
  combined: combined.map(describe),
  videoOnlyCount: videoOnly.length,
  audioOnly: audioOnly.map(describe),
  bestCombined: combined.sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0)).slice(0, 3).map(describe),
};

fs.writeFileSync('E:/temp/format-report.json', JSON.stringify(report, null, 2));
console.log('COMBINED (no merge needed):', JSON.stringify(report.combined));
console.log('AUDIO ONLY:', JSON.stringify(report.audioOnly));
console.log('BEST COMBINED:', JSON.stringify(report.bestCombined));
