'use client';

import type { ScoreContribution } from '@bf/contracts';
import { useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// How a score is built (BF-032): each contribution as a step from the previous total, then the score. The chart is
// decorative for assistive technology (`aria-hidden`); the contributions table next to it carries the same data.

export interface WaterfallStep {
  readonly label: string;
  /** Where the bar starts and its signed size (score points). */
  readonly base: number;
  readonly delta: number;
  readonly kind: 'positive' | 'negative' | 'total';
}

/** Non-zero contributions, strongest first, as running steps; then the (clamped, gated) score. */
export function waterfallSteps(
  contributions: readonly ScoreContribution[],
  score: number,
  labelOf: (feature: ScoreContribution['feature']) => string,
  totalLabel: string,
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
    running += delta;
  }
  steps.push({ label: totalLabel, base: 0, delta: score, kind: 'total' });
  return steps;
}

const COLOR: Record<WaterfallStep['kind'], string> = {
  positive: 'var(--color-emerald-600, #059669)',
  negative: 'var(--color-red-600, #dc2626)',
  total: 'var(--color-sky-600, #0284c7)',
};

export function Waterfall({ steps }: { readonly steps: readonly WaterfallStep[] }) {
  const t = useTranslations('scoring.tab');
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
          <XAxis type="number" domain={[0, 100]} tickCount={6} />
          <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 12 }} />
          <Tooltip
            formatter={(value, name) => (name === 'delta' ? [value, t('points')] : [])}
            cursor={{ fillOpacity: 0.1 }}
          />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="delta" stackId="w" isAnimationActive={false}>
            {steps.map((step) => (
              <Cell key={step.label} fill={COLOR[step.kind]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
