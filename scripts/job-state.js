// Print the on-disk state of the most recent download job.
const fs = require('fs');
const path = require('path');
const os = require('os');

const jobsRoot = path.join(os.tmpdir(), 'youtube-fetch-concept', 'jobs');

const files = fs
  .readdirSync(jobsRoot)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const full = path.join(jobsRoot, f);
    const state = JSON.parse(fs.readFileSync(full, 'utf8'));
    return { ...state, dir: path.join(jobsRoot, f.replace('.json', '')) };
  })
  .sort((a, b) => b.createdAt - a.createdAt);

for (const job of files.slice(0, Number(process.argv[2] || 3))) {
  const files2 = fs.existsSync(job.dir) ? fs.readdirSync(job.dir) : [];
  console.log(
    JSON.stringify({
      id: job.id,
      phase: job.phase,
      percent: job.percent,
      message: job.message,
      error: job.error,
      fileName: job.fileName,
      bytes: job.bytes,
      files: files2,
    })
  );
}
