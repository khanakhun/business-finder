'use client';

import type { LeadCounts, SiteLead, SiteLeadPage, UpdateLeadRequest } from '@bf/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { useRealtimeEvent } from '@/lib/realtime/provider.tsx';

// The leads inbox's data (BF-048): leads by filters, one lead, the waiting count; kept current by the workspace's
// realtime channel (`lead.created`, `lead.updated`).

function useLeadEvents() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ['leads'] });
  useRealtimeEvent('lead.created', refresh);
  useRealtimeEvent('lead.updated', refresh);
}

export function useLeads(filters: Readonly<Record<string, string>>) {
  useLeadEvents();
  return useInfiniteQuery({
    queryKey: queryKeys.leads.list(filters),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await apiClient().GET('/v1/leads', {
          params: { query: { limit: 50, ...filters, ...(pageParam ? { cursor: pageParam } : {}) } as never },
        })
      ).data as SiteLeadPage,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function useLead(id: string | null) {
  return useQuery({
    queryKey: queryKeys.leads.detail(id ?? 'none'),
    queryFn: async () =>
      (await apiClient().GET('/v1/leads/{id}', { params: { path: { id: id as string } } })).data as SiteLead,
    enabled: id !== null,
  });
}

export function useLeadCounts(enabled: boolean) {
  useLeadEvents();
  return useQuery({
    queryKey: queryKeys.leads.counts(),
    queryFn: async () => (await apiClient().GET('/v1/leads/counts')).data as LeadCounts,
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdateLead(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateLeadRequest) => {
      const { data, error } = await apiClient().PATCH('/v1/leads/{id}', {
        params: { path: { id } },
        body: body as never,
      });
      if (error || !data) throw error ?? new Error('Not saved');
      return data as SiteLead;
    },
    onSuccess: (lead) => {
      client.setQueryData(queryKeys.leads.detail(id), lead);
      void client.invalidateQueries({ queryKey: ['leads', 'list'] });
      void client.invalidateQueries({ queryKey: queryKeys.leads.counts() });
    },
  });
}
