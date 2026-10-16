'use client';

import { Badge } from '@bf/ui/components/badge';
import { cn } from '@bf/ui/lib/utils';
import {
  CalendarCheckIcon,
  GlobeIcon,
  type LucideIcon,
  MapPinIcon,
  PaintbrushIcon,
  PhoneCallIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

// Score badges (BF-032): tier colour, score, and the offer of the profile behind it. Shell-safe: no value import
// from the contracts barrel (BF-007 budget), so tiers and offers are mirrored here.

export type Tier = 'A' | 'B' | 'C' | 'X';
export type OfferId = 'new_website' | 'website_redesign' | 'ai_receptionist' | 'booking_system' | 'local_seo';

export const TIER_STYLE: Record<Tier, string> = {
  A: 'border-emerald-600/40 bg-emerald-600/15 text-emerald-900 dark:text-emerald-100',
  B: 'border-sky-600/40 bg-sky-600/15 text-sky-900 dark:text-sky-100',
  C: 'border-border bg-muted text-muted-foreground',
  X: 'border-destructive/40 bg-destructive/10 text-destructive',
};

export const OFFER_ICON: Record<OfferId, LucideIcon> = {
  new_website: GlobeIcon,
  website_redesign: PaintbrushIcon,
  ai_receptionist: PhoneCallIcon,
  booking_system: CalendarCheckIcon,
  local_seo: MapPinIcon,
};

export function ScoreBadge({
  score,
  tier,
  offer,
  className,
}: {
  readonly score: number | null;
  readonly tier: Tier | null;
  readonly offer?: OfferId | undefined;
  readonly className?: string;
}) {
  const t = useTranslations('scoring.badge');
  const offers = useTranslations('scoring.offers');
  if (!tier) return null;
  const Icon = offer ? OFFER_ICON[offer] : null;
  const label = offer
    ? t('labelOffer', { tier, score: score ?? 0, offer: offers(offer) })
    : t('label', { tier, score: score ?? 0 });
  return (
    <Badge variant="outline" className={cn('gap-1 tabular-nums', TIER_STYLE[tier], className)} title={label}>
      {Icon ? <Icon aria-hidden className="size-3" /> : null}
      <span className="sr-only">{label}</span>
      <span aria-hidden>
        {tier}
        {score !== null && tier !== 'X' ? ` ${score}` : ''}
      </span>
    </Badge>
  );
}
