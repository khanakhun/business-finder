'use client';

import type {
  CreateDsrRequest,
  CurrentSuppression,
  DsrDiscovery,
  DsrRequest,
  ExecuteDsrRequest,
  ImportSuppressionsRequest,
  ImportSuppressionsResult,
  SuppressionEntry,
  SuppressionScope,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Compliance administration (BF-055): suppressions (current list, log, add, import, export, revoke), data-subject
// requests (create, verify, reject, discover, execute, download) and retention (policies, runs, dry run).

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export type SuppressionFilters = {
  q?: string | undefined;
  scope?: string | undefined;
  reason?: string | undefined;
  view: 'current' | 'log';
};

export function useSuppressions(filters: SuppressionFilters) {
  const query = Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Record<
    string,
    string
  >;
  return useQuery({
    queryKey: queryKeys.compliance.suppressions(query),
    queryFn: async () =>
      filters.view === 'log'
        ? {
            view: 'log' as const,
            items: unwrap<{ items: SuppressionEntry[] }>(
              await apiClient().GET('/v1/suppressions/log', { params: { query: query as never } }),
            ).items,
          }
        : {
            view: 'current' as const,
            items: unwrap<{ items: CurrentSuppression[] }>(
              await apiClient().GET('/v1/suppressions', { params: { query: query as never } }),
            ).items,
          },
  });
}

export function useSuppressionActions() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ['compliance', 'suppressions'] });
  return {
    add: useMutation({
      mutationFn: async (body: { scope: SuppressionScope; value: string; note?: string }) =>
        unwrap(await apiClient().POST('/v1/suppressions', { body: body as never })),
      onSuccess: refresh,
    }),
    import: useMutation({
      mutationFn: async (body: ImportSuppressionsRequest) =>
        unwrap<ImportSuppressionsResult>(
          await apiClient().POST('/v1/suppressions/import', { body: body as never }),
        ),
      onSuccess: (result) => (result.dryRun ? undefined : refresh()),
    }),
    revoke: useMutation({
      mutationFn: async ({
        id,
        note,
        consentEvidence,
      }: {
        id: string;
        note: string;
        consentEvidence?: string;
      }) =>
        unwrap(
          await apiClient().POST('/v1/suppressions/{id}/revoke', {
            params: { path: { id } },
            body: { note, ...(consentEvidence ? { consentEvidence } : {}) } as never,
          }),
        ),
      onSuccess: refresh,
    }),
  };
}

export function useDsrRequests() {
  return useQuery({
    queryKey: queryKeys.compliance.requests(),
    queryFn: async () => unwrap<{ items: DsrRequest[] }>(await apiClient().GET('/v1/compliance/dsr')).items,
  });
}

export function useDsrActions() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: queryKeys.compliance.requests() });
  const post =
    (path: string) =>
    async ({ id, body }: { id: string; body?: unknown }) =>
      unwrap<DsrRequest>(
        await apiClient().POST(
          path as never,
          { params: { path: { id } }, body: (body ?? {}) as never } as never,
        ),
      );
  return {
    create: useMutation({
      mutationFn: async (body: CreateDsrRequest) =>
        unwrap<DsrRequest>(await apiClient().POST('/v1/compliance/dsr', { body: body as never })),
      onSuccess: refresh,
    }),
    verify: useMutation({ mutationFn: post('/v1/compliance/dsr/{id}/verify'), onSuccess: refresh }),
    reject: useMutation({ mutationFn: post('/v1/compliance/dsr/{id}/reject'), onSuccess: refresh }),
    execute: useMutation({
      mutationFn: ({ id, body }: { id: string; body: ExecuteDsrRequest }) =>
        post('/v1/compliance/dsr/{id}/execute')({ id, body }),
      onSuccess: refresh,
    }),
    discover: useMutation({
      mutationFn: async (id: string) =>
        unwrap<DsrDiscovery>(
          await apiClient().POST('/v1/compliance/dsr/{id}/discover', { params: { path: { id } } }),
        ),
      onSuccess: refresh,
    }),
  };
}

export function useRetention() {
  const client = useQueryClient();
  return {
    overview: useQuery({
      queryKey: queryKeys.compliance.retention(),
      queryFn: async () =>
        unwrap<{
          policies: {
            id: string;
            entity: string;
            description: string;
            retentionDays: number;
            action: string;
          }[];
          runs: {
            id: string;
            dryRun: boolean;
            startedAt: string;
            finishedAt: string | null;
            results: { policy: string; count: number; durationMs: number; error: string | null }[];
          }[];
        }>(await apiClient().GET('/v1/compliance/retention')),
    }),
    dryRun: useMutation({
      mutationFn: async () => unwrap(await apiClient().POST('/v1/compliance/retention/dry-run')),
      onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.compliance.retention() }),
    }),
  };
}
