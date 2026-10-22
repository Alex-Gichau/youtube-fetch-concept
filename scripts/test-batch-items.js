// Verifies that a batch download reports a per-song list and that each song
// is ticked off as it finishes.
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:3119';
const PLAYLIST_ID = process.env.PLAYLIST_ID || 'RDdUVs5Ocou8I';
const LIMIT = Number(process.env.LIMIT || 3);

const STATE = {
  pending: 0,
  downloading: 0,
  processing: 0,
  done: 0,
  skipped: 0,
};

(async () => {
  const startRes = await fetch(`${BASE}/api/download/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playlistId: PLAYLIST_ID,
      title: 'Radio Mix',
      format: 'audio',
      limit: LIMIT,
    }),
  });

  const startBody = await startRes.json().catch(() => null);
  console.log('start', startRes.status, JSON.stringify(startBody));

  if (!startRes.ok || !startBody?.jobId) {
    console.log('SUMMARY: start failed');
    process.exit(1);
  }

  const jobId = startBody.jobId;
  const snapshots = [];
  let final = null;
  let sawList = false;
  let sawDone = false;

  for (let i = 0; i < 600; i += 1) {
    await new Promise((r) => setTimeout(r, 500));

    const statusRes = await fetch(`${BASE}/api/download/status?jobId=${jobId}`);
    const status = await statusRes.json().catch(() => null);

    if (!statusRes.ok) {
      console.log('status error', statusRes.status, JSON.stringify(status));
      break;
    }

    if (Array.isArray(status.items) && status.items.length) {
      if (!sawList) {
        sawList = true;
        console.log('\n--- first list snapshot ---');
        console.log('count:', status.items.length);
        console.log(
          'items:',
          JSON.stringify(
            status.items.map((item) => ({
              state: item.state,
              percent: item.percent,
              title: item.title.slice(0, 42),
            })),
            null,
            1
          )
        );
      }

      for (const item of status.items) {
        if (item.state in STATE) STATE[item.state] += 1;
      }

      if (status.items.some((item) => item.state === 'done')) sawDone = true;
    }

    snapshots.push({
      phase: status.phase,
      percent: status.percent,
      message: status.message,
      states: Array.isArray(status.items)
        ? status.items.map((item) => item.state).join(',')
        : null,
    });

    if (status.phase === 'ready' || status.phase === 'error' || status.phase === 'cancelled') {
      final = status;
      break;
    }
  }

  console.log('\n--- phase transitions ---');
  let last = '';
  for (const snap of snapshots) {
    const key = `${snap.phase}|${snap.states}`;
    if (key === last) continue;
    last = key;
    console.log(
      `${snap.phase.padEnd(12)} ${String(snap.percent).padStart(3)}%  [${snap.states}]  ${snap.message}`
    );
  }

  console.log('\n--- final ---');
  console.log('phase:', final?.phase);
  console.log('message:', final?.message);
  console.log('fileName:', final?.fileName);
  console.log('bytes:', final?.bytes);
  console.log('items:', JSON.stringify(final?.items?.map((i) => ({ s: i.state, p: i.percent, t: i.title.slice(0, 30) }))));

  // The zip must still download.
  if (final?.phase === 'ready') {
    const fileRes = await fetch(`${BASE}/api/download/file?jobId=${jobId}`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    fs.mkdirSync('E:/temp/job-downloads', { recursive: true });
    fs.writeFileSync(`E:/temp/job-downloads/${final.fileName}`, buffer);
    console.log('\nzip http:', fileRes.status, 'bytes:', buffer.length, 'magic:', buffer.slice(0, 2).toString('hex'));
  }

  const ok =
    sawList &&
    sawDone &&
    final?.phase === 'ready' &&
    Array.isArray(final?.items) &&
    final.items.length === LIMIT;

  console.log('\nSUMMARY:', ok ? 'PASS' : 'FAIL', {
    sawList,
    sawDone,
    phase: final?.phase,
    itemCount: final?.items?.length,
    expected: LIMIT,
  });

  process.exit(ok ? 0 : 1);
})();
