'use client';

import type { Activity } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Skeleton } from '@bf/ui/components/skeleton';
import { CircleDotIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useActivities, useTeammates } from '../api.ts';
import { activityRenderers } from './registry.ts';

function Actor({ activity }: { readonly activity: Activity }) {
  const t = useTranslations('business.activity');
  const { byUser } = useTeammates();
  if (activity.actor.type === 'user' && activity.actor.id)
    return <>{byUser.get(activity.actor.id)?.name ?? t('someone')}</>;
  return <>{t(activity.actor.type === 'api_key' ? 'apiKey' : 'system')}</>;
}

function Fallback({ activity }: { readonly activity: Activity }) {
  const t = useTranslations('business.activity');
  return <>{t('generic', { type: activity.type })}</>;
}

/** Everything that happened to the business, newest first (renderers come from the registry). */
export function Timeline({ businessId }: { readonly businessId: string }) {
  const t = useTranslations('business.activity');
  const format = useFormatter();
  const activities = useActivities(businessId);
  const items = activities.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-labelledby="timeline-title" className="space-y-3">
      <h2 id="timeline-title" className="text-base font-semibold">
        {t('title')}
      </h2>
      {activities.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="relative space-y-4 border-l pl-5" aria-live="polite">
          {items.map((activity) => {
            const renderer = activityRenderers.get(activity.type);
            const Icon = renderer?.icon ?? CircleDotIcon;
            const Line = renderer?.component ?? Fallback;
            return (
              <li key={activity.id} className="relative text-sm" data-activity-type={activity.type}>
                <span className="absolute -left-[29px] flex size-4.5 items-center justify-center rounded-full border bg-background">
                  <Icon aria-hidden className="size-3 text-muted-foreground" />
                </span>
                <div>
                  <Line activity={activity} />
                </div>
                <div className="text-xs text-muted-foreground">
                  <Actor activity={activity} />
                  {' — '}
                  <time dateTime={activity.occurredAt}>
                    {format.relativeTime(new Date(activity.occurredAt))}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {activities.hasNextPage ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={activities.isFetchingNextPage}
          onClick={() => void activities.fetchNextPage()}
        >
          {t('more')}
        </Button>
      ) : null}
    </section>
  );
}
