// pages/api/download/file.ts
//
// Streams a finished download job's file to the browser as an attachment.
// This is a normal HTTP response, so the browser saves it natively — no
// in-memory blob, so even a 200MB video is fine.
import type { NextApiRequest, NextApiResponse } from 'next';

import { streamJobFile } from '../../../lib/download-jobs';

type ResponseData = { error: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : '';

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const streamed = await streamJobFile(jobId, res);
    if (!streamed) {
      return res.status(404).json({ error: 'That download is not ready yet.' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send the file';
    if (!res.writableEnded) {
      return res.status(500).json({ error: message });
    }
  }
}
