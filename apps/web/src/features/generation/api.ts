'use client';

import type {
  BusinessSearchPage,
  CreateGenerationBatchRequest,
  GenerationArtifactList,
  GenerationBatchDetail,
  GenerationBatchPage,
  GenerationBriefPreview,
  GenerationEngineListing,
  GenerationJob,
  GenerationJobDetail,
  GenerationJobPage,
  GenerationJobQuality,
  GenerationJobWorkspace,
  SitePage,
} from '@bf/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { useRealtimeEvent } from '@/lib/realtime/provider.tsx';

// Data hooks of site generation (BF-046 on BF-039/BF-040/BF-045). The batch board follows `generation.job.updated` and
// `generation.batch.updated` from the workspace channel: their payload is the job or batch itself, written into the
// cache without a refetch.

const JOB_UPDATED = 'generation.job.updated';
const BATCH_UPDATED = 'generation.batch.updated';

export function useEngines() {
  return useQuery({
    queryKey: queryKeys.generation.engines(),
    queryFn: async () => (await apiClient().GET('/v1/generation/engines')).data as GenerationEngineListing,
    // Load changes as jobs run; a minute is fresh enough for the hints.
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useBatches(filters: Readonly<Record<string, string>> = {}) {
  const client = useQueryClient();
  const key = queryKeys.generation.batches(filters);
  useRealtimeEvent(BATCH_UPDATED, () => void client.invalidateQueries({ queryKey: key }));
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await apiClient().GET('/v1/generation-batches', {
          params: { query: { limit: 25, ...filters, ...(pageParam ? { cursor: pageParam } : {}) } as never },
        })
      ).data as GenerationBatchPage,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function useBatch(id: string) {
  const client = useQueryClient();
  const key = queryKeys.generation.batch(id);
  // A job of this batch moved: patch it in place (no refetch), and refetch when the job is new to us.
  useRealtimeEvent(JOB_UPDATED, (event) => {
    const job = event.payload as GenerationJob | null;
    if (!job || job.batchId !== id) return;
    let known = false;
    client.setQueryData<GenerationBatchDetail>(key, (batch) => {
      if (!batch) return batch;
      known = batch.jobs.some((candidate) => candidate.id === job.id);
      return { ...batch, jobs: batch.jobs.map((candidate) => (candidate.id === job.id ? job : candidate)) };
    });
    if (!known) void client.invalidateQueries({ queryKey: key });
  });
  useRealtimeEvent(BATCH_UPDATED, (event) => {
    if (event.entityId !== id) return;
    const batch = event.payload as Partial<GenerationBatchDetail> | null;
    client.setQueryData<GenerationBatchDetail>(key, (current) =>
      current && batch ? { ...current, ...batch, jobs: current.jobs } : current,
    );
  });
  return useQuery({
    queryKey: key,
    queryFn: async () =>
      (await apiClient().GET('/v1/generation-batches/{id}', { params: { path: { id } } }))
        .data as GenerationBatchDetail,
  });
}

/** The workspace's jobs, newest first (`status`, `businessId`); refreshed when any job moves. */
export function useJobs(filters: Readonly<Record<string, string>>, enabled = true) {
  const client = useQueryClient();
  const key = queryKeys.generation.jobs(filters);
  useRealtimeEvent(JOB_UPDATED, () => void client.invalidateQueries({ queryKey: key }));
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await apiClient().GET('/v1/generation-jobs', {
          params: { query: { limit: 25, ...filters, ...(pageParam ? { cursor: pageParam } : {}) } as never },
        })
      ).data as GenerationJobPage,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
  });
}

/** What a job's engine was given: brief, facts, assets (its latest workspace bundle). */
export function useJobWorkspace(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.generation.workspace(jobId),
    queryFn: async () =>
      (await apiClient().GET('/v1/generation-jobs/{id}/workspace', { params: { path: { id: jobId } } }))
        .data as GenerationJobWorkspace,
    enabled,
    staleTime: 60_000,
  });
}

/** A job's stored artifacts (`sites:admin`). */
export function useJobArtifacts(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.generation.artifacts(jobId),
    queryFn: async () =>
      (await apiClient().GET('/v1/generation-jobs/{id}/artifacts', { params: { path: { id: jobId } } }))
        .data as GenerationArtifactList,
    enabled,
  });
}

/** One job with its attempts, kept current by the workspace's realtime channel (its new state, no refetch). */
export function useJob(id: string) {
  const client = useQueryClient();
  const key = queryKeys.generation.job(id);
  useRealtimeEvent(JOB_UPDATED, (event) => {
    const job = event.payload as GenerationJob | null;
    if (!job || job.id !== id) return;
    const current = client.getQueryData<GenerationJobDetail>(key);
    // A new attempt started: its row comes from the API.
    if (!current || current.attemptCount !== job.attemptCount)
      void client.invalidateQueries({ queryKey: key });
    else client.setQueryData<GenerationJobDetail>(key, { ...current, ...job });
    // The report is written once the gates ran.
    if (job.qualityScore !== current?.qualityScore)
      void client.invalidateQueries({ queryKey: queryKeys.generation.quality(id) });
  });
  return useQuery({
    queryKey: key,
    queryFn: async () =>
      (await apiClient().GET('/v1/generation-jobs/{id}', { params: { path: { id } } }))
        .data as GenerationJobDetail,
  });
}

