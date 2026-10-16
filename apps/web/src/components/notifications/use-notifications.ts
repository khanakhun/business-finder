'use client';

import type { Notification, NotificationPage } from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { useSession } from '@/lib/session.tsx';

const page = async (query: { limit: number; unread?: 'true'; cursor?: string }) =>
  (await apiClient().GET('/v1/notifications', { params: { query } })).data as NotificationPage;

/** Unread count for the bell (refreshed by realtime `notification.created`). */
export function useUnreadCount(): number {
  const { activeOrganization } = useSession();
  const query = useQuery({
    queryKey: queryKeys.notifications.unread(),
    queryFn: () => page({ limit: 1, unread: 'true' }),
    enabled: activeOrganization !== null,
    staleTime: 60_000,
  });
  return query.data?.unreadCount ?? 0;
}

export function useRecentNotifications(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.notifications.recent(), queryFn: () => page({ limit: 8 }), enabled });
}

export { page as fetchNotificationsPage };

export function useMarkRead() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['notifications'] });
  const one = useMutation({
    mutationFn: (id: string) => apiClient().POST('/v1/notifications/{id}/read', { params: { path: { id } } }),
    onSuccess: refresh,
  });
  const all = useMutation({
    mutationFn: () => apiClient().POST('/v1/notifications/read-all'),
    onSuccess: refresh,
  });
  return { one, all };
}

/** Title and body of a notification in the viewer's language (keys under `notifications.types.*`). */
export function useNotificationText(): (notification: Notification) => { title: string; body: string } {
  const t = useTranslations('notifications.types');
  return (notification) => ({
    title: t(`${notification.type}.title`, notification.params),
    body: t(`${notification.type}.body`, notification.params),
  });
}
