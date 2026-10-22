// Kill whatever is listening on a TCP port (Windows).
const { execSync } = require('child_process');

const port = process.argv[2] || '3119';

const output = execSync(`netstat -ano -p TCP | findstr :${port}`, { encoding: 'utf8' });

const pids = new Set();

for (const line of output.split(/\r?\n/)) {
  const match = line.match(/LISTENING\s+(\d+)/i);
  if (match) pids.add(match[1]);
}

if (!pids.size) {
  console.log(`nothing listening on ${port}`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    console.log(`killed pid ${pid}`);
  } catch (error) {
    console.log(`could not kill pid ${pid}`);
  }
}
