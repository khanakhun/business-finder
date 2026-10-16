'use client';

import { ApiError } from '@bf/api-client';
import type { SiteVersion } from '@bf/contracts';
import type { BaseOperation, SiteSpec } from '@bf/site-schema';
import { apiClient } from '@/lib/api.ts';

// The editor's calls (BF-037): every save is a new immutable version through the sites module (BF-035), from the
// version the editor started on; the API refuses it (409) when someone saved in between.

/** The API takes at most this many operations in one save (the BF-033 batch limit). */
export const MAX_OPERATIONS = 200;

/** Someone saved the site since the editor loaded it. */
export class VersionConflict extends Error {
  override readonly name = 'VersionConflict';
  constructor(readonly currentVersionId: string | null) {
    super('The site was saved elsewhere meanwhile.');
  }
}

function conflictOf(error: unknown): VersionConflict | undefined {
  if (!(error instanceof ApiError) || error.code !== 'SITE_VERSION_CONFLICT') return undefined;
  const current = (error.problem as { currentVersionId?: unknown }).currentVersionId;
  return new VersionConflict(typeof current === 'string' ? current : null);
}

/**
 * Saves the edits as one version: as operations (a readable change summary, the usual path), or the whole spec
 * when there are more than one batch holds. Throws `VersionConflict` on a concurrent save, `ApiError` otherwise.
 */
export async function saveSite(input: {
  readonly siteId: string;
  readonly baseVersionId: string;
  readonly operations: readonly BaseOperation[];
  readonly spec: SiteSpec;
}): Promise<SiteVersion> {
  try {
    if (input.operations.length <= MAX_OPERATIONS) {
      const { data } = await apiClient().POST('/v1/sites/{id}/operations', {
        params: { path: { id: input.siteId } },
        body: {
          operations: [...input.operations] as Record<string, unknown>[],
          baseVersionId: input.baseVersionId,
        },
      });
      return data as SiteVersion;
    }
    const { data } = await apiClient().POST('/v1/sites/{id}/versions', {
      params: { path: { id: input.siteId } },
      body: { spec: input.spec as unknown as Record<string, unknown>, baseVersionId: input.baseVersionId },
    });
    return data as SiteVersion;
  } catch (error) {
    throw conflictOf(error) ?? error;
  }
}

/** A version of the site (the latest one, after a conflict). */
export async function fetchVersion(siteId: string, versionId: string): Promise<SiteVersion> {
  const { data } = await apiClient().GET('/v1/sites/{id}/versions/{versionId}', {
    params: { path: { id: siteId, versionId } },
  });
  return data as SiteVersion;
}
