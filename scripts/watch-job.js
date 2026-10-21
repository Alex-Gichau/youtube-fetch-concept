// Watch a job's files grow, to see whether a download/conversion is progressing.
const fs = require('fs');
const path = require('path');
const os = require('os');

const jobsRoot = path.join(os.tmpdir(), 'youtube-fetch-concept', 'jobs');
const jobId = process.argv[2];
const ticks = Number(process.argv[3] || 6);

if (!jobId) {
  console.log('usage: node scripts/watch-job.js <jobId> [ticks]');
  process.exit(1);
}

function snapshot() {
  const dir = path.join(jobsRoot, jobId);
  const out = [];

  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out.push(`[${path.basename(current)}]`);
        walk(full);
      } else {
        const size = fs.statSync(full).size;
        out.push(`${entry.name}=${(size / 1024 / 1024).toFixed(1)}MB`);
      }
    }
  }

  walk(dir);
  return out.join(' ');
}

(async () => {
  for (let i = 0; i < ticks; i += 1) {
    console.log(`[${i}] ${snapshot()}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
})();
