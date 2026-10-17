'use client';

import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useTranslations } from 'next-intl';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAnalyticsQuery, useTrends } from '../api.ts';
import type { AnalyticsFilters } from '../period.ts';
import {
  CHART_COLORS,
  DataTable,
  ExportButton,
  Freshness,
  MetricInfo,
  Panel,
  SampleNote,
  useFormatMetric,
  useMetrics,
} from '../shared.tsx';

// Preview engagement (BF-058): how many previews were published and viewed, page views over time, and the leads
// they brought.

const METRICS = [
  'previews_published',
  'previews_viewed',
  'preview_view_rate',
  'page_views',
  'leads',
  'lead_rate',
] as const;

export function PreviewsPanel({ filters }: { readonly filters: AnalyticsFilters }) {
  const t = useTranslations('analytics.previews');
  const { label } = useMetrics();
  const formatMetric = useFormatMetric();
  const format = useFormatter();
  const query = {
    metrics: [...METRICS],
    dimensions: [],
    filters: filters.filters,
    from: filters.from,
    to: filters.to,
  };
  const result = useAnalyticsQuery(query);
  const trends = useTrends({ from: filters.from, to: filters.to });
  const row = result.data?.rows[0];
  const views = (trends.data?.days ?? []).map((day) => ({
    label: format.dateTime(new Date(`${day.day}T12:00:00Z`), { day: 'numeric', month: 'short' }),
    pageViews: day.pageViews,
    leads: day.leads,
  }));
  return (
    <div className="space-y-4">
      <Panel
        title={t('title')}
        description={t('hint')}
        actions={<ExportButton query={query} filename="analytics-previews.csv" />}
      >
        {!row ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-3">
            {METRICS.map((id) => (
              <li key={id} className="rounded-lg border p-3">
                <p className="flex items-center gap-1 text-sm text-muted-foreground">
                  {label(id)}
                  <MetricInfo id={id} />
                </p>
                <p className="text-xl font-semibold tabular-nums">
                  {formatMetric(id, row[id] as number | null)}
                </p>
                <SampleNote n={row[`${id}__n`] as number | undefined} />
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t('timeToViewNote')}</p>
        <Freshness freshness={result.data?.freshness} />
      </Panel>
      <Panel title={t('views')}>
        {!trends.data ? (
          <Skeleton className="h-56 w-full" />
        ) : views.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <div className="h-56 w-full" role="img" aria-label={t('viewsSummary')}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={views} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={24} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Area
                    dataKey="pageViews"
                    name={label('page_views')}
                    stroke={CHART_COLORS[0]}
                    fill={CHART_COLORS[0]}
                    fillOpacity={0.2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <DataTable
              caption={t('views')}
              columns={[
                { key: 'label', label: t('day') },
                { key: 'pageViews', label: label('page_views') },
                { key: 'leads', label: label('leads') },
              ]}
              rows={views}
            />
          </>
        )}
      </Panel>
    </div>
  );
}
