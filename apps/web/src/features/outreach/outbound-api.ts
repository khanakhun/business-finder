'use client';

import type {
  ApproveBulkRequest,
  BulkActionResult,
  BulkRun,
  BulkRunDetail,
  ManualContactLog,
  ManualLogRequest,
  OutboundMessage,
  OutboundMessageList,
  OutboundMessageSummary,
  SendMessageRequest,
  StartBulkRequest,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// The outbound pipeline (BF-052): one-click send with undo, the outbox, manual contact logs, bulk runs and approvals.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export interface OutboxFilters {
  readonly status?: string;
  readonly mailboxId?: string;
  readonly businessId?: string;
}

export function useOutbox(filters: OutboxFilters) {
  const query = Object.fromEntries(Object.entries(filters).filter(([, value]) => !!value)) as Record<
    string,
    string
  >;
  return useQuery({
    queryKey: queryKeys.outreach.messages(query),
    queryFn: async () =>
      unwrap<OutboundMessageList>(
        await apiClient().GET('/v1/outreach/messages', {
          params: { query: { ...query, limit: 100 } as never },
        }),
      ),
  });
}

export function useOutboundMessage(id: string | null) {
  return useQuery({
    queryKey: queryKeys.outreach.message(id ?? ''),
    queryFn: async () =>
      unwrap<OutboundMessage>(
        await apiClient().GET('/v1/outreach/messages/{id}', { params: { path: { id: id ?? '' } } }),
      ),
    enabled: id !== null,
  });
}

export function useOutreachHistory(businessId: string) {
  return useQuery({
    queryKey: queryKeys.outreach.history(businessId),
    queryFn: async () =>
      unwrap<{ messages: OutboundMessageSummary[]; manual: ManualContactLog[] }>(
        await apiClient().GET('/v1/outreach/history', { params: { query: { businessId } } }),
      ),
  });
}

export function useMessageActions() {
  const client = useQueryClient();
  const settle = (message: OutboundMessage) => {
    client.setQueryData(queryKeys.outreach.message(message.id), message);
    void client.invalidateQueries({ queryKey: ['outreach', 'messages'] });
    void client.invalidateQueries({ queryKey: queryKeys.outreach.history(message.businessId) });
    void client.invalidateQueries({ queryKey: ['outreach', 'bulk-run'] });
  };
  const post = async (
    path:
      | '/v1/outreach/messages/{id}/cancel'
      | '/v1/outreach/messages/{id}/retry'
      | '/v1/outreach/messages/{id}/approve',
    id: string,
  ) => unwrap<OutboundMessage>(await apiClient().POST(path, { params: { path: { id } } }));
  return {
    /** One click: the key makes a double click (or a retried request) send once. */
    send: useMutation({
      mutationFn: async ({ body, key }: { body: SendMessageRequest; key: string }) =>
        unwrap<OutboundMessage>(
          await apiClient().POST('/v1/outreach/messages', {
            body: body as never,
            headers: { 'Idempotency-Key': key },
          }),
        ),
      onSuccess: settle,
    }),
    cancel: useMutation({
      mutationFn: (id: string) => post('/v1/outreach/messages/{id}/cancel', id),
      onSuccess: settle,
    }),
    retry: useMutation({
      mutationFn: (id: string) => post('/v1/outreach/messages/{id}/retry', id),
      onSuccess: settle,
    }),
    /** A message waiting for approval (a sequence step): judged again, then queued. */
    approve: useMutation({
      mutationFn: (id: string) => post('/v1/outreach/messages/{id}/approve', id),
      onSuccess: settle,
    }),
    reschedule: useMutation({
      mutationFn: async ({ id, scheduledAt }: { id: string; scheduledAt: string }) =>
        unwrap<OutboundMessage>(
          await apiClient().POST('/v1/outreach/messages/{id}/reschedule', {
            params: { path: { id } },
            body: { scheduledAt },
          }),
        ),
      onSuccess: settle,
    }),
    edit: useMutation({
      mutationFn: async ({ id, subject, bodyMd }: { id: string; subject?: string; bodyMd?: string }) =>
        unwrap<OutboundMessage>(
          await apiClient().PATCH('/v1/outreach/messages/{id}', {
            params: { path: { id } },
            body: { ...(subject ? { subject } : {}), ...(bodyMd ? { bodyMd } : {}) },
          }),
        ),
      onSuccess: settle,
    }),
    manualLog: useMutation({
      mutationFn: async (body: ManualLogRequest) =>
        unwrap<ManualContactLog>(await apiClient().POST('/v1/outreach/manual-log', { body: body as never })),
      onSuccess: (log) =>
        void client.invalidateQueries({ queryKey: queryKeys.outreach.history(log.businessId) }),
    }),
  };
}

export function useBulkRuns() {
  return useQuery({
    queryKey: queryKeys.outreach.bulkRuns(),
    queryFn: async () => unwrap<{ items: BulkRun[] }>(await apiClient().GET('/v1/outreach/bulk')).items,
  });
}

export function useBulkRun(id: string | null) {
  return useQuery({
    queryKey: queryKeys.outreach.bulkRun(id ?? ''),
    queryFn: async () =>
      unwrap<BulkRunDetail>(
        await apiClient().GET('/v1/outreach/bulk/{id}', { params: { path: { id: id ?? '' } } }),
      ),
    enabled: id !== null,
    // Drafting runs in the background: poll until every business is settled.
    refetchInterval: (query) => (query.state.data?.run.status === 'drafting' ? 3_000 : false),
  });
}

export function useBulkActions() {
  const client = useQueryClient();
  const settle = () => {
    void client.invalidateQueries({ queryKey: ['outreach', 'bulk-run'] });
    void client.invalidateQueries({ queryKey: queryKeys.outreach.bulkRuns() });
    void client.invalidateQueries({ queryKey: ['outreach', 'messages'] });
  };
  return {
    start: useMutation({
      mutationFn: async (body: StartBulkRequest) =>
        unwrap<BulkRun>(await apiClient().POST('/v1/outreach/bulk', { body: body as never })),
      onSuccess: settle,
    }),
    approve: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: ApproveBulkRequest }) =>
        unwrap<BulkActionResult>(
          await apiClient().POST('/v1/outreach/bulk/{id}/approve', {
            params: { path: { id } },
            body: body as never,
          }),
        ),
      onSuccess: settle,
    }),
    reject: useMutation({
      mutationFn: async ({ id, messageIds }: { id: string; messageIds: string[] }) =>
        unwrap<BulkActionResult>(
          await apiClient().POST('/v1/outreach/bulk/{id}/reject', {
            params: { path: { id } },
            body: { messageIds },
          }),
        ),
      onSuccess: settle,
    }),
  };
}
