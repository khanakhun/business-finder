'use client';

import type { SiteLocale } from '@bf/site-schema';
import { useEffect, useState } from 'react';
import { formatTime, type OpenStatus, openStatus, type Weekly, weekdayName } from '../format/hours.ts';
import type { OpenNowLabels } from '../i18n/strings.ts';

/**
 * "Open now" (an island): computed in the browser with the visitor's clock, in the business's time zone, and
 * refreshed every minute. The server renders an invisible placeholder of the same size, so the page is identical
 * everywhere (deterministic) and nothing shifts when the status appears.
 */
export function OpenNow({
  weekly,
  timeZone,
  locale,
  labels,
}: {
  weekly: Weekly;
  timeZone: string;
  locale: SiteLocale;
  labels: OpenNowLabels;
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
      {status ? <StatusBadge status={status} locale={locale} labels={labels} /> : null}
    </p>
  );
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (slot, name: string) => values[name] ?? slot);

export function StatusBadge({
  status,
  locale,
  labels,
}: {
  status: OpenStatus;
  locale: SiteLocale;
  labels: OpenNowLabels;
}) {
  const detail = status.open
    ? fill(labels.closesAt, { time: formatTime(status.closesAt, locale) })
    : status.opensAt
      ? fill(labels.opensAt, {
          day: status.opensAt.today ? labels.today.toLowerCase() : weekdayName(status.opensAt.day, locale),
          time: formatTime(status.opensAt.time, locale),
        })
      : '';
  return (
    <span className="bf-badge">
      <span
        className="bf-dot"
        style={{ color: status.open ? '#2f7d4f' : 'var(--bf-muted)' }}
        aria-hidden="true"
      />
      <span className="font-semibold">{status.open ? labels.openNow : labels.closedNow}</span>
      {detail ? <span className="bf-muted">· {detail}</span> : null}
    </span>
  );
}
