'use client';

import type {
  AnalyticsCohorts,
  AnalyticsFunnel,
  AnalyticsPeriodQuery,
  AnalyticsQuery,
  AnalyticsRegistry,
  AnalyticsResult,
  AnalyticsTrends,
} from '@bf/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Analytics (BF-058): the registry, the one query contract, the prebuilt funnel, cohorts and trends, and the CSV.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function useAnalyticsRegistry() {
  return useQuery({
    queryKey: queryKeys.analytics.registry(),
    queryFn: async () => unwrap<AnalyticsRegistry>(await apiClient().GET('/v1/analytics/registry')),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useAnalyticsQuery(query: AnalyticsQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.analytics.query(query),
    queryFn: async () =>
      unwrap<AnalyticsResult>(await apiClient().POST('/v1/analytics/query', { body: query as never })),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

export function useFunnel(query: AnalyticsPeriodQuery) {
  return useQuery({
    queryKey: queryKeys.analytics.funnel(query),
    queryFn: async () =>
      unwrap<AnalyticsFunnel>(
        await apiClient().GET('/v1/analytics/funnel', { params: { query: query as never } }),
      ),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useCohorts(query: AnalyticsPeriodQuery) {
  return useQuery({
    queryKey: queryKeys.analytics.cohorts(query),
    queryFn: async () =>
      unwrap<AnalyticsCohorts>(
        await apiClient().GET('/v1/analytics/cohorts', { params: { query: query as never } }),
      ),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useTrends(query: AnalyticsPeriodQuery) {
  return useQuery({
    queryKey: queryKeys.analytics.trends(query),
    queryFn: async () =>
      unwrap<AnalyticsTrends>(
        await apiClient().GET('/v1/analytics/trends', { params: { query: query as never } }),
      ),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Downloads the query as CSV (the same numbers as on screen). */
export async function downloadCsv(query: AnalyticsQuery, filename: string): Promise<void> {
  const { data, error } = await apiClient().POST('/v1/analytics/export.csv', {
    body: query as never,
    parseAs: 'blob',
  });
  if (error || !(data instanceof Blob)) throw error ?? new Error('No file');
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
