// Diagnostic: call the current download API for both formats and report the
// status, headers, size and timing so we can see the real failure mode.
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:3101';

async function probe(label, params) {
  const url = `${BASE}/api/download?${params}`;
  const started = Date.now();

  try {
    const res = await fetch(url);
    const type = res.headers.get('content-type') || '';
    const body = Buffer.from(await res.arrayBuffer());

    const result = {
      label,
      status: res.status,
      contentType: type,
      disposition: res.headers.get('content-disposition'),
      contentLength: res.headers.get('content-length'),
      bytes: body.length,
      magic: body.slice(0, 3).toString('hex'),
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      bodyPreview: type.includes('json') ? body.toString('utf8').slice(0, 400) : undefined,
    };

    fs.appendFileSync('E:/temp/probe.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = { label, error: error.message, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
    fs.appendFileSync('E:/temp/probe.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  }
}

(async () => {
  fs.writeFileSync('E:/temp/probe.json', '');
  await probe('audio', `videoId=5lyb3mDBEW0&title=${encodeURIComponent('Altar Official Music Video')}&format=audio&mode=single`);
  await probe('video', `videoId=5lyb3mDBEW0&title=${encodeURIComponent('Altar Official Music Video')}&format=video&mode=single`);
})();
