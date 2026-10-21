// pages/api/download/status.ts
//
// Reports the live state of a download job. The UI polls this while a job runs.
import type { NextApiRequest, NextApiResponse } from 'next';

import { getDownloadJob } from '../../../lib/download-jobs';

type ResponseData = { error: string } | Record<string, unknown>;

export default function handler(
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

  const job = getDownloadJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'That download job is no longer available.' });
  }

  return res.status(200).json(job as unknown as Record<string, unknown>);
}
