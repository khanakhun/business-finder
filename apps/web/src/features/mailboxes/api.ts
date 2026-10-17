'use client';

import type {
  ConnectSmtpMailboxRequest,
  Mailbox,
  MailboxDetail,
  MailboxTestResult,
  OAuthMailboxProvider,
  UpdateMailboxRequest,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Mailboxes (BF-050): the workspace's sending mailboxes, connecting them (SMTP/IMAP form, Google and Microsoft
// consent), their settings, pause/resume, a test send and disconnect.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function useMailboxes() {
  return useQuery({
    queryKey: queryKeys.mailboxes.list(),
    queryFn: async () => unwrap<{ items: Mailbox[] }>(await apiClient().GET('/v1/mailboxes')).items,
    refetchInterval: 60_000,
  });
}

export function useMailbox(id: string | null) {
  return useQuery({
    queryKey: queryKeys.mailboxes.detail(id ?? ''),
    queryFn: async () =>
      unwrap<MailboxDetail>(
        await apiClient().GET('/v1/mailboxes/{id}', { params: { path: { id: id ?? '' } } }),
      ),
    enabled: id !== null,
  });
}

export function useOAuthProviders() {
  return useQuery({
    queryKey: queryKeys.mailboxes.providers(),
    queryFn: async () =>
      unwrap<{ google: boolean; microsoft: boolean }>(await apiClient().GET('/v1/mailboxes/oauth/providers')),
    staleTime: 5 * 60_000,
  });
}

export function useMailboxActions() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ['mailboxes'] });
  return {
    connectSmtp: useMutation({
      mutationFn: async (body: ConnectSmtpMailboxRequest) =>
        unwrap<Mailbox>(await apiClient().POST('/v1/mailboxes', { body: body as never })),
      onSuccess: refresh,
    }),
    startOAuth: useMutation({
      mutationFn: async (input: { provider: OAuthMailboxProvider; shared?: boolean; mailboxId?: string }) =>
        unwrap<{ url: string }>(
          await apiClient().GET('/v1/mailboxes/oauth/{provider}/start', {
            params: {
              path: { provider: input.provider },
              query: {
                ...(input.shared ? { shared: 'true' } : {}),
                ...(input.mailboxId ? { mailboxId: input.mailboxId } : {}),
              } as never,
            },
          }),
        ),
    }),
    update: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: UpdateMailboxRequest }) =>
        unwrap<Mailbox>(
          await apiClient().PATCH('/v1/mailboxes/{id}', { params: { path: { id } }, body: body as never }),
        ),
      onSuccess: refresh,
    }),
    pause: useMutation({
      mutationFn: async (id: string) =>
        unwrap<Mailbox>(
          await apiClient().POST('/v1/mailboxes/{id}/pause', { params: { path: { id } }, body: {} as never }),
        ),
      onSuccess: refresh,
    }),
    resume: useMutation({
      mutationFn: async (id: string) =>
        unwrap<Mailbox>(await apiClient().POST('/v1/mailboxes/{id}/resume', { params: { path: { id } } })),
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: async (id: string) =>
        unwrap<MailboxTestResult>(
          await apiClient().POST('/v1/mailboxes/{id}/test', { params: { path: { id } } }),
        ),
      onSuccess: refresh,
    }),
    disconnect: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await apiClient().DELETE('/v1/mailboxes/{id}', { params: { path: { id } } });
        if (error) throw error;
      },
      onSuccess: refresh,
    }),
  };
}
