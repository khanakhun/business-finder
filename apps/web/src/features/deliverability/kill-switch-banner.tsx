'use client';

import { OctagonXIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDeliverabilityOverview } from './api.ts';

/** Shown on the outreach pages while the workspace's kill switch is on (BF-056). */
export function KillSwitchBanner() {
  const t = useTranslations('deliverability.banner');
  const overview = useDeliverabilityOverview();
  const kill = overview.data?.killSwitch;
  if (!kill?.active) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex items-center gap-2 rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm"
    >
      <OctagonXIcon aria-hidden className="size-4 text-destructive" />
      <span>{t('active', { reason: kill.reason ?? '' })}</span>
      <Link
        className="ml-auto text-primary underline-offset-2 hover:underline"
        href="/outreach/deliverability"
      >
        {t('open')}
      </Link>
    </div>
  );
}
