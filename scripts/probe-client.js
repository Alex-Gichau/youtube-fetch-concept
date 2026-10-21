// Probe: download N playlist items sequentially with a given yt-dlp client
// strategy and report which ones fail (403 etc).
const { spawn } = require('child_process');
const youtubedl = require('youtube-dl-exec');

const strategy = process.argv[2] || 'default';
const limit = Number(process.argv[3] || 5);

const EXTRA = {
  default: {},
  android: { extractorArgs: 'youtube:player_client=android,web' },
  ios: { extractorArgs: 'youtube:player_client=ios,web' },
  web: { extractorArgs: 'youtube:player_client=web' },
  tv: { extractorArgs: 'youtube:player_client=tv' },
  mweb: { extractorArgs: 'youtube:player_client=mweb' },
};

const ids = [
  'dUVs5Ocou8I',
  '5lyb3mDBEW0',
  'kJQP7kiw5Fk',
  'JGwWNGJdvx8',
  '9bZkp7q19f0',
  'fJ9rUzIMcZQ',
  'hT_nvWreIhg',
  'CevxZvSJLk8',
  'nfWlot6h_JM',
  'OPf0YbXqDm0',
];

function run(id) {
  return new Promise((resolve) => {
    const args = youtubedl.args({
      noPlaylist: true,
      noWarnings: true,
      noColor: true,
      noCheckCertificates: true,
      format: 'bestaudio[ext=m4a]/bestaudio/best',
      output: `E:/temp/probe/${id}.%(ext)s`,
      ...(EXTRA[strategy] || {}),
    });

    const child = spawn(youtubedl.constants.YOUTUBE_DL_PATH, [...args, '--', `https://www.youtube.com/watch?v=${id}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
    });

    const timer = setTimeout(() => child.kill(), 90000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const errorLine = err
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^error/i.test(l));
      resolve({ id, code, error: errorLine || (code === 0 ? null : err.slice(-200)) });
    });
  });
}

(async () => {
  const out = [];
  const say = (row) => {
    const line = JSON.stringify(row);
    out.push(line);
    console.log(line);
    require('fs').appendFileSync('E:/temp/probe-client.log', line + '\n');
  };

  say({ strategy, limit });

  for (const id of ids.slice(0, limit)) {
    const started = Date.now();
    const result = await run(id);
    say({ ...result, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  }

  require('fs').writeFileSync(`E:/temp/probe-${strategy}.json`, out.join('\n'));
})();
