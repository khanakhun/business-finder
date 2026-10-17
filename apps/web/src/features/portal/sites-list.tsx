'use client';

import { Badge } from '@bf/ui/components/badge';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { GlobeIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePortalSites } from './api.ts';

export function PortalSitesList() {
  const t = useTranslations('portal');
  const errorLabels = useErrorLabels();
  const sites = usePortalSites();
  if (sites.isError)
    return (
      <ErrorState
        problem={toProblemLike(sites.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void sites.refetch()}
      />
    );
  if (!sites.data) return <Skeleton className="h-24 w-full" />;
  if (sites.data.length === 0)
    return (
      <EmptyState icon={<GlobeIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
    );
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {sites.data.map((site) => (
        <li key={site.siteId}>
          <Link
            href={`/portal/sites/${site.siteId}`}
            className="block space-y-1 rounded-lg border p-4 hover:bg-muted focus-visible:outline-2"
          >
            <span className="flex items-center gap-2 font-medium">
              {site.name}
              <Badge variant={site.liveUrl ? 'default' : 'secondary'}>
                {site.liveUrl ? t('live') : t('notLive')}
              </Badge>
            </span>
            {site.pendingApprovals > 0 ? (
              <span className="block text-sm text-amber-700 dark:text-amber-400">
                {t('pendingApprovals', { count: site.pendingApprovals })}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
