'use client';

import { ApiError } from '@bf/api-client';
import type {
  ActivityPage,
  BusinessDetail,
  ContactList,
  CrmState,
  NoteList,
  PossibleDuplicatePage,
  TaskPage,
  TeammateList,
} from '@bf/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { getToast } from '@/lib/toast.tsx';

/** The browser's IANA time zone: the API decides "today" in it. */
export const userTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Data hooks of the business page (BF-024). Every mutation refreshes the business's queries; realtime events
// refresh them for everyone else (lib/realtime/invalidations.ts).

export function useBusiness(id: string, initialData?: BusinessDetail) {
  return useQuery({
    queryKey: queryKeys.business.detail(id),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}', { params: { path: { id } } })).data as BusinessDetail,
    initialData,
    // Fetched by the server for this render: no immediate refetch (realtime and mutations keep it fresh).
    staleTime: 30_000,
  });
}

export function useCrmState(id: string, initialData?: CrmState) {
  return useQuery({
    queryKey: queryKeys.business.crm(id),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}/crm', { params: { path: { id } } })).data as CrmState,
    initialData,
    staleTime: 30_000,
  });
}

export function useContacts(id: string) {
  return useQuery({
    queryKey: queryKeys.business.contacts(id),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}/contacts', { params: { path: { id } } }))
        .data as ContactList,
  });
}

export function useNotes(id: string) {
  return useQuery({
    queryKey: queryKeys.business.notes(id),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}/notes', { params: { path: { id } } })).data as NoteList,
  });
}

export function useBusinessTasks(id: string) {
  return useQuery({
    queryKey: queryKeys.business.tasks(id),
    queryFn: async () =>
      (
        await apiClient().GET('/v1/businesses/{id}/tasks', {
          params: { path: { id }, query: { status: 'open', limit: 100, tz: userTimeZone() } },
        })
      ).data as TaskPage,
  });
}

export function useActivities(id: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.business.activities(id),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await apiClient().GET('/v1/businesses/{id}/activities', {
          params: { path: { id }, query: { limit: 30, ...(pageParam ? { cursor: pageParam } : {}) } },
        })
      ).data as ActivityPage,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useDuplicates(id: string) {
  return useQuery({
    queryKey: queryKeys.business.duplicates(id),
    queryFn: async () =>
      (
        await apiClient().GET('/v1/businesses/possible-duplicates', {
          params: { query: { businessId: id, status: 'open', limit: 10 } },
        })
      ).data as PossibleDuplicatePage,
  });
}

/** The workspace's members by name (owner and assignee pickers, names in the timeline). */
export function useTeammates() {
  const query = useQuery({
    queryKey: queryKeys.identity.teammates(),
    queryFn: async () => (await apiClient().GET('/v1/teammates')).data as TeammateList,
    staleTime: 5 * 60_000,
  });
  const byUser = React.useMemo(
    () => new Map((query.data?.items ?? []).map((teammate) => [teammate.userId, teammate])),
    [query.data],
  );
  return { ...query, byUser };
}

/** The message for a failed CRM change: refused pipeline moves get their own sentence. */
export function useCrmErrorMessage(): (error: unknown) => string {
  const t = useTranslations('business');
  const generic = useErrorMessage();
  return React.useCallback(
    (error: unknown) =>
      error instanceof ApiError && error.code === 'INVALID_STATE_TRANSITION'
        ? t('status.refused')
        : generic(error),
    [t, generic],
  );
}

/**
 * A change to one business: runs it, refreshes the business (and the board/task lists), toasts failures. `success`
 * is a message to toast when it worked.
 */
export function useBusinessMutation<V, R>(
  id: string,
  mutationFn: (variables: V) => Promise<R>,
  options: { readonly success?: (result: R, variables: V) => string | null } = {},
) {
  const client = useQueryClient();
  const message = useCrmErrorMessage();
  return useMutation({
    mutationFn,
    onSuccess: async (result, variables) => {
      const text = options.success?.(result, variables);
      if (text) (await getToast()).success(text);
    },
    onError: async (error) => (await getToast()).error(message(error)),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['business', id] }),
        client.invalidateQueries({ queryKey: queryKeys.crm.all }),
      ]);
    },
  });
}
