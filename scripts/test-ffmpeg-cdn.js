// Focused test: can ffmpeg merge the two CDN streams straight to stdout?
// This avoids downloading to a temp file and re-reading it, which is the
// slowest part of the current implementation.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const BIN = 'e:/Documents/Coding Projects/youtube-fetch-concept/node_modules/youtube-dl-exec/bin/yt-dlp.exe';
const VIDEO = 'https://www.youtube.com/watch?v=5lyb3mDBEW0';

(async () => {
  const { stdout } = await execFileAsync(
    BIN,
    ['-J', '--no-warnings', '--no-playlist', VIDEO],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const meta = JSON.parse(stdout);
  const audio = meta.formats.find((f) => f.format_id === '140');
  const video = meta.formats.find((f) => f.format_id === '137');

  console.log('AUDIO http_headers:', JSON.stringify(audio.http_headers));
  console.log('VIDEO http_headers:', JSON.stringify(video.http_headers));
  console.log('audio size', audio.filesize, 'video size', video.filesize);

  const ua = audio.http_headers?.['User-Agent'] || 'Mozilla/5.0';

  const started = Date.now();
  let firstByteMs = null;
  let bytes = 0;
  const outPath = 'E:/temp/ffmpeg-out.mp4';

  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-user_agent',
      ua,
      '-headers',
      `Referer: https://www.youtube.com/\r\n`,
      '-i',
      video.url,
      '-user_agent',
      ua,
      '-i',
      audio.url,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const ws = fs.createWriteStream(outPath);
  child.stdout.on('data', (chunk) => {
    if (firstByteMs === null) firstByteMs = Date.now() - started;
    bytes += chunk.length;
    ws.write(chunk);
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d.toString()));
  child.on('close', (code) => {
    ws.end();
    console.log(
      JSON.stringify({
        code,
        firstByteMs,
        totalMs: Date.now() - started,
        bytes,
        stderr: err.slice(0, 800),
      })
    );
  });
})();
