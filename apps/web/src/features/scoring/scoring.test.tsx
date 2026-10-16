import type { ScoreContribution } from '@bf/contracts';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../i18n/messages/en.json';
import fr from '../../i18n/messages/fr.json';
import { ScoreBadge } from './score-badge.tsx';
import { waterfallSteps } from './waterfall.tsx';

const contribution = (feature: string, points: number): ScoreContribution =>
  ({ feature, value: 1, weight: points, transformed: 1, contribution: points }) as never;

describe('waterfallSteps', () => {
  it('runs the non-zero contributions strongest first, then the score', () => {
    const steps = waterfallSteps(
      [contribution('has_phone', 12), contribution('has_website', -30), contribution('rating_avg', 0)],
      40,
      (feature) => feature,
      'Score',
    );
    expect(steps).toEqual([
      { label: 'has_website', base: -30, delta: 30, kind: 'negative' },
      { label: 'has_phone', base: -30, delta: 12, kind: 'positive' },
      { label: 'Score', base: 0, delta: 40, kind: 'total' },
    ]);
  });

  it('rounds to a tenth of a point and keeps only the total when nothing contributes', () => {
    expect(waterfallSteps([contribution('has_phone', 2.345)], 2, String, 'T')[0]).toMatchObject({
      delta: 2.3,
    });
    expect(waterfallSteps([], 0, String, 'T')).toEqual([{ label: 'T', base: 0, delta: 0, kind: 'total' }]);
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
