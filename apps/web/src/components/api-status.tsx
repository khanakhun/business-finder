'use client';

import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { toProblemLike, useErrorLabels } from './states/problem.ts';

/** Live check of the API through the typed client: proves the whole chain (CORS, client, contracts). */
export function ApiStatus() {
  const t = useTranslations('home.apiStatus');
  const errorT = useTranslations('errors');
  const format = useFormatter();
  const labels = useErrorLabels();
  const query = useQuery({
    queryKey: queryKeys.system.info(),
    queryFn: async () => (await apiClient().GET('/v1/system/info')).data,
  });

  return (
    <section aria-labelledby="api-status-title" className="rounded-lg border bg-surface">
      <div className="flex items-center justify-between border-b px-5 py-3">
        <h2 id="api-status-title" className="font-semibold">
          {t('title')}
        </h2>
        {query.isSuccess ? (
          <span className="inline-flex items-center gap-2 text-sm text-kelp">
            <span aria-hidden className="size-2 rounded-full bg-kelp" />
            {t('connected')}
          </span>
        ) : null}
      </div>
      <div className="px-5 py-4">
        {query.isPending ? (
          <div role="status" aria-busy="true" className="grid gap-3 sm:grid-cols-4">
            <span className="sr-only">{t('checking')}</span>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : query.isError ? (
          <ErrorState
            problem={toProblemLike(query.error, errorT('pageTitle'))}
            labels={labels}
            onRetry={() => void query.refetch()}
          />
        ) : query.data ? (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-4">
            <div>
              <dt className="text-sm text-muted-foreground">{t('version')}</dt>
              <dd className="font-medium" data-testid="api-version">
                {query.data.version}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('environment')}</dt>
              <dd className="font-medium">{query.data.env}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('commit')}</dt>
              <dd className="font-medium">
                {query.data.commit ? query.data.commit.slice(0, 7) : t('unknownCommit')}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('serverTime')}</dt>
              <dd className="font-medium">
                {format.dateTime(new Date(query.data.time), { dateStyle: 'medium', timeStyle: 'short' })}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
    </section>
  );
}
