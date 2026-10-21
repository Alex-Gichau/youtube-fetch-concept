// Benchmark v2: measure "time to first byte" and total time for streaming
// strategies that avoid writing a temp file first.
//
//   A) direct CDN audio (m4a)                      -> fastest, exact size
//   B) ffmpeg pipe: CDN audio -> mp3 on stdout     -> progressive mp3
//   C) ffmpeg pipe: CDN video + CDN audio -> mp4   -> progressive merged mp4
//
// Each run is given a hard timeout so a bad candidate can never hang the suite.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const BIN = 'e:/Documents/Coding Projects/youtube-fetch-concept/node_modules/youtube-dl-exec/bin/yt-dlp.exe';
const VIDEO = 'https://www.youtube.com/watch?v=5lyb3mDBEW0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 120000;

const results = [];

function run(label, spawnFn) {
  return new Promise((resolve) => {
    const started = Date.now();
    let firstByteMs = null;
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      const row = { label, timeout: true, firstByteMs, totalMs: Date.now() - started, bytes };
      results.push(row);
      console.log(JSON.stringify(row));
      resolve(row);
    }, TIMEOUT_MS);

    const child = spawnFn((chunk) => {
      if (firstByteMs === null) firstByteMs = Date.now() - started;
      bytes += chunk.length;
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const row = { label, exitCode: code, firstByteMs, totalMs: Date.now() - started, bytes };
      results.push(row);
      console.log(JSON.stringify(row));
      resolve(row);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const row = { label, error: err.message, totalMs: Date.now() - started, bytes };
      results.push(row);
      console.log(JSON.stringify(row));
      resolve(row);
    });
  });
}

(async () => {
  const { stdout } = await execFileAsync(
    BIN,
    ['-J', '--no-warnings', '--no-playlist', VIDEO],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const meta = JSON.parse(stdout);
  const audio = meta.formats.find((f) => f.format_id === '140');
  const video = meta.formats.find((f) => f.format_id === '137');
  console.log('audio 140 size:', audio.filesize, 'video 137 size:', video.filesize);

  // A) direct CDN audio bytes
  await run('A: direct CDN m4a', (onChunk) => {
    const child = spawn('node', [
      '-e',
      `const u=${JSON.stringify(audio.url)};fetch(u,{headers:{'User-Agent':${JSON.stringify(UA)}}}).then(async r=>{console.error('status',r.status);for await(const c of r.body)process.stdout.write(c)});`,
    ]);
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => fs.appendFileSync('E:/temp/bench-a.log', d));
    return child;
  });

  // B) ffmpeg: CDN audio -> mp3 on stdout
  await run('B: ffmpeg CDN audio -> mp3 stdout', (onChunk) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-user_agent',
        UA,
        '-i',
        audio.url,
        '-vn',
        '-f',
        'mp3',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => fs.appendFileSync('E:/temp/bench-b.log', d));
    return child;
  });

  // C) ffmpeg: CDN video + CDN audio -> fragmented mp4 on stdout
  await run('C: ffmpeg CDN video+audio -> mp4 stdout', (onChunk) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-user_agent',
        UA,
        '-i',
        video.url,
        '-user_agent',
        UA,
        '-i',
        audio.url,
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
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => fs.appendFileSync('E:/temp/bench-c.log', d));
    return child;
  });

  fs.writeFileSync('E:/temp/bench-v2.json', JSON.stringify(results, null, 2));
  console.log('DONE');
})();
