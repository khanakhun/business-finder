'use client';

import type {
  Enrollment,
  EnrollRequest,
  EnrollResult,
  SaveSequenceRequest,
  Sequence,
  SequenceStats,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Sequences (BF-053): definitions, enrollments and stats.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function useSequences() {
  return useQuery({
    queryKey: queryKeys.sequences.list(),
    queryFn: async () => unwrap<{ items: Sequence[] }>(await apiClient().GET('/v1/sequences')).items,
  });
}

export function useSequenceStats(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sequences.stats(id ?? ''),
    queryFn: async () =>
      unwrap<SequenceStats>(
        await apiClient().GET('/v1/sequences/{id}/stats', { params: { path: { id: id ?? '' } } }),
      ),
    enabled: id !== null,
  });
}

export function useEnrollments(businessId: string) {
  return useQuery({
    queryKey: queryKeys.sequences.enrollments(businessId),
    queryFn: async () =>
      unwrap<{ items: Enrollment[] }>(
        await apiClient().GET('/v1/enrollments', { params: { query: { businessId } } }),
      ).items,
  });
}

export function useSequenceActions() {
  const client = useQueryClient();
  const settle = () => void client.invalidateQueries({ queryKey: ['sequences'] });
  return {
    create: useMutation({
      mutationFn: async (body: SaveSequenceRequest) =>
        unwrap<Sequence>(await apiClient().POST('/v1/sequences', { body: body as never })),
      onSuccess: settle,
    }),
    update: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: SaveSequenceRequest }) =>
        unwrap<Sequence>(
          await apiClient().PUT('/v1/sequences/{id}', { params: { path: { id } }, body: body as never }),
        ),
      onSuccess: settle,
    }),
    activate: useMutation({
      mutationFn: async (id: string) =>
        unwrap<Sequence>(await apiClient().POST('/v1/sequences/{id}/activate', { params: { path: { id } } })),
      onSuccess: settle,
    }),
    archive: useMutation({
      mutationFn: async (id: string) =>
        unwrap<Sequence>(await apiClient().POST('/v1/sequences/{id}/archive', { params: { path: { id } } })),
      onSuccess: settle,
    }),
    starters: useMutation({
      mutationFn: async (locale: 'en' | 'fr') =>
        unwrap<{ items: Sequence[] }>(await apiClient().POST('/v1/sequences/starters', { body: { locale } }))
          .items,
      onSuccess: settle,
    }),
    enroll: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: EnrollRequest }) =>
        unwrap<EnrollResult>(
          await apiClient().POST('/v1/sequences/{id}/enroll', {
            params: { path: { id } },
            body: body as never,
          }),
        ),
      onSuccess: settle,
    }),
    pause: useMutation({
      mutationFn: async (id: string) =>
        unwrap<Enrollment>(
          await apiClient().POST('/v1/enrollments/{id}/pause', { params: { path: { id } } }),
        ),
      onSuccess: settle,
    }),
    resume: useMutation({
      mutationFn: async (id: string) =>
        unwrap<Enrollment>(
          await apiClient().POST('/v1/enrollments/{id}/resume', { params: { path: { id } } }),
        ),
      onSuccess: settle,
    }),
    stop: useMutation({
      mutationFn: async (id: string) =>
        unwrap<Enrollment>(await apiClient().POST('/v1/enrollments/{id}/stop', { params: { path: { id } } })),
      onSuccess: settle,
    }),
  };
}
