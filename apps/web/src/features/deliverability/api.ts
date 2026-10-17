'use client';

import type {
  DomainCheck,
  KillSwitch,
  MailboxHealthStats,
  MailboxReadiness,
  SetKillSwitchRequest,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Deliverability (BF-056): readiness and domain checks, mailbox health, the kill switch.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export interface DeliverabilityOverview {
  readonly killSwitch: KillSwitch;
  readonly blocklist: {
    readonly enabled: boolean;
    readonly sitesDomain: string;
    readonly listed: boolean | null;
  };
}

export function useDeliverabilityOverview() {
  return useQuery({
    queryKey: queryKeys.deliverability.overview(),
    queryFn: async () => unwrap<DeliverabilityOverview>(await apiClient().GET('/v1/deliverability/overview')),
    staleTime: 30_000,
  });
}

export function useReadiness() {
  return useQuery({
    queryKey: queryKeys.deliverability.readiness(),
    queryFn: async () =>
      unwrap<{ items: MailboxReadiness[] }>(await apiClient().GET('/v1/deliverability/mailboxes')).items,
  });
}

export function useMailboxHealth() {
  return useQuery({
    queryKey: queryKeys.deliverability.health(),
    queryFn: async () =>
      unwrap<{ items: MailboxHealthStats[] }>(await apiClient().GET('/v1/deliverability/health')).items,
  });
}

export function useDeliverabilityActions() {
  const client = useQueryClient();
  const settle = () => void client.invalidateQueries({ queryKey: ['deliverability'] });
  return {
    recheck: useMutation({
      mutationFn: async (mailboxId: string) =>
        unwrap<DomainCheck>(
          await apiClient().POST('/v1/deliverability/mailboxes/{id}/check', {
            params: { path: { id: mailboxId } },
          }),
        ),
      onSuccess: settle,
    }),
    override: useMutation({
      mutationFn: async ({ mailboxId, reason }: { mailboxId: string; reason: string }) => {
        const { error } = await apiClient().PUT('/v1/deliverability/mailboxes/{id}/override', {
          params: { path: { id: mailboxId } },
          body: { reason },
        });
        if (error) throw error;
      },
      onSuccess: settle,
    }),
    clearOverride: useMutation({
      mutationFn: async (mailboxId: string) => {
        const { error } = await apiClient().DELETE('/v1/deliverability/mailboxes/{id}/override', {
          params: { path: { id: mailboxId } },
        });
        if (error) throw error;
      },
      onSuccess: settle,
    }),
    killSwitch: useMutation({
      mutationFn: async (body: SetKillSwitchRequest) =>
        unwrap<KillSwitch>(await apiClient().PUT('/v1/deliverability/kill-switch', { body })),
      onSuccess: settle,
    }),
  };
}
