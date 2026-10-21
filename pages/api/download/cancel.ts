// pages/api/download/cancel.ts
//
// Stops a running download job. A batch can take many minutes, so the user
// needs a way to abandon one.
import type { NextApiRequest, NextApiResponse } from 'next';

import { cancelDownloadJob } from '../../../lib/download-jobs';

type ResponseData = { error: string } | { cancelled: boolean };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const jobId =
    typeof req.query.jobId === 'string'
      ? req.query.jobId
      : typeof req.body?.jobId === 'string'
        ? req.body.jobId
        : '';

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const cancelled = await cancelDownloadJob(jobId);
    return res.status(200).json({ cancelled });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cancel the download';
    return res.status(500).json({ error: message });
  }
}
