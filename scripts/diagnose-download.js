// Hit the current download API for several video IDs / formats and report the
// exact status and error body so we can see why some downloads 500.
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:3101';

const CASES = [
  { id: '5lyb3mDBEW0', title: 'Altar Official Music Video', format: 'audio' },
  { id: '5lyb3mDBEW0', title: 'Altar Official Music Video', format: 'video' },
  { id: '5TYvYpqDr9Q', title: 'The Poor Girl Pretended To Be Rich Full Movie', format: 'audio' },
  { id: '240Z3DdjAKI', title: 'Connor Price Torey DShaun xander Dont Rob That Man', format: 'video' },
];

(async () => {
  const lines = [];

  for (const testCase of CASES) {
    const url = `${BASE}/api/download?videoId=${testCase.id}&title=${encodeURIComponent(
      testCase.title
    )}&format=${testCase.format}&mode=single`;

    const started = Date.now();
    const row = { ...testCase };

    try {
      const res = await fetch(url);
      const type = res.headers.get('content-type') || '';
      const body = Buffer.from(await res.arrayBuffer());

      row.status = res.status;
      row.contentType = type;
      row.disposition = res.headers.get('content-disposition');
      row.bytes = body.length;
      row.seconds = Number(((Date.now() - started) / 1000).toFixed(1));

      if (type.includes('json')) {
        row.error = body.toString('utf8').slice(0, 600);
      }
    } catch (error) {
      row.error = `THREW: ${error.message}`;
      row.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    }

    lines.push(row);
    console.log(JSON.stringify(row));
  }

  fs.writeFileSync('E:/temp/diagnose.json', JSON.stringify(lines, null, 2));
})();
