import NextCors from 'nextjs-cors';

export default async function handler(req, res) {
  await NextCors(req, res, {
    methods: ['GET', 'POST', 'OPTIONS'],
    origin: '*',
  });
  res.status(200).json({ ok: true });
}
