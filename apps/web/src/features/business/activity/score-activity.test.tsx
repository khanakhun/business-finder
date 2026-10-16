import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../../i18n/messages/en.json';
import fr from '../../../i18n/messages/fr.json';
import { registerDefaultActivityRenderers } from './defaults.tsx';
import { activityRenderers } from './registry.ts';

// The score timeline entry (BF-031): the primary profile's tier moved.
describe('score.updated activity', () => {
  registerDefaultActivityRenderers();
  const renderer = activityRenderers.get('score.updated');
  const activity = {
    type: 'score.updated',
    data: { from: 'B', to: 'X', score: 0, offer: 'new_website' },
  } as never;

  it.each([
    ['en', en, 'Tier moved from B to X'],
    ['fr', fr, 'Niveau passé de B à X'],
  ] as const)('reads in %s', (locale, messages, text) => {
    const Component = renderer?.component;
    if (!Component) throw new Error('no score.updated renderer');
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <Component activity={activity} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(text)).toBeTruthy();
  });
});
