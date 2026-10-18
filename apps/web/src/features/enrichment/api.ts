'use client';

import type {
  BulkEnrichResponse,
  BusinessEnrichment,
  BusinessWebsiteAudit,
  EnrichmentEstimate,
  EnrichmentRun,
  EnrichmentStepId,
  WebsiteSnapshot,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Enrichment data hooks (BF-027). Realtime `enrichment.run.progressed` events refresh them while a run moves
// (lib/realtime/invalidations.ts): no polling.

export function useBusinessEnrichment(id: string) {
  return useQuery({
    queryKey: queryKeys.business.enrichment(id),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}/enrichment', { params: { path: { id } } }))
        .data as BusinessEnrichment,
  });
}

/** The latest website snapshot, or null before the first crawl. */
export function useWebsite(id: string) {
  return useQuery({
    queryKey: queryKeys.business.website(id),
    queryFn: async (): Promise<WebsiteSnapshot | null> =>
      (
        (await apiClient().GET('/v1/businesses/{id}/website', { params: { path: { id } } })).data as {
          snapshot: WebsiteSnapshot | null;
        }
      ).snapshot,
  });
}

/** The audit of the latest crawl (BF-030), or null before the first one. */
export function useWebsiteAudit(id: string) {
  return useQuery({
    queryKey: queryKeys.business.websiteAudit(id),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}/website-audit', { params: { path: { id } } }))
        .data as BusinessWebsiteAudit,
  });
}

export function useEnrich(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, ...body }: { steps?: EnrichmentStepId[]; force: boolean; key: string }) =>
      (
        await apiClient().POST('/v1/businesses/{id}/enrich', {
          params: { path: { id } },
          body,
          headers: { 'Idempotency-Key': key },
        })
      ).data as EnrichmentRun,
    onSettled: () => client.invalidateQueries({ queryKey: ['business', id] }),
  });
}

export function useCancelRun(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) =>
      (await apiClient().POST('/v1/enrichment/runs/{id}/cancel', { params: { path: { id: runId } } }))
        .data as EnrichmentRun,
    onSettled: () => client.invalidateQueries({ queryKey: ['business', id] }),
  });
}

export function useEnrichmentEstimate(businessIds: readonly string[]) {
  return useQuery({
    queryKey: ['enrichment', 'estimate', [...businessIds].sort()],
    queryFn: async () =>
      (
        await apiClient().POST('/v1/enrichment/estimate', {
          body: { businessIds: [...businessIds], force: false },
        })
      ).data as EnrichmentEstimate,
    enabled: businessIds.length > 0,
  });
}

/** `key`: one per user action (the dialog's), so a retried request starts nothing twice. */
export async function enrichMany(businessIds: readonly string[], key: string): Promise<BulkEnrichResponse> {
  return (
    await apiClient().POST('/v1/enrichment/bulk', {
      body: { businessIds: [...businessIds], force: false },
      headers: { 'Idempotency-Key': key },
    })
  ).data as BulkEnrichResponse;
}

/** Starts an enrichment of every registered step (the business page's quick action). */
export async function enrichNow(id: string): Promise<EnrichmentRun> {
  return (
    await apiClient().POST('/v1/businesses/{id}/enrich', {
      params: { path: { id } },
      body: { force: false },
      headers: { 'Idempotency-Key': `enrich-${crypto.randomUUID()}` },
    })
  ).data as EnrichmentRun;
}
