const fs = require('fs');
const path = require('path');

const root = 'e:/Documents/Coding Projects/youtube-fetch-concept/node_modules/next/dist';
const needles = ['API Routes are meant to respond quickly', 'exceeds 4MB', '4 * 1024 * 1024'];
const hits = [];

(function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
    let source;
    try {
      source = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const needle of needles) {
      const index = source.indexOf(needle);
      if (index === -1) continue;
      hits.push({
        file: full.replace(/.*node_modules[\\/]/, ''),
        needle,
        context: source.slice(Math.max(0, index - 700), index + 300).replace(/\s+/g, ' '),
      });
    }
  }
})(root);

for (const hit of hits) {
  console.log('FILE:', hit.file);
  console.log('NEEDLE:', hit.needle);
  console.log('CONTEXT:', hit.context);
  console.log('---');
}

console.log('TOTAL HITS:', hits.length);
