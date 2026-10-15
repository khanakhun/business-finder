'use client';

import type { BusinessDetail, CrmState } from '@bf/contracts';
import { GlobeIcon, MapPinIcon, StarIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCategories } from '@/features/search/hooks.tsx';
import { safeWebUrl } from '@/features/search/safe-url.ts';
import { usePermission } from '@/lib/session.tsx';
import { QuickActions } from './actions/quick-actions.tsx';
import { DoNotContactSwitch } from './crm/do-not-contact.tsx';
import { OwnerSelect } from './crm/owner-select.tsx';
import { StatusMenu } from './crm/status-menu.tsx';
import { TagsEditor } from './crm/tags-editor.tsx';

/** Who the business is, and the workspace's hold on it: status, owner, tags, do-not-contact. */
export function BusinessHeader({
  business,
  crm,
}: {
  readonly business: BusinessDetail;
  readonly crm: CrmState;
}) {
  const t = useTranslations('business');
  const format = useFormatter();
  const { labels } = useCategories();
  const canWrite = usePermission('business:write');
  const website = safeWebUrl(business.websiteUrl);
  const category = business.primaryCategoryId ? labels.get(business.primaryCategoryId)?.label : undefined;
  return (
    <header className="space-y-4 border-b pb-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{business.displayName}</h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {category ? <span>{category}</span> : null}
            {business.locality ? (
              <span className="inline-flex items-center gap-1">
                <MapPinIcon aria-hidden className="size-3.5" />
                {business.locality}
              </span>
            ) : null}
            {business.ratingAvg !== null ? (
              <span className="inline-flex items-center gap-1">
                <StarIcon aria-hidden className="size-3.5" />
                {t('rating', {
                  rating: format.number(business.ratingAvg, { maximumFractionDigits: 1 }),
                  count: business.ratingCount ?? 0,
                })}
              </span>
            ) : null}
            {website ? (
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-72 items-center gap-1 truncate text-lagoon hover:underline"
              >
                <GlobeIcon aria-hidden className="size-3.5" />
                {new URL(website).host}
              </a>
            ) : null}
          </p>
        </div>
        <QuickActions business={business} crm={crm} />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <StatusMenu
          businessId={business.id}
          businessName={business.displayName}
          current={crm.pipelineStatus}
          transitions={crm.allowedTransitions}
          disabled={!canWrite}
        />
        <OwnerSelect businessId={business.id} ownerUserId={crm.ownerUserId} disabled={!canWrite} />
        <DoNotContactSwitch
          businessId={business.id}
          value={crm.doNotContact}
          reason={crm.doNotContactReason}
          disabled={!canWrite}
        />
        <TagsEditor businessId={business.id} tags={crm.tags} disabled={!canWrite} />
      </div>
      {crm.pipelineStatus === 'lost' && crm.lostReason ? (
        <p className="text-sm text-muted-foreground">{t('lostBecause', { reason: crm.lostReason })}</p>
      ) : null}
      {crm.pipelineStatus === 'disqualified' && crm.disqualifiedReason ? (
        <p className="text-sm text-muted-foreground">
          {t('disqualifiedBecause', { reason: crm.disqualifiedReason })}
        </p>
      ) : null}
    </header>
  );
}
