'use client';

import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, ErrorBar, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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
import { MIN_SAMPLE, wilson } from '../stats.ts';

// Scoring validation (BF-058, feeds BF-059): does a better tier or score convert better? The positive reply and win
// rates by tier and by score decile — the tier at the time of contact — with intervals and the lift over everyone.

const METRICS = ['businesses_contacted', 'positive_reply_rate', 'win_rate'];

function Breakdown({
  dimension,
  filters,
}: {
  readonly dimension: 'score_tier' | 'score_bucket';
  readonly filters: AnalyticsFilters;
}) {
  const t = useTranslations('analytics.scoring');
  const { label } = useMetrics();
  const formatMetric = useFormatMetric();
  const format = useFormatter();
  const query = {
    metrics: METRICS,
    dimensions: [dimension],
    filters: filters.filters,
    from: filters.from,
    to: filters.to,
  };
  const result = useAnalyticsQuery(query);
  const overall = useAnalyticsQuery({ ...query, dimensions: [] });
  const base = overall.data?.rows[0]?.positive_reply_rate as number | null | undefined;
  const rows = (result.data?.rows ?? []).filter((row) => row[dimension] !== null);
  const chart = rows.map((row) => {
    const n = Number(row.positive_reply_rate__n ?? 0);
    const k = Number(row.positive_reply_rate__num ?? 0);
    const interval = wilson(k, n);
    const rate = (row.positive_reply_rate as number | null) ?? 0;
    return {
      segment: String(row[dimension]),
      rate,
      error: interval ? [rate - interval.low, interval.high - rate] : [0, 0],
      n,
    };
  });
  return (
    <Panel
      title={label(dimension)}
      description={t(dimension === 'score_tier' ? 'tierHint' : 'decileHint')}
      actions={<ExportButton query={query} filename={`analytics-${dimension}.csv`} />}
    >
      {!result.data ? (
        <Skeleton className="h-56 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            {label('positive_reply_rate')}
            <MetricInfo id="positive_reply_rate" />
          </p>
          <div className="h-56 w-full" role="img" aria-label={t('summary', { dimension: label(dimension) })}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="segment" tick={{ fontSize: 11 }} />
                <YAxis
                  tickFormatter={(v: number) => format.number(v, { style: 'percent' })}
                  tick={{ fontSize: 10 }}
                />
                <Tooltip
                  formatter={(value) =>
                    format.number(Number(value), { style: 'percent', maximumFractionDigits: 1 })
                  }
                />
                <Bar dataKey="rate" name={label('positive_reply_rate')} fill={CHART_COLORS[0]}>
                  <ErrorBar dataKey="error" width={4} strokeWidth={1} stroke="currentColor" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <DataTable
            caption={label(dimension)}
            columns={[
              { key: 'segment', label: label(dimension) },
              { key: 'contacted', label: label('businesses_contacted') },
              { key: 'rate', label: label('positive_reply_rate') },
              { key: 'interval', label: t('interval') },
              { key: 'lift', label: t('lift') },
              { key: 'win', label: label('win_rate') },
            ]}
            rows={rows.map((row) => {
              const n = Number(row.positive_reply_rate__n ?? 0);
              const interval = wilson(Number(row.positive_reply_rate__num ?? 0), n);
              const rate = row.positive_reply_rate as number | null;
              return {
                segment: String(row[dimension]),
                contacted: format.number(n),
                rate:
                  n < MIN_SAMPLE
                    ? `${formatMetric('positive_reply_rate', rate)} (${t('small')})`
                    : formatMetric('positive_reply_rate', rate),
                interval: interval
                  ? `${formatMetric('positive_reply_rate', interval.low)} – ${formatMetric('positive_reply_rate', interval.high)}`
                  : '—',
                lift:
                  rate !== null && base
                    ? `${format.number(rate / base, { maximumFractionDigits: 2 })}×`
                    : '—',
                win: formatMetric('win_rate', row.win_rate as number | null),
              };
            })}
          />
          <Freshness freshness={result.data.freshness} />
        </>
      )}
    </Panel>
  );
}

export function ScoringPanel({ filters }: { readonly filters: AnalyticsFilters }) {
  const t = useTranslations('analytics.scoring');
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <Breakdown dimension="score_tier" filters={filters} />
      <Breakdown dimension="score_bucket" filters={filters} />
    </div>
  );
}
