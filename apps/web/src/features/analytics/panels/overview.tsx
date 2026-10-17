'use client';

import { Skeleton } from '@bf/ui/components/skeleton';
import { ArrowDownRightIcon, ArrowUpRightIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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

// Overview (BF-058): the KPIs against the previous period of the same length, the PRD §8 targets, and daily trends.

const KPIS = [
  'businesses_contacted',
  'positive_reply_rate',
  'leads',
  'won',
  'cost_per_lead',
  'time_prompt_to_list',
  'time_selection_to_preview',
] as const;

/** PRD §8 targets: a rate to reach, or a duration (ms) to stay under. */
const TARGETS: Partial<Record<(typeof KPIS)[number], { kind: 'atLeast' | 'atMost'; value: number }>> = {
  positive_reply_rate: { kind: 'atLeast', value: 0.03 },
  time_prompt_to_list: { kind: 'atMost', value: 10 * 60_000 },
  time_selection_to_preview: { kind: 'atMost', value: 15 * 60_000 },
};

/** Lower is better for costs and durations. */
const LOWER_IS_BETTER = new Set(['cost_per_lead', 'time_prompt_to_list', 'time_selection_to_preview']);

export function OverviewPanel({ filters }: { readonly filters: AnalyticsFilters }) {
  const t = useTranslations('analytics.overview');
  const { label } = useMetrics();
  const formatMetric = useFormatMetric();
  const format = useFormatter();
  const query = {
    metrics: [...KPIS],
    dimensions: [],
    filters: filters.filters,
    from: filters.from,
    to: filters.to,
  };
  const current = useAnalyticsQuery(query);
  const previous = useAnalyticsQuery({ ...query, from: filters.previousFrom, to: filters.from });
  const trends = useTrends({ from: filters.from, to: filters.to });
  const now = current.data?.rows[0];
  const before = previous.data?.rows[0];
  const trendData = (trends.data?.days ?? []).map((day) => ({
    ...day,
    label: format.dateTime(new Date(`${day.day}T12:00:00Z`), { day: 'numeric', month: 'short' }),
  }));
  return (
    <div className="space-y-4">
      <Panel
        title={t('kpis')}
        description={t('kpisHint')}
        actions={<ExportButton query={query} filename="analytics-overview.csv" />}
      >
        {!now ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {KPIS.map((id) => (
              <Skeleton key={id} className="h-24" />
            ))}
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {KPIS.map((id) => {
              const value = now[id] as number | null;
              const old = before?.[id] as number | null | undefined;
              const change =
                value !== null && old !== null && old !== undefined && old !== 0 ? (value - old) / old : null;
              const better = change === null ? null : LOWER_IS_BETTER.has(id) ? change < 0 : change > 0;
              const target = TARGETS[id];
              const met =
                target && value !== null
                  ? target.kind === 'atLeast'
                    ? value >= target.value
                    : value <= target.value
                  : null;
              return (
                <li key={id} className="space-y-1 rounded-lg border p-3">
                  <p className="flex items-center gap-1 text-sm text-muted-foreground">
                    {label(id)}
                    <MetricInfo id={id} />
                  </p>
                  <p className="text-2xl font-semibold tabular-nums">{formatMetric(id, value)}</p>
                  <SampleNote n={now[`${id}__n`] as number | undefined} />
                  {change !== null ? (
                    <p
                      className={`flex items-center gap-1 text-xs ${better ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`}
                    >
                      {change >= 0 ? (
                        <ArrowUpRightIcon aria-hidden className="size-3" />
                      ) : (
                        <ArrowDownRightIcon aria-hidden className="size-3" />
                      )}
                      {t('change', {
                        change: format.number(change, {
                          style: 'percent',
                          maximumFractionDigits: 0,
                          signDisplay: 'always',
                        }),
                      })}
                    </p>
                  ) : null}
                  {target ? (
                    <p className="text-xs text-muted-foreground">
                      {t(target.kind === 'atLeast' ? 'targetAtLeast' : 'targetAtMost', {
                        target: formatMetric(id, target.value),
                      })}
                      {met === null ? null : met ? ` · ${t('targetMet')}` : ` · ${t('targetMissed')}`}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <Freshness freshness={current.data?.freshness} />
      </Panel>
      <Panel title={t('trends')} description={t('trendsHint')}>
        {!trends.data ? (
          <Skeleton className="h-64 w-full" />
        ) : trendData.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noTrends')}</p>
        ) : (
          <>
            <div className="h-64 w-full" role="img" aria-label={t('trendsSummary')}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={24} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    dataKey="emailsSent"
                    name={label('emails_sent')}
                    stroke={CHART_COLORS[0]}
                    dot={false}
                  />
                  <Line
                    dataKey="previewsPublished"
                    name={label('previews_published')}
                    stroke={CHART_COLORS[1]}
                    dot={false}
                  />
                  <Line dataKey="leads" name={label('leads')} stroke={CHART_COLORS[2]} dot={false} />
                  <Line
                    dataKey="businessesDiscovered"
                    name={label('businesses_discovered')}
                    stroke={CHART_COLORS[3]}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <DataTable
              caption={t('trends')}
              columns={[
                { key: 'day', label: t('day') },
                { key: 'emailsSent', label: label('emails_sent') },
                { key: 'previewsPublished', label: label('previews_published') },
                { key: 'leads', label: label('leads') },
                { key: 'businessesDiscovered', label: label('businesses_discovered') },
              ]}
              rows={trendData}
            />
          </>
        )}
      </Panel>
    </div>
  );
}
