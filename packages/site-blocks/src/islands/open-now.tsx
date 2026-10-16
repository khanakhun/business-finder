'use client';

import type { SiteLocale } from '@bf/site-schema';
import { useEffect, useState } from 'react';
import { formatTime, type OpenStatus, openStatus, type Weekly, weekdayName } from '../format/hours.ts';
import { uiStrings } from '../i18n/strings.ts';

/**
 * "Open now" (an island): computed in the browser with the visitor's clock, in the business's time zone, and
 * refreshed every minute. The server renders an invisible placeholder of the same size, so the page is identical
 * everywhere (deterministic) and nothing shifts when the status appears.
 */
export function OpenNow({
  weekly,
  timeZone,
  locale,
}: {
  weekly: Weekly;
  timeZone: string;
  locale: SiteLocale;
}) {
  const [status, setStatus] = useState<OpenStatus | null>(null);
  useEffect(() => {
    const update = () => setStatus(openStatus(weekly, new Date(), timeZone));
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [weekly, timeZone]);
  return (
    <p className="min-h-8" aria-live="polite">
      {status ? <StatusBadge status={status} locale={locale} /> : null}
    </p>
  );
}

export function StatusBadge({ status, locale }: { status: OpenStatus; locale: SiteLocale }) {
  const strings = uiStrings(locale);
  const detail = status.open
    ? strings.closesAt(formatTime(status.closesAt, locale))
    : status.opensAt
      ? strings.opensAt(
          status.opensAt.today ? strings.today.toLowerCase() : weekdayName(status.opensAt.day, locale),
          formatTime(status.opensAt.time, locale),
        )
      : '';
  return (
    <span className="bf-badge">
      <span
        className="bf-dot"
        style={{ color: status.open ? '#2f7d4f' : 'var(--bf-muted)' }}
        aria-hidden="true"
      />
      <span className="font-semibold">{status.open ? strings.openNow : strings.closedNow}</span>
      {detail ? <span className="bf-muted">· {detail}</span> : null}
    </span>
  );
}
