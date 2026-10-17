'use client';

import { cn } from '@bf/ui/lib/utils';
import { useTranslations } from 'next-intl';
import { usePermission } from '@/lib/session.tsx';
import { useLeadCounts } from './api.ts';

/** The leads waiting, next to "Leads" in the navigation (BF-048); nothing when there are none. */
export function LeadsBadge({ collapsed }: { readonly collapsed: boolean }) {
  const t = useTranslations('leads');
  const allowed = usePermission('leads:read');
  const counts = useLeadCounts(allowed);
  const count = counts.data?.new ?? 0;
  if (!allowed || count === 0) return null;
  return (
    <span
      className={cn(
        'ml-auto rounded-full bg-lagoon px-1.5 text-xs font-medium text-white tabular-nums',
        collapsed && 'absolute top-0.5 right-0.5 ml-0 px-1 text-[10px]',
      )}
    >
      <span aria-hidden>{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{t('waiting', { count })}</span>
    </span>
  );
}
