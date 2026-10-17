'use client';

import { cn } from '@bf/ui/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { usePermission } from '@/lib/session.tsx';

/** Section tabs of /settings; sections the role cannot use are not offered (the API refuses them anyway). */
export function SettingsNav() {
  const t = useTranslations('settingsNav');
  const pathname = usePathname();
  const canManageMembers = usePermission('members:manage');
  const canManageSettings = usePermission('settings:manage');
  const items = [
    { href: '/settings', label: t('general'), show: true },
    { href: '/settings/account', label: t('account'), show: true },
    { href: '/settings/notifications', label: t('notifications'), show: true },
    { href: '/settings/workspace', label: t('workspace'), show: canManageSettings },
    { href: '/settings/members', label: t('members'), show: canManageMembers },
    { href: '/settings/integrations', label: t('integrations'), show: canManageSettings },
    { href: '/settings/features', label: t('features'), show: canManageSettings },
    { href: '/settings/api-keys', label: t('apiKeys'), show: canManageSettings },
    { href: '/settings/audit', label: t('audit'), show: canManageSettings },
    { href: '/settings/taxonomy', label: t('taxonomy'), show: canManageSettings },
    // Everyone reads the scoring profiles; `scoring:manage` edits them.
    { href: '/settings/scoring', label: t('scoring'), show: true },
    // Everyone sees the generation settings; `settings:manage` changes them (BF-046).
    { href: '/settings/generation', label: t('generation'), show: true },
    // Everyone reads the compliance policies; `compliance:manage` reviews and overrides them (BF-049).
    { href: '/settings/compliance', label: t('compliance'), show: true },
  ].filter((item) => item.show);
  return (
    <nav aria-label={t('label')} className="mb-6 flex gap-1 overflow-x-auto border-b">
      {items.map((item) => {
        const active =
          pathname === item.href || (item.href !== '/settings' && pathname.startsWith(`${item.href}/`));
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
