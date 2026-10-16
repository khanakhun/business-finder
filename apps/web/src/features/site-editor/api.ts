'use client';

import { ApiError } from '@bf/api-client';
import type {
  CreateSiteAssetUploadRequest,
  SiteAsset,
  SiteAssetCandidate,
  SiteAssetGeneration,
  SiteAssetList,
  SiteAssetSources,
  SiteAssetSuggestions,
  SiteAssetUpload,
  SiteDetail,
  SitePublication,
  SiteVersion,
  SiteVersionDiff,
  SiteVersionPage,
} from '@bf/contracts';
import { type BaseOperation, MAX_BATCH, type SiteSpec } from '@bf/site-schema';
import { apiClient } from '@/lib/api.ts';

// The editor's calls (BF-037): every save is a new immutable version through the sites module (BF-035), from the
// version the editor started on; the API refuses it (409) when someone saved in between.

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
    // The API takes one batch of operations per save (the BF-033 limit); past it, the whole spec.
    if (input.operations.length <= MAX_BATCH) {
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

/** Saves a whole spec as one version (the admins' JSON mode). Throws `VersionConflict` on a concurrent save. */
export async function saveSpec(input: {
  readonly siteId: string;
  readonly baseVersionId: string;
  readonly spec: unknown;
  readonly changeSummary?: string;
}): Promise<SiteVersion> {
  try {
    const { data } = await apiClient().POST('/v1/sites/{id}/versions', {
      params: { path: { id: input.siteId } },
      body: {
        spec: input.spec as Record<string, unknown>,
        baseVersionId: input.baseVersionId,
        ...(input.changeSummary ? { changeSummary: input.changeSummary } : {}),
      },
    });
    return data as SiteVersion;
  } catch (error) {
    throw conflictOf(error) ?? error;
  }
}

/** The site: its publications and views (the publish button's state). */
export async function fetchSite(siteId: string): Promise<SiteDetail> {
  const { data } = await apiClient().GET('/v1/sites/{id}', { params: { path: { id: siteId } } });
  return data as SiteDetail;
}

/** A page of the site's versions, newest first. */
export async function fetchVersions(siteId: string, cursor?: string): Promise<SiteVersionPage> {
  const { data } = await apiClient().GET('/v1/sites/{id}/versions', {
    params: { path: { id: siteId }, query: { limit: 50, ...(cursor ? { cursor } : {}) } },
  });
  return data as SiteVersionPage;
}

/** What changed from one version to another. */
export async function fetchDiff(siteId: string, from: string, to: string): Promise<SiteVersionDiff> {
  const { data } = await apiClient().GET('/v1/sites/{id}/diff', {
    params: { path: { id: siteId }, query: { from, to } },
  });
  return data as SiteVersionDiff;
}

/** Makes an earlier version's content current again, as a new version. */
export async function restoreVersion(input: {
  readonly siteId: string;
  readonly versionId: string;
  readonly baseVersionId: string;
}): Promise<SiteVersion> {
  try {
    const { data } = await apiClient().POST('/v1/sites/{id}/rollback', {
      params: { path: { id: input.siteId } },
      body: { versionId: input.versionId, baseVersionId: input.baseVersionId },
    });
    return data as SiteVersion;
  } catch (error) {
    throw conflictOf(error) ?? error;
  }
}

export async function publishPreview(
  siteId: string,
  versionId: string,
  expiresInDays: number,
): Promise<SitePublication> {
  const { data } = await apiClient().POST('/v1/sites/{id}/preview', {
    params: { path: { id: siteId } },
    body: { versionId, expiresInDays },
  });
  return data as SitePublication;
}

export async function extendPreview(siteId: string, days: number): Promise<SitePublication> {
  const { data } = await apiClient().POST('/v1/sites/{id}/preview/extend', {
    params: { path: { id: siteId } },
    body: { days },
  });
  return data as SitePublication;
}

export async function unpublishPreview(siteId: string): Promise<void> {
  await apiClient().POST('/v1/sites/{id}/unpublish', {
    params: { path: { id: siteId } },
    body: { environment: 'preview' },
  });
}

/** The site's uploaded and collected images, newest first. */
export async function fetchAssets(siteId: string): Promise<readonly SiteAsset[]> {
  const { data } = await apiClient().GET('/v1/sites/{id}/assets', { params: { path: { id: siteId } } });
  return (data as SiteAssetList).items;
}

/**
 * Uploads an image: a pending asset and a presigned URL from the API, the bytes PUT there, then finalized (the API
 * checks the bytes and queues the variants). Returns the asset as finalized (usually still `processing`).
 */
export async function uploadAsset(
  siteId: string,
  file: Blob,
  request: {
    readonly license: CreateSiteAssetUploadRequest['license'];
    readonly alt?: Record<string, string>;
    readonly licenseDetails?: {
      author?: string;
      sourceUrl?: string;
      attributionText?: string;
      provider?: string;
    };
  },
  signal?: AbortSignal,
): Promise<SiteAsset> {
  const { data } = await apiClient().POST('/v1/sites/{id}/assets', {
    params: { path: { id: siteId } },
    body: {
      license: request.license,
      ...(request.alt ? { alt: request.alt } : {}),
      ...(request.licenseDetails ? { licenseDetails: request.licenseDetails } : {}),
      mime: file.type as CreateSiteAssetUploadRequest['mime'],
      bytes: file.size,
    },
  });
  const upload = data as SiteAssetUpload;
  const put = await fetch(upload.uploadUrl, {
    method: upload.method,
    headers: upload.headers,
    body: file,
    ...(signal ? { signal } : {}),
  });
  if (!put.ok) throw new Error(`Upload refused (${put.status})`);
  const finalized = await apiClient().POST('/v1/sites/{id}/assets/{assetId}/finalize', {
    params: { path: { id: siteId, assetId: upload.asset.id } },
  });
  return finalized.data as SiteAsset;
}

/** The configured stock providers and today's AI images (the picker's "Find more images" tab, BF-038). */
export async function fetchAssetSources(siteId: string): Promise<SiteAssetSources> {
  const { data } = await apiClient().GET('/v1/sites/{id}/asset-sources', {
    params: { path: { id: siteId } },
  });
  return data as SiteAssetSources;
}

/** Stock photos for a query (credited candidates, not yet in the library). */
export async function searchStock(siteId: string, q: string): Promise<readonly SiteAssetCandidate[]> {
  const { data } = await apiClient().GET('/v1/sites/{id}/asset-suggestions', {
    params: { path: { id: siteId }, query: { role: 'gallery', source: 'stock', q } },
  });
  return (data as SiteAssetSuggestions).items;
}

/** Brings a stock candidate into the library (hotlinked or copied, credited). */
export async function importStock(siteId: string, candidateId: string): Promise<SiteAsset> {
  const { data } = await apiClient().POST('/v1/sites/{id}/assets/import', {
    params: { path: { id: siteId } },
    body: { candidateId },
  });
  return data as SiteAsset;
}

/** Queues illustrative AI images; they arrive in the library once generated, processed and checked. */
export async function generateImages(
  siteId: string,
  body: { prompt: string; aspect: '16:9' | '4:3' | '1:1' | '3:4'; count: number },
): Promise<SiteAssetGeneration> {
  const { data } = await apiClient().POST('/v1/sites/{id}/assets/generate', {
    params: { path: { id: siteId } },
    body,
  });
  return data as SiteAssetGeneration;
}
