// Verify the cancel endpoint: start a download, cancel it, confirm the job
// reaches the 'cancelled' phase and the file is removed.
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:3107';

function log(row) {
  const line = JSON.stringify(row);
  console.log(line);
  fs.appendFileSync('E:/temp/cancel-flow.json', line + '\n');
}

(async () => {
  fs.writeFileSync('E:/temp/cancel-flow.json', '');

  const startRes = await fetch(`${BASE}/api/download/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId: '5lyb3mDBEW0',
      title: 'Hulvey, Forrest Frank - Altar (Official Music Video)',
      format: 'video',
    }),
  });

  const startBody = await startRes.json().catch(() => null);
  log({ step: 'start', status: startRes.status, body: startBody });

  if (!startBody?.jobId) {
    console.log('SUMMARY: start failed');
    return;
  }

  const jobId = startBody.jobId;

  // Let it get going so we cancel a genuinely running job.
  await new Promise((r) => setTimeout(r, 4000));

  const cancelRes = await fetch(`${BASE}/api/download/cancel?jobId=${jobId}`, {
    method: 'POST',
  });
  const cancelBody = await cancelRes.json().catch(() => null);
  log({ step: 'cancel', status: cancelRes.status, body: cancelBody });

  await new Promise((r) => setTimeout(r, 3000));

  const statusRes = await fetch(`${BASE}/api/download/status?jobId=${jobId}`);
  const status = await statusRes.json().catch(() => null);
  log({ step: 'status', status: statusRes.status, body: status });

  // The file endpoint must now refuse to serve anything.
  const fileRes = await fetch(`${BASE}/api/download/file?jobId=${jobId}`);
  log({ step: 'file', status: fileRes.status });

  console.log(
    'SUMMARY:',
    JSON.stringify({
      cancelled: cancelBody?.cancelled === true,
      phase: status?.phase,
      fileStatus: fileRes.status,
    })
  );
})();
