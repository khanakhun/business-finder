'use client';

import { Skeleton } from '@bf/ui/components/skeleton';
import { useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAnalyticsQuery } from '../api.ts';
import type { AnalyticsFilters } from '../period.ts';
import {
  CHART_COLORS,
  ExportButton,
  Freshness,
  MetricInfo,
  Panel,
  SampleNote,
  useFormatMetric,
  useMetrics,
} from '../shared.tsx';

// Engines (BF-058): per site generation engine — success and review rates, quality, time, cost — and the positive
// reply rate of emails whose business's site came from that engine.

const METRICS = [
  'jobs_finished',
  'generation_success_rate',
  'needs_review_rate',
  'avg_quality_score',
  'time_selection_to_preview',
  'generation_cost',
  'positive_reply_rate',
] as const;

export function EnginesPanel({ filters }: { readonly filters: AnalyticsFilters }) {
  const t = useTranslations('analytics.engines');
  const { label } = useMetrics();
  const formatMetric = useFormatMetric();
  const query = {
    metrics: [...METRICS],
    dimensions: ['engine'],
    filters: filters.filters,
    from: filters.from,
    to: filters.to,
  };
  const result = useAnalyticsQuery(query);
  const rows = (result.data?.rows ?? []).filter((row) => row.engine !== null);
  const chart = rows.map((row) => ({
    engine: String(row.engine),
    success: row.generation_success_rate as number | null,
    review: row.needs_review_rate as number | null,
  }));
  return (
    <Panel
      title={t('title')}
      description={t('hint')}
      actions={<ExportButton query={query} filename="analytics-engines.csv" />}
    >
      {!result.data ? (
        <Skeleton className="h-56 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <div className="h-56 w-full" role="img" aria-label={t('summary')}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="engine" tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="success" name={label('generation_success_rate')} fill={CHART_COLORS[0]} />
                <Bar dataKey="review" name={label('needs_review_rate')} fill={CHART_COLORS[1]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">{t('title')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="border-b px-2 py-1 font-medium">
                    {label('engine')}
                  </th>
                  {METRICS.map((id) => (
                    <th key={id} scope="col" className="border-b px-2 py-1 font-medium">
                      <span className="inline-flex items-center gap-1">
                        {label(id)}
                        <MetricInfo id={id} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={String(row.engine)}>
                    <th scope="row" className="border-b px-2 py-1 font-normal">
                      {String(row.engine)}
                    </th>
                    {METRICS.map((id) => (
                      <td key={id} className="border-b px-2 py-1 tabular-nums">
                        {formatMetric(id, row[id] as number | null)}{' '}
                        <SampleNote n={row[`${id}__n`] as number | undefined} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t('acceptanceNote')}</p>
          <Freshness freshness={result.data.freshness} />
        </>
      )}
    </Panel>
  );
}
