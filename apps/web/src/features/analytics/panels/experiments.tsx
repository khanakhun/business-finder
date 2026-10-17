'use client';

import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { useAnalyticsQuery } from '../api.ts';
import type { AnalyticsFilters } from '../period.ts';
import {
  ExportButton,
  Freshness,
  MetricInfo,
  Panel,
  SampleNote,
  useFormatMetric,
  useMetrics,
} from '../shared.tsx';
import { MIN_SAMPLE, separated, wilson } from '../stats.ts';

// Experiments (BF-058): templates, template versions, sequence variants and offers compared on reply and positive
// reply rates, each with its 95% interval and sample. No winner is declared: intervals that do not overlap are
// flagged as worth a look.

const BY = ['template_version', 'variant', 'template', 'offer'] as const;
const RATES = ['reply_rate', 'positive_reply_rate'] as const;

export function ExperimentsPanel({ filters }: { readonly filters: AnalyticsFilters }) {
  const t = useTranslations('analytics.experiments');
  const { label } = useMetrics();
  const formatMetric = useFormatMetric();
  const format = useFormatter();
  const [by, setBy] = React.useState<(typeof BY)[number]>('template_version');
  const query = {
    metrics: ['emails_sent', ...RATES],
    dimensions: [by],
    filters: filters.filters,
    from: filters.from,
    to: filters.to,
  };
  const result = useAnalyticsQuery(query);
  const rows = (result.data?.rows ?? []).filter((row) => row[by] !== null);
  const intervals = rows.map((row) =>
    wilson(Number(row.positive_reply_rate__num ?? 0), Number(row.positive_reply_rate__n ?? 0)),
  );
  return (
    <Panel
      title={t('title')}
      description={t('hint')}
      actions={<ExportButton query={query} filename={`analytics-${by}.csv`} />}
    >
      <div className="space-y-1">
        <Label htmlFor="experiments-by">{t('compare')}</Label>
        <Select value={by} onValueChange={(value) => setBy(value as typeof by)}>
          <SelectTrigger id="experiments-by" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BY.map((value) => (
              <SelectItem key={value} value={value}>
                {label(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!result.data ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">{t('title')}</caption>
            <thead>
              <tr>
                <th scope="col" className="border-b px-2 py-1 font-medium">
                  {label(by)}
                </th>
                <th scope="col" className="border-b px-2 py-1 font-medium">
                  {label('emails_sent')}
                </th>
                {RATES.map((rate) => (
                  <th key={rate} scope="col" className="border-b px-2 py-1 font-medium">
                    <span className="inline-flex items-center gap-1">
                      {label(rate)}
                      <MetricInfo id={rate} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const value = String(row[by]);
                const flagged = intervals.some(
                  (other, j) => j !== i && separated(intervals[i] ?? null, other),
                );
                return (
                  <tr key={value}>
                    <th scope="row" className="border-b px-2 py-1 font-normal">
                      {result.data?.labels[by]?.[value] ?? value}
                      {flagged ? (
                        <span className="ml-2 text-xs text-muted-foreground">{t('worthALook')}</span>
                      ) : null}
                    </th>
                    <td className="border-b px-2 py-1 tabular-nums">
                      {format.number(Number(row.emails_sent ?? 0))}
                    </td>
                    {RATES.map((rate) => {
                      const n = Number(row[`${rate}__n`] ?? 0);
                      const interval = wilson(Number(row[`${rate}__num`] ?? 0), n);
                      return (
                        <td
                          key={rate}
                          className={`border-b px-2 py-1 tabular-nums ${n < MIN_SAMPLE ? 'text-muted-foreground' : ''}`}
                        >
                          {formatMetric(rate, row[rate] as number | null)}
                          {interval ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({formatMetric(rate, interval.low)} – {formatMetric(rate, interval.high)})
                            </span>
                          ) : null}{' '}
                          <SampleNote n={n} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('noWinner')}</p>
      <Freshness freshness={result.data?.freshness} />
    </Panel>
  );
}
