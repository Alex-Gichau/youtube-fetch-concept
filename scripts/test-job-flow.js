// End-to-end test of the new job-based download flow:
//   POST /api/download/start -> jobId
//   GET  /api/download/status -> phase / percent until terminal
//   GET  /api/download/file   -> the actual attachment bytes
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:3107';
const OUT = 'E:/temp/job-downloads';

function log(row) {
  const line = JSON.stringify(row);
  console.log(line);
  fs.appendFileSync('E:/temp/job-flow.json', line + '\n');
}

async function runCase(label, payload) {
  const started = Date.now();

  const startRes = await fetch(`${BASE}/api/download/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const startBody = await startRes.json().catch(() => null);
  log({ label, step: 'start', status: startRes.status, body: startBody });

  if (!startRes.ok || !startBody?.jobId) {
    return { label, ok: false, reason: 'start failed' };
  }

  const jobId = startBody.jobId;
  let final = null;
  let seenPhases = new Set();

  for (let i = 0; i < 2000; i += 1) {
    await new Promise((r) => setTimeout(r, 700));

    const statusRes = await fetch(`${BASE}/api/download/status?jobId=${jobId}`);
    const status = await statusRes.json().catch(() => null);

    if (!statusRes.ok) {
      log({ label, step: 'status-error', status: statusRes.status, body: status });
      return { label, ok: false, reason: 'status failed' };
    }

    if (!seenPhases.has(status.phase)) {
      seenPhases.add(status.phase);
      log({ label, step: 'phase', phase: status.phase, percent: status.percent, message: status.message });
    }

    if (status.phase === 'ready' || status.phase === 'error') {
      final = status;
      break;
    }
  }

  if (!final) {
    log({ label, step: 'timeout' });
    return { label, ok: false, reason: 'timed out' };
  }

  if (final.phase === 'error') {
    log({ label, step: 'failed', error: final.error, seconds: ((Date.now() - started) / 1000).toFixed(1) });
    return { label, ok: false, reason: final.error, seconds: (Date.now() - started) / 1000 };
  }

  const fileRes = await fetch(`${BASE}/api/download/file?jobId=${jobId}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(`${OUT}/${final.fileName}`, buffer);

  const row = {
    label,
    step: 'done',
    fileName: final.fileName,
    httpStatus: fileRes.status,
    contentType: fileRes.headers.get('content-type'),
    disposition: fileRes.headers.get('content-disposition'),
    bytes: buffer.length,
    magic: buffer.slice(0, 3).toString('hex'),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    phases: [...seenPhases],
  };

  log(row);
  return { label, ok: fileRes.status === 200 && buffer.length > 0, ...row };
}

(async () => {
  fs.writeFileSync('E:/temp/job-flow.json', '');
  fs.mkdirSync(OUT, { recursive: true });

  const results = [];

  results.push(
    await runCase('audio', {
      videoId: '5lyb3mDBEW0',
      title: 'Hulvey, Forrest Frank - Altar (Official Music Video)',
      format: 'audio',
    })
  );

  results.push(
    await runCase('video', {
      videoId: '5lyb3mDBEW0',
      title: 'Hulvey, Forrest Frank - Altar (Official Music Video)',
      format: 'video',
    })
  );

  // A deliberately invalid id should fail fast and report a real error.
  results.push(
    await runCase('invalid', {
      videoId: 'notavalidid',
      title: 'Broken Video',
      format: 'audio',
    })
  );

  console.log('SUMMARY:', JSON.stringify(results.map((r) => ({ label: r.label, ok: r.ok, seconds: r.seconds, bytes: r.bytes }))));
})();
