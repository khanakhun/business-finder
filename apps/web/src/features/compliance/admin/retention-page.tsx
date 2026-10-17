'use client';

import { Button } from '@bf/ui/components/button';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useTranslations } from 'next-intl';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useRetention } from './api.ts';

// Compliance → Retention (BF-055): the registered policies, the latest runs (daily and dry runs) and a dry run that
// counts what would be removed now.

export function RetentionPage() {
  const t = useTranslations('complianceAdmin.retention');
  const errorLabels = useErrorLabels();
  const format = useFormatter();
  const canRun = usePermission('compliance:manage');
  const { overview, dryRun } = useRetention();
  if (overview.isError)
    return (
      <ErrorState
        problem={toProblemLike(overview.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void overview.refetch()}
      />
    );
  if (!overview.data) return <Skeleton className="h-48 w-full" />;
  return (
    <div className="space-y-6 text-sm">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('policies')}</h2>
          {canRun ? (
            <Button
              size="sm"
              variant="outline"
              disabled={dryRun.isPending}
              onClick={() =>
                void (async () => {
                  const toast = await getToast();
                  try {
                    await dryRun.mutateAsync();
                    toast.success(t('dryRunDone'));
                  } catch (error) {
                    toast.error(toProblemLike(error, t('failed')).title);
                  }
                })()
              }
            >
              {t('dryRun')}
            </Button>
          ) : null}
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full">
            <caption className="sr-only">{t('policies')}</caption>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('policy')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('kept')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('action')}
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.data.policies.map((policy) => (
                <tr key={policy.id} className="border-t">
                  <td className="px-3 py-2">
                    <span className="font-medium">{policy.id}</span>
                    <span className="block text-xs text-muted-foreground">{policy.description}</span>
                  </td>
                  <td className="px-3 py-2">{t('days', { count: policy.retentionDays })}</td>
                  <td className="px-3 py-2">{t(`actions.${policy.action}` as never)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t('runs')}</h2>
        {overview.data.runs.length === 0 ? (
          <p className="text-muted-foreground">{t('noRuns')}</p>
        ) : (
          <ul className="space-y-2">
            {overview.data.runs.map((run) => (
              <li key={run.id} className="rounded-lg border p-2">
                <p className="text-xs text-muted-foreground">
                  {format.dateTime(new Date(run.startedAt), { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                  {run.dryRun ? t('dry') : t('real')}
                </p>
                <ul className="mt-1 grid gap-0.5 text-xs sm:grid-cols-2">
                  {run.results.map((result) => (
                    <li key={result.policy} className={result.error ? 'text-destructive' : ''}>
                      {result.policy}: {result.error ? result.error : t('rows', { count: result.count })}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
