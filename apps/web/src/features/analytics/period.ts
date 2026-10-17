'use client';

import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import * as React from 'react';

// The dashboards' filters in the URL (BF-058): the period and optional offer, tier and category; shared by every
// tab so a link opens the same view.

export const PERIODS = ['30d', '90d', '365d'] as const;
export type Period = (typeof PERIODS)[number];

const DAYS: Record<Period, number> = { '30d': 30, '90d': 90, '365d': 365 };

export function useAnalyticsFilters() {
  const [period, setPeriod] = useQueryState('period', parseAsStringLiteral(PERIODS).withDefault('90d'));
  const [offer, setOffer] = useQueryState('offer', parseAsString);
  const [tier, setTier] = useQueryState('tier', parseAsString);
  const [category, setCategory] = useQueryState('category', parseAsString);
  // Whole days (UTC): stable keys for caching within a day.
  const range = React.useMemo(() => {
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() + 1);
    const start = new Date(end.getTime() - DAYS[period] * 86_400_000);
    const previous = new Date(start.getTime() - DAYS[period] * 86_400_000);
    return { from: start.toISOString(), to: end.toISOString(), previousFrom: previous.toISOString() };
  }, [period]);
  const filters = React.useMemo(() => {
    const kept: Record<string, string[]> = {};
    if (offer) kept.offer = [offer];
    if (tier) kept.score_tier = [tier];
    if (category) kept.category = [category];
    return kept;
  }, [offer, tier, category]);
  return {
    period,
    setPeriod,
    offer,
    setOffer,
    tier,
    setTier,
    category,
    setCategory,
    ...range,
    filters,
    /** Days in the period (week vs day buckets). */
    days: DAYS[period],
  };
}
export type AnalyticsFilters = ReturnType<typeof useAnalyticsFilters>;
