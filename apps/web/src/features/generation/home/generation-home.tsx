'use client';

import { GENERATION_BATCH_STATUSES, type GenerationBatch } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { PageHeader } from '@bf/ui/components/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { LayoutTemplateIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { useBatches } from '../api.ts';
import { EnginesPanel } from './engines-panel.tsx';
import { ReviewQueue } from './review-queue.tsx';

// The generation home (BF-046): what needs a person (the review queue), the batches (by status, newest first), and
// the engines with their availability and load.

const ALL = 'all';
const STATUSES = [ALL, ...GENERATION_BATCH_STATUSES] as const;

export function GenerationHome() {
  const t = useTranslations('generation.home');
  const batchStatus = useTranslations('generation.batchStatus');
  const errorLabels = useErrorLabels();
  const format = useFormatter();
  const [status, setStatus] = useQueryState('status', parseAsStringLiteral(STATUSES).withDefault(ALL));
  const batches = useBatches(status === ALL ? {} : { status });
  const items = batches.data?.pages.flatMap((page) => page.items) ?? [];
  const progress = (batch: GenerationBatch) => {
    const total = Object.values(batch.counts).reduce((sum, count) => sum + (count ?? 0), 0);
    const done =
      (batch.counts.succeeded ?? 0) +
      (batch.counts.needs_review ?? 0) +
      (batch.counts.failed ?? 0) +
      (batch.counts.cancelled ?? 0);
    return t('progress', { done, total });
  };
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild size="sm">
            <Link href="/search">
              <PlusIcon aria-hidden />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <ReviewQueue />
          <section aria-labelledby="batches-title" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="batches-title" className="text-base font-semibold">
                {t('batches')}
              </h2>
              <Select
                value={status}
                onValueChange={(value) => void setStatus(value as (typeof STATUSES)[number])}
              >
                <SelectTrigger size="sm" className="w-52" aria-label={t('statusFilter')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === ALL ? t('allStatuses') : batchStatus(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {batches.isError ? (
              <ErrorState
                problem={toProblemLike(batches.error, t('loadError'))}
                labels={errorLabels}
                onRetry={() => void batches.refetch()}
              />
            ) : batches.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon={<LayoutTemplateIcon aria-hidden />}
                title={t('empty')}
                description={t('emptyHint')}
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href="/search">{t('toSearch')}</Link>
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y rounded-lg border">
                {items.map((batch) => (
                  <li key={batch.id}>
                    <Link
                      href={`/generation/batches/${batch.id}`}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/50"
                    >
                      <span className="min-w-0 flex-1 font-medium">{batch.name}</span>
                      <Badge variant="secondary">{batchStatus(batch.status)}</Badge>
                      <span className="text-sm tabular-nums text-muted-foreground">{progress(batch)}</span>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {format.number(batch.costUsd, { style: 'currency', currency: 'USD' })}
                      </span>
                      <time dateTime={batch.createdAt} className="text-xs text-muted-foreground">
                        {format.dateTime(new Date(batch.createdAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {batches.hasNextPage ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={batches.isFetchingNextPage}
                onClick={() => void batches.fetchNextPage()}
              >
                {t('more')}
              </Button>
            ) : null}
          </section>
        </div>
        <EnginesPanel />
      </div>
    </>
  );
}
