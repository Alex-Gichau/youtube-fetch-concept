import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchSearchResults, type PlaylistResult } from '../../lib/youtube';

type ResponseData = { error: string } | PlaylistResult;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = req.query.query;

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const results = await fetchSearchResults(query, {
      limit: Number(req.query.limit) || 20,
    });

    return res.status(200).json(results);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch search results';
    return res.status(500).json({ error: message });
  }
}
