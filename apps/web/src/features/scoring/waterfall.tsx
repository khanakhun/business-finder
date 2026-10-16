'use client';

import type { ScoreContribution } from '@bf/contracts';
import { useFormatter, useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// How a score is built (BF-032): each contribution as a step from the previous total, the adjustment that brings the
// total to the score (clamped to 0–100, capped or excluded by a gate), then the score. The chart is decorative for
// assistive technology (`aria-hidden`); the contributions table next to it carries the same data.

export interface WaterfallStep {
  readonly label: string;
  /** Where the bar starts and its signed size (score points). */
  readonly base: number;
  readonly delta: number;
  readonly kind: 'positive' | 'negative' | 'adjustment' | 'total';
}

/**
 * Non-zero contributions, strongest first, as running steps; when they do not add up to the score, the adjustment
 * (`adjustLabel`: the 0–100 bounds or the gate); then the score. The steps always end on the score.
 */
export function waterfallSteps(
  contributions: readonly ScoreContribution[],
  score: number,
  labelOf: (feature: ScoreContribution['feature']) => string,
  labels: { readonly total: string; readonly adjustment: string },
): WaterfallStep[] {
  const steps: WaterfallStep[] = [];
  let running = 0;
  const ordered = contributions
    .filter((contribution) => contribution.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  for (const contribution of ordered) {
    const delta = Math.round(contribution.contribution * 10) / 10;
    steps.push({
      label: labelOf(contribution.feature),
      base: delta >= 0 ? running : running + delta,
      delta: Math.abs(delta),
      kind: delta >= 0 ? 'positive' : 'negative',
    });
    running = Math.round((running + delta) * 10) / 10;
  }
  // Decided like the engine (whole points of the unrounded sum): only the bounds or a gate change the score; a gap
  // left by the steps' rounding is not an adjustment.
  // In the engine's order (the API's): floating-point sums depend on it.
  const sum = contributions.reduce((total, contribution) => total + contribution.contribution, 0);
  if (Math.round(sum) !== score) {
    steps.push({
      label: labels.adjustment,
      base: Math.min(running, score),
      delta: Math.abs(running - score),
      kind: 'adjustment',
    });
  }
  steps.push({ label: labels.total, base: 0, delta: score, kind: 'total' });
  return steps;
}

/** The axis: 0–100, widened to every step (contributions may run below 0 or above 100 before the bounds). */
export function waterfallDomain(steps: readonly WaterfallStep[]): [number, number] {
  const low = Math.min(0, ...steps.map((step) => step.base));
  const high = Math.max(100, ...steps.map((step) => step.base + step.delta));
  return [Math.floor(low / 10) * 10, Math.ceil(high / 10) * 10];
}

const COLOR: Record<WaterfallStep['kind'], string> = {
  positive: 'var(--color-emerald-600, #059669)',
  negative: 'var(--color-red-600, #dc2626)',
  adjustment: 'var(--color-amber-500, #f59e0b)',
  total: 'var(--color-sky-600, #0284c7)',
};

export function Waterfall({ steps }: { readonly steps: readonly WaterfallStep[] }) {
  const t = useTranslations('scoring.tab');
  const format = useFormatter();
  return (
    <div aria-hidden className="h-[22rem] w-full" data-testid="score-waterfall">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={steps as WaterfallStep[]}
          accessibilityLayer={false}
          layout="vertical"
          margin={{ left: 8, right: 16 }}
        >
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" domain={waterfallDomain(steps)} tickCount={6} />
          <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 12 }} />
          <Tooltip
            formatter={(value) => [format.number(Number(value), { maximumFractionDigits: 1 }), t('points')]}
            cursor={{ fillOpacity: 0.1 }}
          />
          <Bar dataKey="base" stackId="w" fill="transparent" tooltipType="none" isAnimationActive={false} />
          <Bar dataKey="delta" stackId="w" isAnimationActive={false}>
            {steps.map((step, i) => (
              <Cell key={`${step.kind}-${i}`} fill={COLOR[step.kind]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
