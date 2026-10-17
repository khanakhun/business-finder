'use client';

import { FUNNEL_STEPS } from '@bf/contracts';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCohorts, useFunnel } from '../api.ts';
import type { AnalyticsFilters } from '../period.ts';
import {
  CHART_COLORS,
  DataTable,
  ExportButton,
  Freshness,
  MetricInfo,
  Panel,
  useMetrics,
} from '../shared.tsx';

// Funnel and cohorts (BF-058): the period's steps from discovered to won with the conversion from the step before
// (segmentable by one dimension), then businesses by week of first contact and what they did since.

const SEGMENTS = ['none', 'offer', 'score_tier', 'category', 'area'] as const;

export function FunnelPanel({ filters }: { readonly filters: AnalyticsFilters }) {
  const t = useTranslations('analytics.funnel');
  const { label } = useMetrics();
  const format = useFormatter();
  const [segment, setSegment] = React.useState<(typeof SEGMENTS)[number]>('none');
  const period = {
    from: filters.from,
    to: filters.to,
    ...(segment !== 'none' ? { dimension: segment } : {}),
  };
  const funnel = useFunnel(period);
  const cohorts = useCohorts({ from: filters.from, to: filters.to });
  const rate = (value: number, of: number) =>
    of > 0 ? format.number(value / of, { style: 'percent', maximumFractionDigits: 1 }) : '—';
  const total = funnel.data?.segments.reduce<number[]>(
    (sum, row) => row.counts.map((count, i) => count + (sum[i] ?? 0)),
    [],
  );
  const chart = FUNNEL_STEPS.map((step, i) => ({ step: label(step), count: total?.[i] ?? 0 }));
  return (
    <div className="space-y-4">
      <Panel
        title={t('title')}
        description={t('hint')}
        actions={
          <ExportButton
            query={{
              metrics: [...FUNNEL_STEPS],
              dimensions: segment !== 'none' ? [segment] : [],
              from: filters.from,
              to: filters.to,
            }}
            filename="analytics-funnel.csv"
          />
        }
      >
        <div className="space-y-1">
          <Label htmlFor="funnel-segment">{t('segmentBy')}</Label>
          <Select value={segment} onValueChange={(value) => setSegment(value as typeof segment)}>
            <SelectTrigger id="funnel-segment" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEGMENTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === 'none' ? t('noSegment') : label(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!funnel.data || !total ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <div className="h-64 w-full" role="img" aria-label={t('summary')}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="step" width={150} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="count" name={t('businesses')} fill={CHART_COLORS[0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ol className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {FUNNEL_STEPS.map((step, i) => (
                <li key={step} className="rounded-lg border p-2">
                  <p className="flex items-center gap-1 text-muted-foreground">
                    {label(step)}
                    <MetricInfo id={step} />
                  </p>
                  <p className="text-lg font-semibold tabular-nums">{format.number(total[i] ?? 0)}</p>
                  {i > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('fromPrevious', { rate: rate(total[i] ?? 0, total[i - 1] ?? 0) })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
            {segment !== 'none' ? (
              <DataTable
                caption={t('bySegment')}
                columns={[
                  { key: 'segment', label: label(segment) },
                  ...FUNNEL_STEPS.map((step) => ({ key: step, label: label(step) })),
                ]}
                rows={funnel.data.segments.map((row) => ({
                  segment: row.label ?? row.segment ?? t('unknown'),
                  ...Object.fromEntries(
                    FUNNEL_STEPS.map((step, i) => [step, format.number(row.counts[i] ?? 0)]),
                  ),
                }))}
              />
            ) : null}
            <p className="text-xs text-muted-foreground">{t('periodNote')}</p>
            <Freshness freshness={funnel.data.freshness} />
          </>
        )}
      </Panel>
      <Panel title={t('cohorts')} description={t('cohortsHint')}>
        {!cohorts.data ? (
          <Skeleton className="h-40 w-full" />
        ) : cohorts.data.weeks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noCohorts')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">{t('cohorts')}</caption>
              <thead>
                <tr>
                  {(['week', 'contacted', 'replied', 'positive', 'meetings', 'won'] as const).map((key) => (
                    <th key={key} scope="col" className="border-b px-2 py-1 font-medium">
                      {t(`cohort.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohorts.data.weeks.map((week) => (
                  <tr key={week.week}>
                    <th scope="row" className="border-b px-2 py-1 font-normal">
                      {format.dateTime(new Date(`${week.week}T12:00:00Z`), {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </th>
                    <td className="border-b px-2 py-1 tabular-nums">{week.contacted}</td>
                    {(['replied', 'positive', 'meetings', 'won'] as const).map((key) => (
                      <td key={key} className="border-b px-2 py-1 tabular-nums">
                        {week[key]}{' '}
                        <span className="text-muted-foreground">({rate(week[key], week.contacted)})</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
