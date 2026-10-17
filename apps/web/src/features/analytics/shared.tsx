'use client';

import type { AnalyticsFreshness, AnalyticsQuery, MetricDefinition } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@bf/ui/components/popover';
import { DownloadIcon, InfoIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { downloadCsv, useAnalyticsRegistry } from './api.ts';
import { MIN_SAMPLE } from './stats.ts';

// Pieces every analytics panel uses (BF-058): metric labels and "How is this calculated?", value formatting by the
// metric's format, small-sample muting, freshness, the table alternative to a chart, and the CSV export.

export function useMetrics() {
  const registry = useAnalyticsRegistry();
  const locale: 'en' | 'fr' = useLocale() === 'fr' ? 'fr' : 'en';
  return React.useMemo(() => {
    const metrics = new Map((registry.data?.metrics ?? []).map((m) => [m.id, m]));
    const dimensions = new Map((registry.data?.dimensions ?? []).map((d) => [d.id, d]));
    return {
      ready: registry.data !== undefined,
      metric: (id: string) => metrics.get(id),
      label: (id: string) => metrics.get(id)?.label[locale] ?? dimensions.get(id)?.label[locale] ?? id,
      locale,
    };
  }, [registry.data, locale]);
}

/** Formats a metric's value by its format (rates as percentages, money in USD, durations in minutes). */
export function useFormatMetric() {
  const format = useFormatter();
  const { metric } = useMetrics();
  return (id: string, value: number | string | null | undefined) => {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    switch (metric(id)?.format) {
      case 'rate':
        return format.number(n, { style: 'percent', maximumFractionDigits: 1 });
      case 'usd':
        return format.number(n, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: n < 10 ? 2 : 0,
        });
      case 'duration':
        return format.number(n / 60_000, { style: 'unit', unit: 'minute', maximumFractionDigits: 1 });
      case 'score':
        return format.number(n, { maximumFractionDigits: 1 });
      default:
        return format.number(n, { maximumFractionDigits: 0 });
    }
  };
}

/** "How is this calculated?" for one metric. */
export function MetricInfo({ id }: { readonly id: string }) {
  const t = useTranslations('analytics');
  const { metric, locale, label } = useMetrics();
  const spec: MetricDefinition | undefined = metric(id);
  if (!spec) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('howCalculated', { metric: spec.label[locale] })}
        >
          <InfoIcon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-sm">
        <p className="font-medium">{spec.label[locale]}</p>
        <p>{spec.description[locale]}</p>
        {spec.numerator && spec.denominator ? (
          <p className="text-muted-foreground">
            {t('formula', { numerator: label(spec.numerator), denominator: label(spec.denominator) })}
          </p>
        ) : null}
        {spec.caveats ? <p className="text-xs text-muted-foreground">{spec.caveats[locale]}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

/** A rate on fewer than 30 cases: shown muted, with a warning. */
export function SampleNote({ n }: { readonly n: number | null | undefined }) {
  const t = useTranslations('analytics');
  if (n === null || n === undefined || n >= MIN_SAMPLE) return null;
  return (
    <Badge variant="outline" className="text-muted-foreground" title={t('smallSampleHint')}>
      {t('smallSample', { n })}
    </Badge>
  );
}

export function Freshness({ freshness }: { readonly freshness: AnalyticsFreshness | undefined }) {
  const t = useTranslations('analytics');
  const format = useFormatter();
  if (!freshness?.watermark) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t('freshness', { when: format.relativeTime(new Date(freshness.watermark)) })}
    </p>
  );
}

/** The accessible alternative to a chart: the same numbers in a table, folded by default. */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  readonly caption: string;
  readonly columns: readonly { key: string; label: string }[];
  readonly rows: readonly Record<string, React.ReactNode>[];
}) {
  const t = useTranslations('analytics');
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">{t('showTable')}</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className="border-b px-2 py-1 font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((column) => (
                  <td key={column.key} className="border-b px-2 py-1 tabular-nums">
                    {row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function ExportButton({
  query,
  filename,
}: {
  readonly query: AnalyticsQuery;
  readonly filename: string;
}) {
  const t = useTranslations('analytics');
  const allowed = usePermission('analytics:export');
  const [busy, setBusy] = React.useState(false);
  if (!allowed) return null;
  const run = async () => {
    setBusy(true);
    try {
      await downloadCsv(query, filename);
    } catch (error) {
      const problem = toProblemLike(error, t('exportFailed'));
      (await getToast()).error(problem.detail ?? problem.title);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={() => void run()} disabled={busy}>
      <DownloadIcon aria-hidden />
      {t('export')}
    </Button>
  );
}

/** A panel's frame: title, info, export, freshness. */
export function Panel({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-start gap-2">
        <div className="mr-auto">
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** Shared chart colors (the theme's, with fallbacks). */
export const CHART_COLORS = [
  'var(--color-lagoon, #0e7490)',
  'var(--color-coral, #f97316)',
  'var(--color-chart-3, #6366f1)',
  'var(--color-chart-4, #16a34a)',
  'var(--color-chart-5, #e11d48)',
  'var(--color-chart-6, #a16207)',
] as const;
