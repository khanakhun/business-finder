'use client';

import { type GenerationBatchDetail, type GenerationJob, SETTLED_JOB_STATUSES } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { ErrorState } from '@bf/ui/components/error-state';
import { PageHeader } from '@bf/ui/components/page-header';
import { Progress } from '@bf/ui/components/progress';
import { Skeleton } from '@bf/ui/components/skeleton';
import { TooltipProvider } from '@bf/ui/components/tooltip';
import { CopyPlusIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useBatch, useEngines, useJobActions } from '../api.ts';
import { move } from '../reorder.ts';
import { SortableList } from '../sortable-list.tsx';
import { progressTitle, statusChanges } from './announce.ts';
import { formatDuration, JobCard } from './job-card.tsx';

// The batch board (BF-046): the jobs in priority order, live from the workspace's realtime channel (useBatch patches
// the cache with each job's new state). Queued jobs can be dragged (or moved with the buttons) to change what starts
// next; status changes are announced politely, at most every few seconds, and the tab title shows the progress.

const ANNOUNCE_EVERY_MS = 3_000;
const SETTLED: ReadonlySet<string> = new Set(SETTLED_JOB_STATUSES);

export function BatchBoard({ batchId }: { readonly batchId: string }) {
  const t = useTranslations('generation.board');
  const errorLabels = useErrorLabels();
  const batch = useBatch(batchId);
  const engines = useEngines();
  const actions = useJobActions(batchId);
  const canGenerate = usePermission('sites:generate');
  const now = useNow(batch.data ? !batch.data.finishedAt : false);
  const announcement = useAnnouncements(batch.data?.jobs ?? []);
  const total = batch.data?.jobs.length ?? 0;
  const done = batch.data?.jobs.filter((job) => SETTLED.has(job.status)).length ?? 0;
  useTabTitle(batch.data ? progressTitle(done, total, batch.data.name) : null);

  if (batch.isError) {
    return (
      <ErrorState
        problem={toProblemLike(batch.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void batch.refetch()}
      />
    );
  }
  if (!batch.data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-72" />
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }
  const data = batch.data;
  const queued = data.jobs.filter((job) => job.status === 'queued');
  const reorder = (jobId: string, to: number) => {
    const order = move(
      data.jobs,
      data.jobs.findIndex((job) => job.id === jobId),
      to,
    )
      .filter((job) => job.status === 'queued')
      .map((job) => job.id);
    actions.reorder.mutate(order, {
      onError: () => void getToast().then((toast) => toast.error(t('actionFailed'))),
    });
  };
  const startNext = (jobId: string) => {
    const first = data.jobs.findIndex((job) => job.status === 'queued');
    if (first >= 0) reorder(jobId, first);
  };
  return (
    <TooltipProvider>
      <BatchHeader
        batch={data}
        done={done}
        now={now}
        canCancel={canGenerate && !data.finishedAt && data.status !== 'cancelled'}
        onCancel={() =>
          actions.cancelBatch.mutate(undefined, {
            onError: () => void getToast().then((toast) => toast.error(t('actionFailed'))),
          })
        }
      />
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {queued.length > 1 ? <p className="mb-2 text-xs text-muted-foreground">{t('reorderHint')}</p> : null}
      <SortableList
        items={data.jobs.map((job) => ({
          ...job,
          label: job.businessName,
          locked: job.status !== 'queued' || !canGenerate,
        }))}
        label={t('jobs')}
        onMove={reorder}
        renderItem={(job) => (
          <JobCard
            job={job}
            listing={engines.data}
            actions={actions}
            now={now}
            canStartNext={canGenerate && queued.length > 1 && queued[0]?.id !== job.id}
            onStartNext={() => startNext(job.id)}
          />
        )}
      />
    </TooltipProvider>
  );
}

function BatchHeader({
  batch,
  done,
  now,
  canCancel,
  onCancel,
}: {
  readonly batch: GenerationBatchDetail;
  readonly done: number;
  readonly now: number;
  readonly canCancel: boolean;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('generation.board');
  const status = useTranslations('generation.status');
  const batchStatus = useTranslations('generation.batchStatus');
  const format = useFormatter();
  const total = batch.jobs.length;
  const started = batch.startedAt ? Date.parse(batch.startedAt) : null;
  const elapsed = started
    ? Math.round(((batch.finishedAt ? Date.parse(batch.finishedAt) : now) - started) / 1000)
    : null;
  const ids = batch.jobs.map((job) => job.businessId).join(',');
  return (
    <>
      <PageHeader
        title={batch.name}
        description={t('mode', { parallel: batch.maxParallel ?? 0 })}
        actions={
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/generation/new?ids=${ids}`}>
                <CopyPlusIcon aria-hidden />
                {t('duplicate')}
              </Link>
            </Button>
            {canCancel ? (
              <Button type="button" size="sm" variant="outline" onClick={onCancel}>
                <XIcon aria-hidden />
                {t('cancelBatch')}
              </Button>
            ) : null}
          </div>
        }
      />
      <section aria-label={t('summary')} className="mb-4 space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge data-testid="batch-status">{batchStatus(batch.status)}</Badge>
          <span className="tabular-nums">{t('progress', { done, total })}</span>
          <span className="tabular-nums text-muted-foreground">
            {t('batchCost', {
              cost: format.number(batch.costUsd, { style: 'currency', currency: 'USD' }),
            })}
            {batch.budgetUsd !== null
              ? ` / ${format.number(batch.budgetUsd, { style: 'currency', currency: 'USD' })}`
              : ''}
          </span>
          {elapsed !== null ? (
            <span className="tabular-nums text-muted-foreground">
              {t('elapsed')} {formatDuration(Math.max(0, elapsed))}
            </span>
          ) : null}
        </div>
        <Progress value={total > 0 ? (done / total) * 100 : 0} aria-label={t('progress', { done, total })} />
        <ul className="flex flex-wrap gap-2 text-xs" aria-label={t('counts')}>
          {Object.entries(batch.counts)
            .filter(([, count]) => (count ?? 0) > 0)
            .map(([key, count]) => (
              <li key={key} className="rounded-full bg-muted px-2 py-0.5 tabular-nums">
                {status(key as GenerationJob['status'])} {count}
              </li>
            ))}
        </ul>
      </section>
    </>
  );
}

/** A clock for elapsed times, ticking each second while the batch runs. */
function useNow(running: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** The latest status changes as one message, refreshed at most every few seconds. */
function useAnnouncements(jobs: readonly GenerationJob[]): string {
  const t = useTranslations('generation.board');
  const status = useTranslations('generation.status');
  const seen = React.useRef<Map<string, GenerationJob['status']> | null>(null);
  const pending = React.useRef<string[]>([]);
  const [message, setMessage] = React.useState('');
  React.useEffect(() => {
    if (seen.current) {
      for (const change of statusChanges(seen.current, jobs))
        pending.current.push(t('announce', { name: change.name, status: status(change.status) }));
    }
    seen.current = new Map(jobs.map((job) => [job.id, job.status]));
  }, [jobs, t, status]);
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (pending.current.length === 0) return;
      setMessage(pending.current.join('. '));
      pending.current = [];
    }, ANNOUNCE_EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  return message;
}

function useTabTitle(title: string | null) {
  React.useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
