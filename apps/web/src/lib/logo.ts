'use client';

import { networkError, toApiError } from '@bf/api-client';

const apiUrl = () => process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The workspace logo image (fetched with the session cookie), or null when the workspace has none. Display it
 * through an object URL owned by the component (`img-src` allows `blob:`).
 */
export async function fetchLogo(): Promise<Blob | null> {
  const response = await fetch(`${apiUrl()}/v1/workspace/logo`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null));
  return response.blob();
}

/** Raw image upload (`PUT /v1/workspace/logo`); throws ApiError like the typed client. */
export async function uploadLogo(file: File): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl()}/v1/workspace/logo`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': file.type },
      body: file,
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null));
}
