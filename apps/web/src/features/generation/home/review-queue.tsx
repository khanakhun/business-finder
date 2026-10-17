'use client';

import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Skeleton } from '@bf/ui/components/skeleton';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useJobs } from '../api.ts';

// The review queue (BF-046): generated sites the quality gates left for a person, newest first; each opens its
// batch with the job's console on the quality report, where it can be accepted or retried.

export function ReviewQueue() {
  const t = useTranslations('generation.home.review');
  const format = useFormatter();
  const jobs = useJobs({ status: 'needs_review' });
  const items = jobs.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-labelledby="review-title" className="space-y-3">
      <h2 id="review-title" className="flex items-center gap-2 text-base font-semibold">
        {t('title')}
        {items.length > 0 ? <Badge variant="secondary">{items.length}</Badge> : null}
      </h2>
      {jobs.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : jobs.isError ? (
        <p className="text-sm text-destructive">{t('error')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{job.businessName}</span>
                {job.errorMessage ? (
                  <span className="block text-xs text-muted-foreground">{job.errorMessage}</span>
                ) : null}
              </span>
              {job.qualityScore !== null ? (
                <Badge variant="outline" className="tabular-nums">
                  {t('score', { score: Math.round(job.qualityScore) })}
                </Badge>
              ) : null}
              {job.finishedAt ? (
                <time dateTime={job.finishedAt} className="text-xs text-muted-foreground">
                  {format.relativeTime(new Date(job.finishedAt))}
                </time>
              ) : null}
              <Button asChild size="sm" variant="outline">
                <Link href={`/generation/batches/${job.batchId}?job=${job.id}&tab=quality`}>{t('open')}</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {jobs.hasNextPage ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={jobs.isFetchingNextPage}
          onClick={() => void jobs.fetchNextPage()}
        >
          {t('more')}
        </Button>
      ) : null}
    </section>
  );
}
