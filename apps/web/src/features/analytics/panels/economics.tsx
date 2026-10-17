'use client';

import { Skeleton } from '@bf/ui/components/skeleton';
import { useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAnalyticsQuery } from '../api.ts';
import type { AnalyticsFilters } from '../period.ts';
import {
  CHART_COLORS,
  DataTable,
  ExportButton,
  Freshness,
  MetricInfo,
  Panel,
  useFormatMetric,
  useMetrics,
} from '../shared.tsx';

// Unit economics (BF-058): spend by category and feature, and what a site, a contact, a positive reply and a lead
// cost.

const TOTALS = [
  'spend',
  'spend_llm',
  'spend_providers',
  'cost_per_site',
  'cost_per_contact',
  'cost_per_positive_reply',
  'cost_per_lead',
] as const;

export function EconomicsPanel({ filters }: { readonly filters: AnalyticsFilters }) {
  const t = useTranslations('analytics.economics');
  const { label } = useMetrics();
  const formatMetric = useFormatMetric();
  const totals = {
    metrics: [...TOTALS],
    dimensions: [],
    filters: filters.filters,
    from: filters.from,
    to: filters.to,
  };
  const byFeature = {
    metrics: ['spend'],
    dimensions: ['cost_category', 'feature'],
    filters: {},
    from: filters.from,
    to: filters.to,
  };
  const result = useAnalyticsQuery(totals);
  const features = useAnalyticsQuery(byFeature);
  const row = result.data?.rows[0];
  const chart = (features.data?.rows ?? [])
    .filter((r) => r.feature !== null && Number(r.spend ?? 0) > 0)
    .map((r) => ({
      feature: String(r.feature),
      category: String(r.cost_category ?? ''),
      spend: Number(r.spend ?? 0),
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 12);
  return (
    <div className="space-y-4">
      <Panel
        title={t('title')}
        description={t('hint')}
        actions={<ExportButton query={totals} filename="analytics-economics.csv" />}
      >
        {!row ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TOTALS.map((id) => (
              <li key={id} className="rounded-lg border p-3">
                <p className="flex items-center gap-1 text-sm text-muted-foreground">
                  {label(id)}
                  <MetricInfo id={id} />
                </p>
                <p className="text-xl font-semibold tabular-nums">
                  {formatMetric(id, row[id] as number | null)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Freshness freshness={result.data?.freshness} />
      </Panel>
      <Panel
        title={t('byFeature')}
        actions={<ExportButton query={byFeature} filename="analytics-spend.csv" />}
      >
        {!features.data ? (
          <Skeleton className="h-56 w-full" />
        ) : chart.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <div className="h-64 w-full" role="img" aria-label={t('summary')}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="feature" width={180} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(value) => formatMetric('spend', Number(value))} />
                  <Bar dataKey="spend" name={label('spend')} fill={CHART_COLORS[1]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <DataTable
              caption={t('byFeature')}
              columns={[
                { key: 'feature', label: label('feature') },
                { key: 'category', label: label('cost_category') },
                { key: 'spend', label: label('spend') },
              ]}
              rows={chart.map((r) => ({ ...r, spend: formatMetric('spend', r.spend) }))}
            />
          </>
        )}
      </Panel>
    </div>
  );
}
