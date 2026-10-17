'use client';

import { OFFERS, SCORE_TIERS } from '@bf/contracts';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { PERIODS, useAnalyticsFilters } from './period.ts';

// The analytics dashboards (BF-058): one page, a tab per question, the period and filters in the URL. Each panel
// loads with its tab (charts and the map are heavy).

const loading = () => <Skeleton className="h-64 w-full" />;
const PANELS = {
  overview: dynamic(() => import('./panels/overview.tsx').then((m) => m.OverviewPanel), { loading }),
  funnel: dynamic(() => import('./panels/funnel.tsx').then((m) => m.FunnelPanel), { loading }),
  segments: dynamic(() => import('./panels/segments.tsx').then((m) => m.SegmentsPanel), { loading }),
  scoring: dynamic(() => import('./panels/scoring.tsx').then((m) => m.ScoringPanel), { loading }),
  experiments: dynamic(() => import('./panels/experiments.tsx').then((m) => m.ExperimentsPanel), { loading }),
  engines: dynamic(() => import('./panels/engines.tsx').then((m) => m.EnginesPanel), { loading }),
  previews: dynamic(() => import('./panels/previews.tsx').then((m) => m.PreviewsPanel), { loading }),
  economics: dynamic(() => import('./panels/economics.tsx').then((m) => m.EconomicsPanel), { loading }),
};
const TABS = Object.keys(PANELS) as (keyof typeof PANELS)[];
const PERIOD_KEY = { '30d': 'd30', '90d': 'd90', '365d': 'd365' } as const;
const ALL = 'all';

export function AnalyticsPage() {
  const t = useTranslations('analytics');
  const offers = useTranslations('composer.offers');
  const filters = useAnalyticsFilters();
  const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(TABS).withDefault('overview'));
  const Panel = PANELS[tab];
  return (
    <div className="space-y-4">
      <fieldset className="flex flex-wrap items-end gap-3">
        <legend className="sr-only">{t('filters')}</legend>
        <div className="space-y-1">
          <Label htmlFor="analytics-period">{t('period')}</Label>
          <Select
            value={filters.period}
            onValueChange={(value) => void filters.setPeriod(value as typeof filters.period)}
          >
            <SelectTrigger id="analytics-period" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`periods.${PERIOD_KEY[value]}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="analytics-offer">{t('offer')}</Label>
          <Select
            value={filters.offer ?? ALL}
            onValueChange={(value) => void filters.setOffer(value === ALL ? null : value)}
          >
            <SelectTrigger id="analytics-offer" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('allOffers')}</SelectItem>
              {OFFERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {offers(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="analytics-tier">{t('tier')}</Label>
          <Select
            value={filters.tier ?? ALL}
            onValueChange={(value) => void filters.setTier(value === ALL ? null : value)}
          >
            <SelectTrigger id="analytics-tier" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('allTiers')}</SelectItem>
              {SCORE_TIERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filters.category ? (
          <button type="button" className="text-sm underline" onClick={() => void filters.setCategory(null)}>
            {t('clearCategory', { category: filters.category })}
          </button>
        ) : null}
      </fieldset>
      <Tabs value={tab} onValueChange={(value) => void setTab(value as typeof tab)}>
        <TabsList className="flex h-auto flex-wrap justify-start">
          {TABS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab} className="pt-2">
          <Panel filters={filters} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
