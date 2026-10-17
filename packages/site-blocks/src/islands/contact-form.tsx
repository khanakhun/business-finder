'use client';

import { type FormEvent, useState } from 'react';
import type { UiStrings } from '../i18n/strings.ts';

type State = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * The contact form (an island). Without script it is a plain form posting to `action`; with script it posts JSON
 * and says how it went in place. Without an `action` (a static render or a preview without the forms backend,
 * BF-048) it is shown disabled. Labels, native validation and an announced status keep it accessible.
 */
export function ContactForm({
  formId,
  action,
  strings,
  className,
  hidden,
  notice,
}: {
  formId: string;
  action?: string | undefined;
  strings: UiStrings['form'];
  className?: string | undefined;
  /** Fields the server needs and people do not see (a preview's lead form, BF-048). */
  hidden?: Readonly<Record<string, string>> | undefined;
  /** Shown above the fields (a preview: "messages go to the agency, not to the business"). */
  notice?: string | undefined;
}) {
  const [state, setState] = useState<State>('idle');
  const field = (name: string) => `${formId}-${name}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    if (!action) return;
    event.preventDefault();
    setState('sending');
    try {
      const response = await fetch(action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
      });
      setState(response.ok ? 'sent' : 'failed');
    } catch {
      setState('failed');
    }
  }
  const message =
    state === 'sent'
      ? strings.sent
      : state === 'failed'
        ? strings.failed
        : !action
          ? strings.unavailable
          : '';
  return (
    <form
      id={formId}
      method="post"
      action={action}
      onSubmit={submit}
      className={className}
      aria-describedby={message ? field('status') : undefined}
    >
      {notice ? (
        <p id={field('notice')} className="bf-muted mb-4 text-sm">
          {notice}
        </p>
      ) : null}
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {hidden ? (
        // A honeypot: hidden from people (and from assistive technology), filled by naive bots.
        <div
          aria-hidden="true"
          style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}
        >
          <label htmlFor={field('hp')}>Leave empty</label>
          <input id={field('hp')} name="hp" tabIndex={-1} autoComplete="off" />
        </div>
      ) : null}
      <fieldset
        disabled={!action || state === 'sending' || state === 'sent'}
        className="grid gap-5 sm:grid-cols-2"
      >
        <div className="bf-field">
          <label className="bf-label" htmlFor={field('name')}>
            {strings.name}
          </label>
          <input
            id={field('name')}
            name="name"
            className="bf-input"
            autoComplete="name"
            required
            maxLength={120}
          />
        </div>
        <div className="bf-field">
          <label className="bf-label" htmlFor={field('email')}>
            {strings.email}
          </label>
          <input
            id={field('email')}
            name="email"
            type="email"
            className="bf-input"
            autoComplete="email"
            required
            maxLength={254}
          />
        </div>
        <div className="bf-field sm:col-span-2">
          <label className="bf-label" htmlFor={field('phone')}>
            {strings.phone} <span className="bf-muted font-normal">({strings.optional})</span>
          </label>
          <input
            id={field('phone')}
            name="phone"
            type="tel"
            className="bf-input"
            autoComplete="tel"
            maxLength={40}
          />
        </div>
        <div className="bf-field sm:col-span-2">
          <label className="bf-label" htmlFor={field('message')}>
            {strings.message}
          </label>
          <textarea
            id={field('message')}
            name="message"
            rows={5}
            className="bf-input"
            required
            maxLength={2000}
          />
        </div>
        <div className="sm:col-span-2">
          <button type="submit" className="bf-btn bf-btn-primary w-full sm:w-auto">
            {state === 'sending' ? strings.sending : strings.send}
          </button>
        </div>
      </fieldset>
      <p id={field('status')} role="status" className="bf-muted mt-4 min-h-6 text-sm">
        {message}
      </p>
    </form>
  );
}
