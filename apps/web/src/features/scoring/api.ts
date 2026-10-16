'use client';

import type { components } from '@bf/api-client';
import type {
  BusinessScoreList,
  ScoringExplainBatchResponse,
  ScoringPreviewSample,
  ScoringProfileConfig,
  ScoringProfileList,
  ScoringProfileSummary,
  ScoringProfileVersion,
  ScoringProfileVersionList,
  ScoringRecomputeResponse,
  ScoringVersionCreated,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Scoring data hooks (BF-032). Realtime `scoring.scores.updated` refreshes a business's scores; a finished bulk
// recompute refreshes everything scored (lib/realtime/invalidations.ts).

export function useScoringProfiles() {
  return useQuery({
    queryKey: queryKeys.scoring.profiles(),
    queryFn: async () => (await apiClient().GET('/v1/scoring/profiles')).data as ScoringProfileList,
    staleTime: 60_000,
  });
}

/** The workspace's primary profile (its score and tier fill the listing). */
export function usePrimaryProfile(): ScoringProfileSummary | undefined {
  return useScoringProfiles().data?.items.find((profile) => profile.primary);
}

export function useBusinessScores(businessId: string) {
  return useQuery({
    queryKey: queryKeys.business.scores(businessId),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}/scores', { params: { path: { id: businessId } } }))
        .data as BusinessScoreList,
  });
}

export function useRecomputeBusinessScores(businessId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (
        await apiClient().POST('/v1/businesses/{id}/scores/recompute', {
          params: { path: { id: businessId } },
        })
      ).data as BusinessScoreList,
    onSuccess: (data) => {
      client.setQueryData(queryKeys.business.scores(businessId), data);
      // The listing and the pipeline board show the primary profile's tier.
      void client.invalidateQueries({ queryKey: queryKeys.search.all });
      void client.invalidateQueries({ queryKey: queryKeys.crm.all });
    },
  });
}

// The profile editor (Settings → Scoring).

type ApiConfig = components['schemas']['ScoringProfileConfig'];

/**
 * A config for a request body. The contracts' gate conditions spell optional operators `?: T | undefined`, the
 * generated types `?: T` (exactOptionalPropertyTypes): the same JSON, and the editor only sends configs that passed
 * `ScoringProfileConfigSchema`.
 */
const toApiConfig = (config: ScoringProfileConfig): ApiConfig => config as unknown as ApiConfig;

export function useProfileVersions(profileId: string) {
  return useQuery({
    queryKey: queryKeys.scoring.versions(profileId),
    queryFn: async () =>
      (await apiClient().GET('/v1/scoring/profiles/{id}/versions', { params: { path: { id: profileId } } }))
        .data as ScoringProfileVersionList,
  });
}

export function useProfileVersion(profileId: string, version: number | null) {
  return useQuery({
    queryKey: queryKeys.scoring.version(profileId, version ?? 0),
    enabled: version !== null,
    // Versions never change.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () =>
      (
        await apiClient().GET('/v1/scoring/profiles/{id}/versions/{version}', {
          params: { path: { id: profileId, version: version ?? 0 } },
        })
      ).data as ScoringProfileVersion,
  });
}

/** The preview's businesses (stratified by tier) with their current score for the profile. */
export function usePreviewSample(profileId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.scoring.sample(profileId),
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      (await apiClient().GET('/v1/scoring/preview-sample', { params: { query: { profileId } } }))
        .data as ScoringPreviewSample,
  });
}

/** Scores the businesses with a config on the server, nothing stored: batches of 50, one after the other. */
export async function explainAll(
  config: ScoringProfileConfig,
  businessIds: readonly string[],
  signal?: AbortSignal,
): Promise<ScoringExplainBatchResponse['items']> {
  const items: ScoringExplainBatchResponse['items'] = [];
  for (let start = 0; start < businessIds.length; start += 50) {
    signal?.throwIfAborted();
    const { data } = await apiClient().POST('/v1/scoring/explain/batch', {
      body: { config: toApiConfig(config), businessIds: businessIds.slice(start, start + 50) },
      ...(signal ? { signal } : {}),
    });
    items.push(...(data as ScoringExplainBatchResponse).items);
  }
  return items;
}

/** Profile changes refresh the profiles (and their versions). */
function useInvalidateProfiles() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.scoring.all });
}

export function useCreateProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: async (body: { fromProfileId: string; name: string }) =>
      (await apiClient().POST('/v1/scoring/profiles', { body })).data as ScoringProfileSummary,
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; name?: string; archived?: boolean }) =>
      (await apiClient().PATCH('/v1/scoring/profiles/{id}', { params: { path: { id } }, body }))
        .data as ScoringProfileSummary,
    onSuccess: () => void invalidate(),
  });
}

export function useSaveVersion(profileId: string) {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: async (config: ScoringProfileConfig) =>
      (
        await apiClient().POST('/v1/scoring/profiles/{id}/versions', {
          params: { path: { id: profileId } },
          body: { config: toApiConfig(config) },
        })
      ).data as ScoringVersionCreated,
    onSuccess: () => void invalidate(),
  });
}

export function useActivateVersion(profileId: string) {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: async (version: number) =>
      (
        await apiClient().POST('/v1/scoring/profiles/{id}/activate', {
          params: { path: { id: profileId } },
          body: { version },
        })
      ).data as ScoringProfileSummary,
    onSuccess: () => void invalidate(),
  });
}

/** Makes a profile the workspace's primary one (the listing's score and tier); the workspace recomputes. */
export function useSetPrimaryProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (profileId: string) =>
      (await apiClient().PUT('/v1/scoring/primary-profile', { body: { profileId } }))
        .data as ScoringRecomputeResponse,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.scoring.all });
      void client.invalidateQueries({ queryKey: queryKeys.search.all });
      void client.invalidateQueries({ queryKey: queryKeys.crm.all });
    },
  });
}
