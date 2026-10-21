// Show the contents of a job directory (per-item sub-directories, file sizes).
const fs = require('fs');
const path = require('path');
const os = require('os');

const jobsRoot = path.join(os.tmpdir(), 'youtube-fetch-concept', 'jobs');
const jobId = process.argv[2];

if (!jobId) {
  console.log('usage: node scripts/job-dirs.js <jobId>');
  process.exit(1);
}

const dir = path.join(jobsRoot, jobId);

function walk(current, depth) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      console.log(`${'  '.repeat(depth)}[dir] ${entry.name}`);
      walk(full, depth + 1);
    } else {
      const size = fs.statSync(full).size;
      console.log(`${'  '.repeat(depth)}${entry.name} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    }
  }
}

if (!fs.existsSync(dir)) {
  console.log('job dir not found:', dir);
  process.exit(1);
}

walk(dir, 0);
