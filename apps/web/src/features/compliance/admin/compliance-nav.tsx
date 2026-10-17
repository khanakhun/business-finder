'use client';

import { cn } from '@bf/ui/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { usePermission } from '@/lib/session.tsx';

/** Tabs of /compliance (BF-055): suppressions for everyone who sends; requests and retention for admins. */
export function ComplianceNav() {
  const t = useTranslations('complianceAdmin.nav');
  const pathname = usePathname();
  const admin = usePermission('settings:manage');
  const items = [
    { href: '/compliance/suppressions', label: t('suppressions'), show: true },
    { href: '/compliance/requests', label: t('requests'), show: admin },
    { href: '/compliance/retention', label: t('retention'), show: admin },
    { href: '/settings/compliance', label: t('policies'), show: true },
  ].filter((item) => item.show);
  return (
    <nav aria-label={t('label')} className="mb-6 flex gap-1 overflow-x-auto border-b">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
