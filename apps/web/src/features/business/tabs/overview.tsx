'use client';

import type { BusinessDetail } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import dynamic from 'next/dynamic';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type * as React from 'react';
import { useCategories } from '@/features/search/hooks.tsx';
import { safeWebUrl } from '@/features/search/safe-url.ts';
import { SourceBadge } from '../provenance.tsx';
import type { BusinessTabProps } from './registry.ts';

const LocationMap = dynamic(() => import('../location-map.tsx').then((m) => m.LocationMap), {
  ssr: false,
  loading: () => <div className="h-56 rounded-lg border bg-surface-sunken" />,
});

/** A Monday, so `weekday` 0 = Monday as in the API. */
const MONDAY = Date.UTC(2024, 0, 1);

function Fact({
  label,
  field,
  business,
  children,
}: {
  readonly label: string;
  readonly field?: string;
  readonly business: BusinessDetail;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-start gap-3 py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 break-words">{children}</span>
        {field ? <SourceBadge provenance={business.attributes[field]} /> : null}
      </dd>
    </div>
  );
}

export function OverviewTab({ business }: BusinessTabProps) {
  const t = useTranslations('business.overview');
  const status = useTranslations('business.operating');
  const format = useFormatter();
  const locale = useLocale();
  const { labels } = useCategories();
  const website = safeWebUrl(business.websiteUrl);
  const weekday = (day: number) =>
    new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(MONDAY + day * 86_400_000);
  const emails = business.contacts.filter((c) => c.type === 'email').length;
  const phones = business.contacts.filter((c) => c.type === 'phone' || c.type === 'whatsapp').length;
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="facts-title" className="min-w-0">
        <h2 id="facts-title" className="mb-1 text-base font-semibold">
          {t('facts')}
        </h2>
        <dl className="divide-y">
          <Fact label={t('name')} field="displayName" business={business}>
            {business.displayName}
          </Fact>
          <Fact label={t('status')} field="operatingStatus" business={business}>
            {status(business.operatingStatus)}
          </Fact>
          <Fact label={t('address')} field="address" business={business}>
            {business.formattedAddress ?? t('unknown')}
          </Fact>
          <Fact label={t('phone')} field="primaryPhone" business={business}>
            {business.primaryPhone ?? t('unknown')}
          </Fact>
          <Fact label={t('website')} field="websiteUrl" business={business}>
            {website ? (
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-lagoon hover:underline"
              >
                {business.websiteUrl}
              </a>
            ) : (
              t('none')
            )}
          </Fact>
          <Fact label={t('rating')} business={business}>
            {business.ratingAvg !== null
              ? t('ratingValue', {
                  rating: format.number(business.ratingAvg, { maximumFractionDigits: 1 }),
                  count: business.ratingCount ?? 0,
                })
              : t('unknown')}
          </Fact>
          <Fact label={t('categories')} business={business}>
            {business.categories.length === 0 ? (
              t('unknown')
            ) : (
              <span className="flex flex-wrap gap-1.5">
                {business.categories.map((category) => (
                  <Badge key={category.categoryId} variant={category.isPrimary ? 'secondary' : 'outline'}>
                    {labels.get(category.categoryId)?.label ?? t('unknown')}
                  </Badge>
                ))}
              </span>
            )}
          </Fact>
          <Fact label={t('contacts')} business={business}>
            {t('contactsSummary', { emails, phones })}
          </Fact>
          <Fact label={t('quality')} business={business}>
            {business.dataQuality !== null
              ? t('qualityValue', { score: business.dataQuality })
              : t('unknown')}
          </Fact>
          <Fact label={t('seen')} business={business}>
            {t('seenValue', {
              first: format.dateTime(new Date(business.firstSeenAt), { dateStyle: 'medium' }),
              last: format.dateTime(new Date(business.lastSeenAt), { dateStyle: 'medium' }),
            })}
          </Fact>
        </dl>
      </section>
      <aside className="space-y-6">
        <section aria-labelledby="map-title" className="space-y-2">
          <h2 id="map-title" className="text-base font-semibold">
            {t('location')}
          </h2>
          {business.location ? (
            <LocationMap
              lat={business.location.lat}
              lng={business.location.lng}
              label={business.displayName}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t('noLocation')}</p>
          )}
        </section>
        <section aria-labelledby="hours-title" className="space-y-2">
          <h2 id="hours-title" className="text-base font-semibold">
            {t('hours')}
          </h2>
          {business.hours.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noHours')}</p>
          ) : (
            <dl className="space-y-1 text-sm">
              {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                const slots = business.hours.filter((h) => h.weekday === day);
                return (
                  <div key={day} className="flex justify-between gap-4">
                    <dt className="capitalize text-muted-foreground">{weekday(day)}</dt>
                    <dd className="tabular-nums">
                      {slots.length === 0
                        ? t('closed')
                        : slots.map((slot) => `${slot.opensAt}–${slot.closesAt}`).join(', ')}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </section>
      </aside>
    </div>
  );
}
