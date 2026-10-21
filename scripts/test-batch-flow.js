// End-to-end test of the bulk (playlist -> ZIP) download path.
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:3107';
const OUT = 'E:/temp/job-downloads';

function log(row) {
  const line = JSON.stringify(row);
  console.log(line);
  fs.appendFileSync('E:/temp/batch-flow.json', line + '\n');
}

(async () => {
  fs.writeFileSync('E:/temp/batch-flow.json', '');
  fs.mkdirSync(OUT, { recursive: true });

  const started = Date.now();

  // A short, mixed playlist keeps the test quick. `dUVs5Ocou8I` is included on
  // purpose: it is the video YouTube blocks for the default player client.
  const playlistId = process.env.PLAYLIST_ID || 'RDdUVs5Ocou8I';
  const limit = Number(process.env.LIMIT || 2);

  const startRes = await fetch(`${BASE}/api/download/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playlistId,
      title: 'Radio Mix',
      format: 'audio',
      limit,
    }),
  });

  const startBody = await startRes.json().catch(() => null);
  log({ step: 'start', status: startRes.status, body: startBody });

  if (!startRes.ok || !startBody?.jobId) {
    console.log('SUMMARY: start failed');
    return;
  }

  const jobId = startBody.jobId;
  let final = null;
  const seen = new Set();

  for (let i = 0; i < 4000; i += 1) {
    await new Promise((r) => setTimeout(r, 700));

    const statusRes = await fetch(`${BASE}/api/download/status?jobId=${jobId}`);
    const status = await statusRes.json().catch(() => null);

    if (!statusRes.ok) {
      log({ step: 'status-error', status: statusRes.status, body: status });
      break;
    }

    if (!seen.has(status.phase + ':' + status.percent)) {
      seen.add(status.phase + ':' + status.percent);
      log({ step: 'phase', phase: status.phase, percent: status.percent, message: status.message });
    }

    if (status.phase === 'ready' || status.phase === 'error') {
      final = status;
      break;
    }
  }

  if (!final || final.phase === 'error') {
    log({ step: 'failed', error: final && final.error, seconds: ((Date.now() - started) / 1000).toFixed(1) });
    console.log('SUMMARY: batch failed');
    return;
  }

  const fileRes = await fetch(`${BASE}/api/download/file?jobId=${jobId}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(`${OUT}/${final.fileName}`, buffer);

  log({
    step: 'done',
    fileName: final.fileName,
    httpStatus: fileRes.status,
    contentType: fileRes.headers.get('content-type'),
    bytes: buffer.length,
    magic: buffer.slice(0, 2).toString('hex'),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  });

  console.log('SUMMARY: batch ok');
})();
