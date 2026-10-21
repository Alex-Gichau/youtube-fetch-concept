// Print the last N lines of a text file (used to read run logs).
const fs = require('fs');

const file = process.argv[2] || 'E:/temp/job-flow.json';
const count = Number(process.argv[3] || 6);

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
console.log(lines.slice(-count).join('\n'));
