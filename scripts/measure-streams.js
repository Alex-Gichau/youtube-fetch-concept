// Measure "time to first byte" and total time for different download strategies.
//
//  A) yt-dlp raw m4a to stdout           -> stream native audio, no transcode
//  B) yt-dlp m4a stdout | ffmpeg mp3     -> stream mp3 while transcoding
//  C) two CDN URLs | ffmpeg -c copy mp4  -> stream merged video without temp files
//  D) yt-dlp merge to a temp file        -> the current (slow) approach
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const BIN = 'e:/Documents/Coding Projects/youtube-fetch-concept/node_modules/youtube-dl-exec/bin/yt-dlp.exe';
const VIDEO = 'https://www.youtube.com/watch?v=5lyb3mDBEW0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const results = [];

function measureStream(label, spawnFn) {
  return new Promise((resolve) => {
    const started = Date.now();
    let firstByteMs = null;
    let bytes = 0;
    const chunks = [];

    const child = spawnFn((chunk) => {
      if (firstByteMs === null) firstByteMs = Date.now() - started;
      bytes += chunk.length;
      chunks.push(chunk);
    });

    child.on('close', (code) => {
      const row = {
        label,
        exitCode: code,
        firstByteMs,
        totalMs: Date.now() - started,
        bytes,
        ok: code === 0 && bytes > 0,
      };
      results.push(row);
      console.log(JSON.stringify(row));
      resolve(row);
    });
  });
}

(async () => {
  // --- resolve CDN urls for the streaming strategies ---
  const { stdout } = await execFileAsync(
    BIN,
    ['-J', '--no-warnings', '--no-playlist', VIDEO],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const meta = JSON.parse(stdout);
  const audio = meta.formats.find((f) => f.format_id === '140');
  const video = meta.formats.find((f) => f.format_id === '137');
  console.log('resolved audio 140:', audio && audio.filesize);
  console.log('resolved video 137:', video && video.filesize);

  // A) raw m4a straight from yt-dlp stdout
  await measureStream('A: yt-dlp m4a stdout', (onChunk) => {
    const child = spawn(
      BIN,
      ['-f', '140', '--no-warnings', '--no-playlist', '-o', '-', '--', VIDEO],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.on('data', onChunk);
    child.stderr.on('data', () => {});
    return child;
  });

  // B) yt-dlp stdout piped into ffmpeg to emit mp3 on the fly
  await measureStream('B: yt-dlp | ffmpeg mp3 stdout', (onChunk) => {
    const dl = spawn(
      BIN,
      ['-f', '140', '--no-warnings', '--no-playlist', '-o', '-', '--', VIDEO],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const ff = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'mp3', '-c:a', 'libmp3lame', '-b:a', '192k', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    dl.stdout.pipe(ff.stdin);
    dl.stderr.on('data', () => {});
    ff.stderr.on('data', () => {});
    ff.stdout.on('data', onChunk);
    ff.on('close', (code) => {
      if (dl.exitCode === null) dl.kill();
      process.nextTick(() => {});
      resolveCode(code);
    });
    function resolveCode(code) {
      childExitCode = code;
    }
    let childExitCode = null;
    return {
      on: (event, cb) => {
        if (event === 'close') {
          ff.on('close', (c) => cb(childExitCode ?? c));
        } else {
          ff.on(event, cb);
        }
      },
    };
  });

  // C) ffmpeg merges the two CDN streams itself, writing mp4 to stdout
  if (audio && video) {
    await measureStream('C: ffmpeg two CDN urls -> mp4 stdout', (onChunk) => {
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
      child.stderr.on('data', (d) => fs.appendFileSync('E:/temp/ffmpeg-c.log', d));
      return child;
    });
  }

  fs.writeFileSync('E:/temp/measure-streams.json', JSON.stringify(results, null, 2));
  console.log('SAVED E:/temp/measure-streams.json');
})();
