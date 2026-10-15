'use client';

import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useInfiniteQuery } from '@tanstack/react-query';
import { BellIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { queryKeys } from '@/lib/api.ts';
import { NotificationItem } from './notification-item.tsx';
import { fetchNotificationsPage, useMarkRead } from './use-notifications.ts';

const PAGE_SIZE = 30;

export function NotificationsList() {
  const t = useTranslations();
  const labels = useErrorLabels();
  const [filter, setFilter] = React.useState<'all' | 'unread'>('all');
  const { all } = useMarkRead();
  const query = useInfiniteQuery({
    queryKey: queryKeys.notifications.list(filter),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchNotificationsPage({
        limit: PAGE_SIZE,
        ...(filter === 'unread' ? { unread: 'true' as const } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const unreadCount = query.data?.pages[0]?.unreadCount ?? 0;

  return (
    <div className="grid max-w-3xl gap-4">
      <div className="flex items-center justify-between gap-3">
        {/* A filter, not tabs (no panels): pressed buttons in a labelled group. */}
        <fieldset className="flex gap-1">
          <legend className="sr-only">{t('notifications.title')}</legend>
          {(['all', 'unread'] as const).map((value) => (
            <Button
              key={value}
              variant={filter === value ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(`notifications.${value}`)}
            </Button>
          ))}
        </fieldset>
        {unreadCount > 0 ? (
          <Button variant="outline" size="sm" disabled={all.isPending} onClick={() => all.mutate()}>
            {t('notifications.markAllRead')}
          </Button>
        ) : null}
      </div>
      {query.isError ? (
        <ErrorState
          problem={toProblemLike(query.error, t('errors.pageTitle'))}
          labels={labels}
          onRetry={() => void query.refetch()}
        />
      ) : !query.data ? (
        <Skeleton className="h-48" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<BellIcon aria-hidden />}
          title={filter === 'unread' ? t('notifications.emptyUnread') : t('notifications.empty')}
        />
      ) : (
        <>
          <ul className="grid gap-1 rounded-lg border bg-surface p-2">
            {items.map((notification) => (
              <li key={notification.id}>
                <NotificationItem notification={notification} />
              </li>
            ))}
          </ul>
          {query.hasNextPage ? (
            <div>
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t('notifications.loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