/** The businesses of a selection (at most 50, the batch limit), in the selection's order. */
export function useSelection(ids: readonly string[]) {
  return useQuery({
    queryKey: queryKeys.generation.selection(ids),
    queryFn: async () => {
      const page = (
        await apiClient().GET('/v1/businesses', {
          params: { query: { id: [...ids], limit: 50, includeClosed: 'true' } as never },
        })
      ).data as BusinessSearchPage;
      const byId = new Map<string, BusinessSearchPage['items'][number]>(
        page.items.map((item) => [item.id, item]),
      );
      return ids.flatMap((id) => byId.get(id) ?? []);
    },
    enabled: ids.length > 0,
  });
}

/** The business's latest site, if any (a generation then makes a new version of it). */
export function useBusinessSite(businessId: string) {
  return useQuery({
    queryKey: queryKeys.generation.businessSite(businessId),
    queryFn: async () =>
      (
        (await apiClient().GET('/v1/sites', { params: { query: { businessId, limit: 1 } as never } }))
          .data as SitePage
      ).items[0] ?? null,
    staleTime: 60_000,
  });
}

export function useBrief(businessId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.generation.brief(businessId),
    queryFn: async () =>
      (
        await apiClient().GET('/v1/businesses/{id}/generation-brief', {
          params: { path: { id: businessId } },
        })
      ).data as GenerationBriefPreview,
    enabled,
    staleTime: 60_000,
  });
}

/** A job's quality report (BF-045), once it has one. */
export function useQuality(jobId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.generation.quality(jobId),
    queryFn: async () =>
      (await apiClient().GET('/v1/generation-jobs/{id}/quality', { params: { path: { id: jobId } } }))
        .data as GenerationJobQuality,
    enabled,
  });
}

export function useCreateBatch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      body,
      idempotencyKey,
    }: {
      body: CreateGenerationBatchRequest;
      idempotencyKey: string;
    }) => {
      const { data, error } = await apiClient().POST('/v1/generation-batches', {
        // The contract's input type (defaults optional); the API validates it with the same schema.
        body: body as never,
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      if (error || !data) throw error ?? new Error('No batch');
      return data as GenerationBatchDetail;
    },
    onSuccess: (batch) => {
      client.setQueryData(queryKeys.generation.batch(batch.id), batch);
      void client.invalidateQueries({ queryKey: ['generation', 'batches'] });
    },
  });
}

/** The board's job actions; each refreshes the batch (realtime does it for everyone else). */
export function useJobActions(batchId: string) {
  const client = useQueryClient();
  const key = queryKeys.generation.batch(batchId);
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const run = <T>(request: () => Promise<{ error?: unknown; data?: T }>) =>
    request().then(({ error, data }) => {
      if (error) throw error;
      return data;
    });
  return {
    cancel: useMutation({
      mutationFn: (jobId: string) =>
        run(() => apiClient().POST('/v1/generation-jobs/{id}/cancel', { params: { path: { id: jobId } } })),
      onSettled: refresh,
    }),
    retry: useMutation({
      mutationFn: ({ jobId, engine }: { jobId: string; engine?: GenerationJob['engineCurrent'] }) =>
        run(() =>
          apiClient().POST('/v1/generation-jobs/{id}/retry', {
            params: { path: { id: jobId } },
            body: engine ? { engine } : {},
          }),
        ),
      onSettled: refresh,
    }),
    accept: useMutation({
      mutationFn: ({ jobId, reason }: { jobId: string; reason: string }) =>
        run(() =>
          apiClient().POST('/v1/generation-jobs/{id}/accept', {
            params: { path: { id: jobId } },
            body: { reason },
          }),
        ),
      onSettled: refresh,
    }),
    changeEngine: useMutation({
      mutationFn: ({ jobId, engine }: { jobId: string; engine: GenerationJob['engineRequested'] }) =>
        run(() =>
          apiClient().PATCH('/v1/generation-jobs/{id}', {
            params: { path: { id: jobId } },
            body: { engine },
          }),
        ),
      onSettled: refresh,
    }),
    reorder: useMutation({
      mutationFn: (jobIds: string[]) =>
        run(() => apiClient().POST('/v1/generation-jobs/reorder', { body: { batchId, jobIds } })),
      // Optimistic: the new order shows at once, and goes back if the server refuses it.
      onMutate: async (jobIds) => {
        await client.cancelQueries({ queryKey: key });
        const previous = client.getQueryData<GenerationBatchDetail>(key);
        client.setQueryData<GenerationBatchDetail>(key, (batch) => {
          if (!batch) return batch;
          const rank = new Map(jobIds.map((id, index) => [id, index]));
          const queued = batch.jobs
            .filter((job) => rank.has(job.id))
            .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
          let next = 0;
          return {
            ...batch,
            jobs: batch.jobs.map((job) => (rank.has(job.id) ? (queued[next++] as GenerationJob) : job)),
          };
        });
        return { previous };
      },
      onError: (_error, _ids, context) => {
        if (context?.previous) client.setQueryData(key, context.previous);
      },
      onSettled: refresh,
    }),
    cancelBatch: useMutation({
      mutationFn: () =>
        run(() =>
          apiClient().POST('/v1/generation-batches/{id}/cancel', { params: { path: { id: batchId } } }),
        ),
      onSettled: refresh,
    }),
  };
}
