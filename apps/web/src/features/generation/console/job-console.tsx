'use client';

import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { ArrowLeftIcon, ExternalLinkIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { useJob } from '../api.ts';
import { ActivityTab } from './activity-tab.tsx';
import { ArtifactsTab } from './artifacts-tab.tsx';
import { BriefTab } from './brief-tab.tsx';
import { QualityTab } from './quality-tab.tsx';
import { useJobEvents } from './use-job-events.ts';

// The job console (BF-046): a job's live activity (SSE with resume) and its quality report. A page of its own
// (/generation/jobs/[jobId], linked from notifications) and a drawer on the batch board (`compact`).

const TABS = ['activity', 'quality', 'brief', 'artifacts'] as const;

export function JobConsole({
  jobId,
  compact = false,
}: {
  readonly jobId: string;
  readonly compact?: boolean;
}) {
  const t = useTranslations('generation.console');
  const status = useTranslations('generation.status');
  const engines = useTranslations('generation.engines.name');
  const errorLabels = useErrorLabels();
  const format = useFormatter();
  const job = useJob(jobId);
  const isAdmin = usePermission('sites:admin');
  const stream = useJobEvents(jobId);
  const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(TABS).withDefault('activity'));
  if (job.isError) {
    return (
      <ErrorState
        problem={toProblemLike(job.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void job.refetch()}
      />
    );
  }
  if (!job.data) return <Skeleton className="h-64 w-full" />;
  const data = job.data;
  const Heading = compact ? 'h2' : 'h1';
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <header className="space-y-2">
        {compact ? null : (
          <Button asChild size="sm" variant="ghost" className="-ml-2">
            <Link href={`/generation/batches/${data.batchId}`}>
              <ArrowLeftIcon aria-hidden />
              {t('toBatch')}
            </Link>
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Heading className={compact ? 'text-lg font-semibold' : 'text-2xl font-semibold'}>
            {data.businessName}
          </Heading>
          <Badge data-testid="console-status">{status(data.status)}</Badge>
          <Badge variant="outline">{engines(data.engineCurrent)}</Badge>
          {data.publishedUrl ? (
            <a
              href={data.publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-lagoon hover:underline"
            >
              <ExternalLinkIcon aria-hidden className="size-4" />
              {t('openPreview')}
            </a>
          ) : null}
        </div>
        {data.attempts.length > 0 ? (
          <ol className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label={t('attempts')}>
            {data.attempts.map((attempt) => (
              <li key={attempt.id} className="rounded-full bg-muted px-2 py-0.5">
                {t('attemptSummary', {
                  attempt: attempt.attemptNo,
                  engine: engines(attempt.engine),
                  mode: t(`mode.${attempt.mode}`),
                  status: t(`attemptStatus.${attempt.status}`),
                  cost: format.number(attempt.costUsd, { style: 'currency', currency: 'USD' }),
                })}
                {attempt.exitReason ? ` · ${attempt.exitReason}` : ''}
              </li>
            ))}
          </ol>
        ) : null}
      </header>
      <Tabs value={tab} onValueChange={(value) => void setTab(value as (typeof TABS)[number])}>
        <TabsList>
          {TABS.filter((value) => value !== 'artifacts' || isAdmin).map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="activity" className="pt-3">
          <ActivityTab events={stream.events} state={stream.state} budgetUsd={data.budgetUsd} />
        </TabsContent>
        <TabsContent value="quality" className="pt-3">
          <QualityTab jobId={jobId} siteId={data.siteId} />
        </TabsContent>
        <TabsContent value="brief" className="pt-3">
          <BriefTab jobId={jobId} />
        </TabsContent>
        {isAdmin ? (
          <TabsContent value="artifacts" className="pt-3">
            <ArtifactsTab jobId={jobId} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
