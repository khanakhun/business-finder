'use client';

import type {
  ComplianceDecision,
  EffectivePolicy,
  LawfulBasisRecord,
  OutreachChannel,
  PolicyDocument,
  PolicyOverrideResult,
  PolicyVersion,
  ReviewPolicyRequest,
  UpsertLawfulBasisRequest,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Compliance data (BF-049): the effective policies, their versions, review and overrides, lawful-basis records, and a
// business's evaluation and decisions.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function usePolicies() {
  return useQuery({
    queryKey: queryKeys.compliance.policies(),
    queryFn: async () =>
      unwrap<{ items: EffectivePolicy[] }>(await apiClient().GET('/v1/compliance/policies')).items,
  });
}

export function useVersions(jurisdiction: string, channel: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.compliance.versions(jurisdiction, channel),
    queryFn: async () =>
      unwrap<{ items: PolicyVersion[] }>(
        await apiClient().GET('/v1/compliance/policies/{jurisdiction}/{channel}/versions', {
          params: { path: { jurisdiction, channel } },
        }),
      ).items,
    enabled,
  });
}

export function useReviewPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: ReviewPolicyRequest }) =>
      unwrap<PolicyVersion>(
        await apiClient().POST('/v1/compliance/policies/{id}/review', {
          params: { path: { id } },
          body: body as never,
        }),
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['compliance'] }),
  });
}

export function useOverridePolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      jurisdiction: string;
      channel: OutreachChannel;
      policy: PolicyDocument;
      note?: string;
    }) =>
      unwrap<PolicyOverrideResult>(
        await apiClient().POST('/v1/compliance/overrides', { body: body as never }),
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['compliance'] }),
  });
}

export function useLawfulBasis() {
  return useQuery({
    queryKey: queryKeys.compliance.lawfulBasis(),
    queryFn: async () =>
      unwrap<{ items: LawfulBasisRecord[] }>(await apiClient().GET('/v1/compliance/lawful-basis')).items,
  });
}

export function useLawfulBasisActions() {
  const client = useQueryClient();
  const locale = useLocale();
  const refresh = () => void client.invalidateQueries({ queryKey: queryKeys.compliance.lawfulBasis() });
  return {
    fromTemplate: useMutation({
      mutationFn: async () =>
        unwrap<LawfulBasisRecord>(
          await apiClient().POST('/v1/compliance/lawful-basis/from-template', {
            headers: { 'Accept-Language': locale },
          }),
        ),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: UpsertLawfulBasisRequest }) =>
        unwrap<LawfulBasisRecord>(
          await apiClient().PATCH('/v1/compliance/lawful-basis/{id}', {
            params: { path: { id } },
            body: body as never,
          }),
        ),
      onSuccess: refresh,
    }),
    approve: useMutation({
      mutationFn: async (id: string) =>
        unwrap<LawfulBasisRecord>(
          await apiClient().POST('/v1/compliance/lawful-basis/{id}/approve', { params: { path: { id } } }),
        ),
      onSuccess: refresh,
    }),
    retire: useMutation({
      mutationFn: async (id: string) =>
        unwrap<LawfulBasisRecord>(
          await apiClient().POST('/v1/compliance/lawful-basis/{id}/retire', { params: { path: { id } } }),
        ),
      onSuccess: refresh,
    }),
  };
}

export function useEvaluation(
  businessId: string,
  channel: OutreachChannel,
  purpose: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.compliance.evaluation(businessId, channel, purpose),
    queryFn: async () =>
      unwrap<ComplianceDecision>(
        await apiClient().POST('/v1/compliance/evaluate', {
          body: { businessId, channel, purpose } as never,
        }),
      ),
    enabled,
    staleTime: 60_000,
  });
}

export function useDecisions(businessId: string) {
  return useQuery({
    queryKey: queryKeys.compliance.decisions(businessId),
    queryFn: async () =>
      unwrap<{ items: ComplianceDecision[] }>(
        await apiClient().GET('/v1/compliance/decisions', { params: { query: { businessId } } }),
      ).items,
  });
}
