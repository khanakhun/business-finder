'use client';

import type { SitePage } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon, PencilIcon, SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import type { BusinessTabProps } from '@/features/business/tabs/registry.ts';
import { apiClient } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { useJobs } from '../api.ts';

// The business page's Sites tab (BF-046): its preview sites (current version, preview link and expiry, editor), the
// latest generation jobs for it, and Generate / Regenerate (the create flow with this business).

export function SitesTab({ business }: BusinessTabProps) {
  const t = useTranslations('generation.businessTab');
  const status = useTranslations('generation.status');
  const format = useFormatter();
  const canGenerate = usePermission('sites:generate');
  const sites = useQuery({
    queryKey: ['generation', 'business-sites', business.id],
    queryFn: async () =>
      (
        await apiClient().GET('/v1/sites', {
          params: { query: { businessId: business.id, limit: 10 } as never },
        })
      ).data as SitePage,
  });
  const jobs = useJobs({ businessId: business.id });
  const items = sites.data?.items ?? [];
  const latestJobs = jobs.data?.pages[0]?.items.slice(0, 5) ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        {canGenerate ? (
          <Button asChild size="sm">
            <Link href={`/generation/new?ids=${business.id}`}>
              <SparklesIcon aria-hidden />
              {items.length > 0 ? t('regenerate') : t('generate')}
            </Link>
          </Button>
        ) : null}
      </div>
      {sites.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : sites.isError ? (
        <p className="text-sm text-destructive">{t('error')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((site) => (
            <li key={site.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{site.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {site.currentVersion
                    ? t('version', { version: site.currentVersion.versionNumber })
                    : t('noVersion')}
                  {' · '}
                  {t('updated', {
                    when: format.dateTime(new Date(site.updatedAt), { dateStyle: 'medium' }),
                  })}
                </span>
              </span>
              <Badge variant="secondary">{site.status}</Badge>
              {site.preview ? (
                <span className="flex items-center gap-2 text-sm">
                  <a
                    href={site.preview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-lagoon hover:underline"
                  >
                    <ExternalLinkIcon aria-hidden className="size-4" />
                    {t('preview')}
                  </a>
                  {site.preview.expiresAt ? (
                    <span className="text-xs text-muted-foreground">
                      {t('expires', {
                        when: format.dateTime(new Date(site.preview.expiresAt), { dateStyle: 'medium' }),
                      })}
                    </span>
                  ) : null}
                </span>
              ) : null}
              <Button asChild size="sm" variant="ghost">
                <Link href={`/sites/${site.id}/edit`}>
                  <PencilIcon aria-hidden />
                  {t('edit')}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="business-jobs" className="space-y-2">
        <h3 id="business-jobs" className="text-sm font-medium">
          {t('jobs')}
        </h3>
        {jobs.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : latestJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noJobs')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {latestJobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-3">
                <Badge variant="outline">{status(job.status)}</Badge>
                {job.qualityScore !== null ? (
                  <span className="tabular-nums text-muted-foreground">
                    {t('quality', { score: Math.round(job.qualityScore) })}
                  </span>
                ) : null}
                <time dateTime={job.createdAt} className="text-xs text-muted-foreground">
                  {format.dateTime(new Date(job.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </time>
                <Link
                  href={`/generation/batches/${job.batchId}?job=${job.id}`}
                  className="text-lagoon hover:underline"
                >
                  {t('openJob')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
