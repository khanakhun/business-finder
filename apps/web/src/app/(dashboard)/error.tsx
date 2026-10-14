'use client';

import { ErrorState } from '@bf/ui/components/error-state';
import { PageHeader } from '@bf/ui/components/page-header';
import { useTranslations } from 'next-intl';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const labels = useErrorLabels();
  const problem = toProblemLike(error, t('pageTitle'));
  return (
    <>
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorState
        problem={error.digest && !problem.traceId ? { ...problem, traceId: error.digest } : problem}
        labels={labels}
        onRetry={reset}
      />
    </>
  );
}
