'use client';

import type {
  EmailDraft,
  EmailLocale,
  InboundMessage,
  InboxThreadDetail,
  InboxThreadList,
  TriageClass,
  UpdateInboundRequest,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// The unified inbox (BF-054).

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export interface InboxFilters {
  readonly class?: string;
  readonly mailboxId?: string;
  readonly unread?: string;
  readonly needsHuman?: string;
  readonly assignedToMe?: string;
  readonly q?: string;
}

export function useInbox(filters: InboxFilters) {
  const query = Object.fromEntries(Object.entries(filters).filter(([, value]) => !!value)) as Record<
    string,
    string
  >;
  return useQuery({
    queryKey: queryKeys.inbox.list(query),
    queryFn: async () =>
      unwrap<InboxThreadList>(await apiClient().GET('/v1/inbox', { params: { query: query as never } })),
  });
}

export function useInboxThread(threadId: string | null) {
  return useQuery({
    queryKey: queryKeys.inbox.thread(threadId ?? ''),
    queryFn: async () =>
      unwrap<InboxThreadDetail>(
        await apiClient().GET('/v1/inbox/threads/{threadId}', {
          params: { path: { threadId: threadId ?? '' } },
        }),
      ),
    enabled: threadId !== null,
  });
}

export function useInboxActions() {
  const client = useQueryClient();
  const settle = (message: InboundMessage) => {
    void client.invalidateQueries({ queryKey: ['inbox', 'list'] });
    void client.invalidateQueries({ queryKey: queryKeys.inbox.thread(message.threadId) });
  };
  return {
    update: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: UpdateInboundRequest }) =>
        unwrap<InboundMessage>(
          await apiClient().PATCH('/v1/inbox/messages/{id}', {
            params: { path: { id } },
            body: body as never,
          }),
        ),
      onSuccess: settle,
    }),
    correct: useMutation({
      mutationFn: async ({ id, triageClass }: { id: string; triageClass: TriageClass }) =>
        unwrap<InboundMessage>(
          await apiClient().POST('/v1/inbox/messages/{id}/triage', {
            params: { path: { id } },
            body: { class: triageClass },
          }),
        ),
      onSuccess: settle,
    }),
    suggest: useMutation({
      mutationFn: async ({ id, locale }: { id: string; locale?: EmailLocale }) =>
        unwrap<EmailDraft>(
          await apiClient().POST('/v1/inbox/messages/{id}/suggest-reply', {
            params: { path: { id } },
            body: (locale ? { locale } : {}) as never,
          }),
        ),
    }),
  };
}
