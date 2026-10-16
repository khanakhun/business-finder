import type { ScoreContribution } from '@bf/contracts';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../i18n/messages/en.json';
import fr from '../../i18n/messages/fr.json';
import { ScoreBadge } from './score-badge.tsx';
import { type WaterfallStep, waterfallDomain, waterfallSteps } from './waterfall.tsx';

const contribution = (feature: ScoreContribution['feature'], points: number): ScoreContribution => ({
  feature,
  rawValue: 1,
  weight: points,
  transformed: 1,
  contribution: points,
  imputed: null,
});

const labels = { total: 'Score', adjustment: 'Adjusted' };

/** Where the last step before the total ends: the steps must end on the score. */
const reached = (steps: readonly WaterfallStep[]) =>
  steps.slice(0, -1).reduce((running, step) => {
    if (step.kind === 'positive') return running + step.delta;
    if (step.kind === 'negative') return running - step.delta;
    // An adjustment spans from the running total (one end) to the score (the other).
    if (running === step.base) return step.base + step.delta;
    expect(running).toBe(step.base + step.delta);
    return step.base;
  }, 0);

describe('waterfallSteps', () => {
  it('runs the non-zero contributions strongest first, then the score they add up to', () => {
    const steps = waterfallSteps(
      [contribution('has_phone', 52), contribution('has_website', -30), contribution('rating_avg', 0)],
      22,
      (feature) => feature,
      labels,
    );
    expect(steps).toEqual([
      { label: 'has_phone', base: 0, delta: 52, kind: 'positive' },
      { label: 'has_website', base: 22, delta: 30, kind: 'negative' },
      { label: 'Score', base: 0, delta: 22, kind: 'total' },
    ]);
    expect(reached(steps)).toBe(22);
  });

  it.each([
    ['clamped at 0', [contribution('has_website', -30)], 0, { base: -30, delta: 30 }],
    [
      'clamped at 100',
      [contribution('has_phone', 80), contribution('rating_avg', 40)],
      100,
      { base: 100, delta: 20 },
    ],
    ['capped by a gate', [contribution('has_phone', 70)], 40, { base: 40, delta: 30 }],
    ['excluded by a gate', [contribution('has_phone', 70)], 0, { base: 0, delta: 70 }],
  ] as const)('adds the adjustment when the score is %s', (_case, contributions, score, adjustment) => {
    const steps = waterfallSteps(contributions, score, String, labels);
    expect(steps.at(-2)).toEqual({ label: 'Adjusted', kind: 'adjustment', ...adjustment });
    expect(steps.at(-1)).toEqual({ label: 'Score', base: 0, delta: score, kind: 'total' });
    expect(reached(steps)).toBe(score);
  });

  it('adds no adjustment for rounding, however many contributions round the same way', () => {
    const features = [
      'has_phone',
      'rating_avg',
      'has_https',
      'has_website',
      'has_booking_tool',
      'has_online_menu',
      'has_contact_form',
      'site_freshness_years',
      'vision_overall',
      'website_quality_score',
      'lcp_mobile_seconds',
      'psi_mobile_performance',
    ] as const;
    // Each 3.05 is shown to a tenth, so the steps drift from the sum (36.6), whose round is the score.
    const steps = waterfallSteps(
      features.map((feature) => contribution(feature, 3.05)),
      37,
      String,
      labels,
    );
    expect(steps.filter((step) => step.kind === 'adjustment')).toEqual([]);
    expect(steps.at(-1)).toEqual({ label: 'Score', base: 0, delta: 37, kind: 'total' });
  });

  it('rounds to a tenth of a point, and keeps only the total when nothing contributes', () => {
    const rounded = waterfallSteps([contribution('has_phone', 2.345)], 2, String, labels);
    expect(rounded).toHaveLength(2);
    expect(rounded[0]).toMatchObject({ delta: 2.3 });
    expect(waterfallSteps([], 0, String, labels)).toEqual([
      { label: 'Score', base: 0, delta: 0, kind: 'total' },
    ]);
  });

  it('widens the axis to every step', () => {
    expect(waterfallDomain(waterfallSteps([contribution('has_phone', 40)], 40, String, labels))).toEqual([
      0, 100,
    ]);
    expect(waterfallDomain(waterfallSteps([contribution('has_website', -35)], 0, String, labels))).toEqual([
      -40, 100,
    ]);
  });
});

describe('ScoreBadge', () => {
  it.each([
    ['en', en, 'Tier A, score 82 for Local SEO'],
    ['fr', fr, 'Niveau A, score 82 pour Référencement local'],
  ] as const)('names tier, score and offer in %s', (locale, messages, label) => {
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ScoreBadge score={82} tier="A" offer="local_seo" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('A 82')).toBeTruthy();
  });

  it('shows the tier alone for an excluded business', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ScoreBadge score={0} tier="X" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Tier X, score 0')).toBeTruthy();
    expect(screen.getByText('X')).toBeTruthy();
  });

  it('renders nothing for an unscored business', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ScoreBadge score={null} tier={null} />
      </NextIntlClientProvider>,
    );
    expect(container.textContent).toBe('');
  });
});
