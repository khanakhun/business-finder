'use client';

import { Skeleton } from '@bf/ui/components/skeleton';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useAnalyticsQuery } from '../api.ts';
import type { AnalyticsFilters } from '../period.ts';
import { ExportButton, Freshness, MetricInfo, Panel, useFormatMetric, useMetrics } from '../shared.tsx';
import { MIN_SAMPLE } from '../stats.ts';

// Segments (BF-058): the positive reply rate by category × area (a heatmap with each cell's sample), and the same
// rate per area on a map. Cells under 30 contacted businesses are muted.

const AreaMap = dynamic(() => import('../area-map.tsx').then((m) => m.AreaMap), {
  ssr: false,
  loading: () => <Skeleton className="h-72 w-full" />,
});

const METRIC = 'positive_reply_rate';

export function SegmentsPanel({ filters }: { readonly filters: AnalyticsFilters }) {
  const t = useTranslations('analytics.segments');
  const { label } = useMetrics();
  const formatMetric = useFormatMetric();
  const grid = {
    metrics: [METRIC],
    dimensions: ['category', 'area'],
    filters: filters.filters,
    from: filters.from,
    to: filters.to,
  };
  const heat = useAnalyticsQuery(grid);
  const byArea = useAnalyticsQuery({ ...grid, dimensions: ['area'] });
  const data = heat.data;
  const categories = [...new Set((data?.rows ?? []).map((row) => String(row.category ?? '')))];
  const areas = [...new Set((data?.rows ?? []).map((row) => String(row.area ?? '')))];
  const cell = new Map((data?.rows ?? []).map((row) => [`${row.category ?? ''}|${row.area ?? ''}`, row]));
  const max = Math.max(0.0001, ...(data?.rows ?? []).map((row) => Number(row[METRIC] ?? 0)));
  const name = (dimension: 'category' | 'area', value: string) =>
    value ? (data?.labels[dimension]?.[value] ?? value) : t('unknown');
  const mapValues = React.useMemo(
    () =>
      new Map(
        (byArea.data?.rows ?? [])
          .filter((row) => row.area)
          .map((row) => [
            String(row.area),
            { rate: row[METRIC] as number | null, n: Number(row[`${METRIC}__n`] ?? 0) },
          ]),
      ),
    [byArea.data],
  );
  return (
    <div className="space-y-4">
      <Panel
        title={t('heatmap')}
        description={t('heatmapHint')}
        actions={<ExportButton query={grid} filename="analytics-segments.csv" />}
      >
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          {label(METRIC)}
          <MetricInfo id={METRIC} />
        </p>
        {!data ? (
          <Skeleton className="h-64 w-full" />
        ) : data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="border-collapse text-xs">
              <caption className="sr-only">{t('heatmap')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="p-1 text-left font-medium">
                    {label('category')} / {label('area')}
                  </th>
                  {areas.map((area) => (
                    <th key={area} scope="col" className="max-w-28 p-1 text-left font-medium">
                      {name('area', area)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => (
                  <tr key={category}>
                    <th scope="row" className="p-1 text-left font-normal">
                      {name('category', category)}
                    </th>
                    {areas.map((area) => {
                      const row = cell.get(`${category}|${area}`);
                      const n = Number(row?.[`${METRIC}__n`] ?? 0);
                      const value = row?.[METRIC] as number | null | undefined;
                      const small = n < MIN_SAMPLE;
                      const intensity = !small && value ? value / max : 0;
                      return (
                        <td
                          key={area}
                          className={`min-w-20 border p-1 tabular-nums ${small ? 'text-muted-foreground' : ''}`}
                          style={
                            small
                              ? undefined
                              : { backgroundColor: `rgb(14 116 144 / ${0.1 + intensity * 0.6})` }
                          }
                          title={t('cellHint', { n })}
                        >
                          {row ? `${formatMetric(METRIC, value)} · n=${n}` : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('mutedNote', { min: MIN_SAMPLE })}</p>
        <Freshness freshness={data?.freshness} />
      </Panel>
      <Panel title={t('map')} description={t('mapHint')}>
        {byArea.data && mapValues.size > 0 ? (
          <AreaMap values={mapValues} label={t('mapSummary')} />
        ) : byArea.data ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Skeleton className="h-72 w-full" />
        )}
      </Panel>
    </div>
  );
}
