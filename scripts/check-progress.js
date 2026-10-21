// Verify that we can build yt-dlp CLI args and read machine-readable progress
// lines while the download runs. This is what powers the per-row progress bar.
const youtubedl = require('youtube-dl-exec');
const { spawn } = require('child_process');

const BIN = youtubedl.constants.YOUTUBE_DL_PATH;
const VIDEO = 'https://www.youtube.com/watch?v=5lyb3mDBEW0';

const flags = {
  format: 'bestaudio/best',
  extractAudio: true,
  audioFormat: 'mp3',
  output: 'E:/temp/progress-test.%(ext)s',
  noPlaylist: true,
  noWarnings: true,
  noColor: true,
  newline: true,
  progressTemplate: 'download:%(progress.status)s|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s',
};

console.log('BINARY:', BIN);
const args = youtubedl.args(flags);
console.log('ARGS:', JSON.stringify(args));

const started = Date.now();
const child = spawn(BIN, [...args, '--', VIDEO], { stdio: ['ignore', 'pipe', 'pipe'] });

let stdoutBuf = '';
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString();
  const lines = stdoutBuf.split(/\r?\n/);
  stdoutBuf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    console.log(`[${Date.now() - started}ms] ${line}`);
  }
});

let err = '';
child.stderr.on('data', (d) => (err += d.toString()));

child.on('close', (code) => {
  console.log('EXIT', code, 'ms', Date.now() - started);
  if (err.trim()) console.log('STDERR:', err.slice(0, 500));
});
