'use client';

import type { ScoreTier, ScoringPreviewSample, ScoringProfileConfig } from '@bf/contracts';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { explainAll } from '../api.ts';
import { ScoreBadge } from '../score-badge.tsx';
import { type Scored, spearman, TIERS, type TierCounts, tierCounts, topMovers } from './preview-stats.ts';

// Live preview (BF-032): the sample scored with the draft by the server's engine (debounced, batches of 50), against
// the sample's current scores — tier distribution, rank correlation and the businesses that move most. Nothing is
// stored. The chart is decorative; the table next to it carries the numbers.

const DEBOUNCE_MS = 700;

type SampleItem = ScoringPreviewSample['items'][number];

/** The sample's businesses that have a current score. */
export const currentScores = (items: readonly SampleItem[]): Scored[] =>
  items.flatMap((item) =>
    item.score !== null && item.tier !== null
      ? [{ businessId: item.businessId, score: item.score, tier: item.tier }]
      : [],
  );

export type DraftScores =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'done'; readonly items: Scored[]; readonly ms: number }
  | { readonly status: 'error'; readonly error: unknown };

/**
 * Scores a config over the sample when either changes (debounced); the previous run is cancelled. The same config
 * over the same businesses is not scored twice in a row (a refetched sample or an undo costs no calls).
 */
export function useDraftScores(
  config: ScoringProfileConfig | null,
  sample: readonly SampleItem[] | undefined,
) {
  const [state, setState] = React.useState<DraftScores>({ status: 'idle' });
  const ids = sample?.map((item) => item.businessId).join(',') ?? '';
  const key = config && ids ? `${JSON.stringify(config)}|${ids}` : null;
  const scored = React.useRef<{ key: string; state: DraftScores } | null>(null);
  React.useEffect(() => {
    if (!key || !config) return;
    if (scored.current?.key === key) {
      setState(scored.current.state);
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    const timer = window.setTimeout(async () => {
      const started = performance.now();
      try {
        const items = await explainAll(config, ids.split(','), controller.signal);
        if (controller.signal.aborted) return;
        const done: DraftScores = {
          status: 'done',
          items: items.map((item) => ({
            businessId: item.businessId,
            score: item.score,
            tier: item.tier as ScoreTier,
          })),
          ms: Math.round(performance.now() - started),
        };
        scored.current = { key, state: done };
        setState(done);
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', error });
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `key` stands for the config's content and the sample's businesses (new objects on each edit or refetch).
  }, [key]);
  return state;
}

export function Distribution({
  current,
  draft,
  labels,
}: {
  readonly current: TierCounts;
  readonly draft: TierCounts;
  readonly labels: {
    readonly caption: string;
    readonly current: string;
    readonly draft: string;
    readonly tier: string;
  };
}) {
  const data = TIERS.map((tier) => ({ tier, current: current[tier], draft: draft[tier] }));
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
      <div aria-hidden className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} accessibilityLayer={false} margin={{ left: -16, right: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="tier" />
            <YAxis allowDecimals={false} />
            <Legend />
            <Bar
              dataKey="current"
              name={labels.current}
              fill="var(--color-slate-400, #94a3b8)"
              isAnimationActive={false}
            />
            <Bar
              dataKey="draft"
              name={labels.draft}
              fill="var(--color-sky-600, #0284c7)"
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="text-sm" data-testid="tier-distribution">
        <caption className="sr-only">{labels.caption}</caption>
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="px-2 text-left font-normal">
              {labels.tier}
            </th>
            <th scope="col" className="px-2 text-right font-normal">
              {labels.current}
            </th>
            <th scope="col" className="px-2 text-right font-normal">
              {labels.draft}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.tier} className="border-t">
              <th scope="row" className="px-2 text-left font-medium">
                {row.tier}
              </th>
              <td className="px-2 text-right tabular-nums">{row.current}</td>
              <td className="px-2 text-right tabular-nums">{row.draft}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PreviewPanel({
  config,
  sample,
  invalid,
}: {
  readonly config: ScoringProfileConfig | null;
  readonly sample: ScoringPreviewSample | undefined;
  readonly invalid: boolean;
}) {
  const t = useTranslations('scoringEditor.preview');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const items = sample?.items;
  const scores = useDraftScores(invalid ? null : config, items);
  const names = new Map((items ?? []).map((item) => [item.businessId, item.displayName]));
  const current = currentScores(items ?? []);

  let body: React.ReactNode;
  if (invalid) body = <p className="text-sm text-muted-foreground">{t('invalid')}</p>;
  else if (!items) body = <p className="text-sm text-muted-foreground">{t('loadingSample')}</p>;
  else if (items.length === 0) body = <p className="text-sm text-muted-foreground">{t('emptySample')}</p>;
  else if (scores.status === 'error')
    body = (
      <p role="alert" className="text-sm text-destructive">
        {(scores.error as { status?: number } | null)?.status === 429
          ? t('throttled')
          : t('failed', { reason: errorMessage(scores.error) })}
      </p>
    );
  else if (scores.status !== 'done')
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {t('scoring', { count: items.length })}
      </p>
    );
  else {
    const draft = scores.items;
    const rho = spearman(current, draft);
    const movers = topMovers(current, draft, 10);
    body = (
      <div className="grid gap-4">
        <p role="status" className="text-sm text-muted-foreground" data-testid="preview-status">
          {t('scored', {
            count: draft.length,
            seconds: format.number(scores.ms / 1000, { maximumFractionDigits: 1 }),
          })}
        </p>
        {current.length < draft.length ? (
          <p className="text-sm text-muted-foreground">
            {t('unscored', { count: draft.length - current.length })}
          </p>
        ) : null}
        <Distribution
          current={tierCounts(current)}
          draft={tierCounts(draft)}
          labels={{
            caption: t('distributionCaption'),
            current: t('current'),
            draft: t('draft'),
            tier: t('tier'),
          }}
        />
        <p className="text-sm" data-testid="preview-correlation">
          {rho === null
            ? t('noCorrelation')
            : t('correlation', {
                rho: format.number(rho, { maximumFractionDigits: 2, minimumFractionDigits: 2 }),
              })}
        </p>
        <section aria-labelledby="top-movers">
          <h3 id="top-movers" className="mb-2 text-sm font-medium">
            {t('movers')}
          </h3>
          {movers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noMovers')}</p>
          ) : (
            <ol className="grid gap-1 text-sm" data-testid="top-movers">
              {movers.map((mover) => (
                <li key={mover.businessId} className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/businesses/${mover.businessId}?tab=scores`}
                    className="font-medium hover:underline"
                  >
                    {names.get(mover.businessId) ?? mover.businessId}
                  </Link>
                  <span className="text-muted-foreground">
                    {t(mover.change > 0 ? 'up' : mover.change < 0 ? 'down' : 'same', {
                      places: Math.abs(mover.change),
                    })}
                  </span>
                  <ScoreBadge score={mover.fromScore} tier={mover.fromTier} />
                  <span aria-hidden>→</span>
                  <span className="sr-only">{t('to')}</span>
                  <ScoreBadge score={mover.toScore} tier={mover.toTier} />
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    );
  }
  return (
    <section
      aria-labelledby="preview-title"
      className="grid gap-3 rounded-lg border bg-surface p-4"
      data-testid="preview"
    >
      <div>
        <h2 id="preview-title" className="font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description', { count: items?.length ?? 0 })}</p>
      </div>
      <div aria-busy={scores.status === 'loading'}>{body}</div>
    </section>
  );
}
