'use client';

import { toApiError } from '@bf/api-client';
import { publicEnv } from '@/lib/public-env.ts';

/**
 * A graded screenshot of a job's quality report (fetched with the session cookie). Shown through an object URL
 * owned by the component: the dashboard's `img-src` allows `blob:`, not the API's origin.
 */
export async function fetchScreenshot(jobId: string, index: number): Promise<Blob> {
  const response = await fetch(
    `${publicEnv().apiUrl}/v1/generation-jobs/${jobId}/quality/screenshots/${index}`,
    { credentials: 'include' },
  );
  if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null));
  return response.blob();
}
