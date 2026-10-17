'use client';

import type { MailboxUsageDay } from '@bf/contracts';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// Planned (the ramp) vs actual sends (BF-050): the last 30 days, then the next 14 as planned.

export function RampChart({ usage }: { readonly usage: readonly MailboxUsageDay[] }) {
  const t = useTranslations('mailboxes.chart');
  const format = useFormatter();
  const data = usage.map((day) => ({
    ...day,
    label: format.dateTime(new Date(`${day.day}T12:00:00Z`), { day: 'numeric', month: 'short' }),
  }));
  return (
    <figure className="space-y-1">
      <figcaption className="text-sm font-medium">{t('title')}</figcaption>
      <div className="h-48 w-full" role="img" aria-label={t('summary')}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={6} />
            <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="sent" name={t('sent')} fill="var(--color-lagoon, #0e7490)" />
            <Bar dataKey="bounced" name={t('bounced')} fill="var(--color-destructive, #dc2626)" />
            <Line dataKey="planned" name={t('planned')} stroke="currentColor" dot={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
