'use client';

import type { TaskPage } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { PageHeader } from '@bf/ui/components/page-header';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ListTodoIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { userTimeZone } from '@/features/business/api.ts';
import { TaskRow } from '@/features/business/tasks.tsx';
import { apiClient, queryKeys } from '@/lib/api.ts';

const WINDOWS = ['overdue', 'today', 'upcoming', 'done'] as const;
type Window = (typeof WINDOWS)[number];

const queryOf = (window: Window) =>
  window === 'done' ? { status: 'done', due: 'all' } : { status: 'open', due: window };

/** My tasks (BF-024): overdue, today, upcoming and done; complete inline, jump to the business. */
export function TasksPage() {
  const t = useTranslations('tasks');
  const errorLabels = useErrorLabels();
  const [window, setWindow] = useQueryState('due', parseAsStringLiteral(WINDOWS).withDefault('today'));
  const filters = queryOf(window);
  const tasks = useInfiniteQuery({
    queryKey: queryKeys.crm.tasks(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await apiClient().GET('/v1/tasks', {
          params: {
            query: {
              assignee: 'me',
              ...filters,
              tz: userTimeZone(),
              limit: 50,
              ...(pageParam ? { cursor: pageParam } : {}),
            } as never,
          },
        })
      ).data as TaskPage,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = tasks.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="max-w-3xl space-y-4">
        <Tabs value={window} onValueChange={(value) => void setWindow(value as Window)}>
          <TabsList>
            {WINDOWS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {t(`windows.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {tasks.isError ? (
          <ErrorState
            problem={toProblemLike(tasks.error, t('error'))}
            labels={errorLabels}
            onRetry={() => void tasks.refetch()}
          />
        ) : tasks.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ListTodoIcon aria-hidden />}
            title={t(`empty.${window}`)}
            description={t('emptyHint')}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/pipeline">{t('toPipeline')}</Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y rounded-lg border px-4" aria-label={t(`windows.${window}`)}>
            {items.map((task) => (
              <TaskRow key={task.id} task={task} showBusiness />
            ))}
          </ul>
        )}
        {tasks.hasNextPage ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={tasks.isFetchingNextPage}
            onClick={() => void tasks.fetchNextPage()}
          >
            {t('more')}
          </Button>
        ) : null}
      </div>
    </>
  );
}
