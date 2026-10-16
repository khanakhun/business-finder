import { TooltipProvider } from '@bf/ui/components/tooltip';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/messages/en.json';
import fr from '../../../i18n/messages/fr.json';
import { FactField } from './fields.tsx';

// The fact picker before the fact registry (BF-040): the linked facts are shown, read-only, with the reason.
describe('FactField (degraded until BF-040)', () => {
  it.each([
    ['en', en, 'Fact management arrives with BF-040'],
    ['fr', fr, 'BF-040'],
  ] as const)('shows the linked facts read-only, and why (%s)', async (locale, messages, reason) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <TooltipProvider>
          <FactField label="Fact" id="fact" value={['fact_price_cut']} onChange={onChange} help={undefined} />
        </TooltipProvider>
      </NextIntlClientProvider>,
    );
    const shown = screen.getByRole('button', { name: /fact_price_cut/ });
    await user.hover(shown);
    expect((await screen.findAllByText(new RegExp(reason))).length).toBeGreaterThan(0);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
