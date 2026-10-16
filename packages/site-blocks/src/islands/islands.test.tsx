import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiStrings } from '../i18n/strings.ts';
import { BookingEmbed } from './booking-embed.tsx';
import { ContactForm } from './contact-form.tsx';
import { OpenNow } from './open-now.tsx';

const weekly = {
  mon: [{ open: '09:00', close: '18:00' }],
  tue: [{ open: '09:00', close: '18:00' }],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OpenNow', () => {
  it('renders an empty placeholder on the server (deterministic HTML)', () => {
    const html = renderToStaticMarkup(<OpenNow weekly={weekly} timeZone="Europe/Paris" locale="fr" />);
    expect(html).toBe('<p class="min-h-8" aria-live="polite"></p>');
  });

  it('shows the status in the browser and refreshes it every minute', () => {
    vi.useFakeTimers();
    // Monday 17:59 in Paris (UTC+2): open, closes at 18:00.
    vi.setSystemTime(new Date('2026-10-12T15:59:00Z'));
    render(<OpenNow weekly={weekly} timeZone="Europe/Paris" locale="en" />);
    expect(screen.getByText('Open now')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Closed now')).toBeInTheDocument();
    expect(screen.getByText(/Opens Tuesday at 9:00/)).toBeInTheDocument();
  });
});

describe('ContactForm', () => {
  const strings = uiStrings('en').form;

  it('is disabled with a note when no form backend is configured', () => {
    render(<ContactForm formId="c1" strings={strings} />);
    expect(screen.getByRole('group')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(strings.unavailable);
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Name')).toBeRequired();
  });

  it('posts JSON to its action and says it was sent', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    render(<ContactForm formId="c2" action="/api/forms/site-1" strings={strings} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@example.com' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(strings.sent));
    expect(fetch).toHaveBeenCalledWith('/api/forms/site-1', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ name: 'Ana', email: 'ana@example.com', message: 'Hello' });
  });

  it('says when sending failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    render(<ContactForm formId="c3" action="/api/forms/site-1" strings={strings} />);
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(strings.failed));
  });
});

describe('BookingEmbed', () => {
  it('loads nothing from the provider until asked, then shows a sandboxed frame', () => {
    const strings = uiStrings('en').booking;
    const { container } = render(
      <BookingEmbed
        src="https://calendly.com/salon/cut"
        host="calendly.com"
        label="Book"
        strings={strings}
      />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/provided by calendly\.com/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book' })).toHaveAttribute(
      'href',
      'https://calendly.com/salon/cut',
    );
    fireEvent.click(screen.getByRole('button', { name: strings.show }));
    const frame = container.querySelector('iframe');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups');
    expect(frame).toHaveAttribute('title', strings.frameTitle);
  });
});
