'use client';

import type { ScoreContribution } from '@bf/contracts';
import { useTranslations } from 'next-intl';

// Feature values in the dashboard's words (BF-032): enum values with the labels the dashboard already uses for them,
// reason keys (yes, no, below, above, any value, filled in). Unknown values read as they are.

type Feature = ScoreContribution['feature'];

/** Where the dashboard already names an enum feature's values. */
const ENUM_MESSAGES: Partial<Record<Feature, string>> = {
  website_status: 'enrichment.audit.statuses',
  operating_status: 'business.operating',
  pipeline_status: 'search.status',
};

const REASON_KEYS = ['true', 'false', 'below', 'above', 'value', 'missing'] as const;

export function useValueLabel(): (feature: Feature, value: string) => string {
  const all = useTranslations();
  const keys = useTranslations('scoringEditor.valueKeys');
  return (feature, value) => {
    if ((REASON_KEYS as readonly string[]).includes(value))
      return keys(value as (typeof REASON_KEYS)[number]);
    const namespace = ENUM_MESSAGES[feature];
    // Keys built at runtime: checked with `has` (an unknown value reads as is).
    const key = `${namespace}.${value}` as Parameters<typeof all>[0];
    return namespace && all.has(key) ? all(key) : value;
  };
}
