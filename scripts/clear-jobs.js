// Remove all on-disk download job state (useful before a clean test run).
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(os.tmpdir(), 'youtube-fetch-concept', 'jobs');

if (fs.existsSync(root)) {
  fs.rmSync(root, { recursive: true, force: true });
  console.log('cleared', root);
} else {
  console.log('nothing to clear');
}
