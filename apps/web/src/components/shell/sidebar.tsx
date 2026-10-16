'use client';

import { cn } from '@bf/ui/lib/utils';
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { activeNavItem, NAVIGATION } from '@/lib/navigation.ts';
import { BrandMark } from './brand-mark.tsx';

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle?: () => void;
  /** Called after following a link (closes the mobile sheet). */
  readonly onNavigate?: () => void;
}

/** Primary navigation. The active item carries the lagoon waterline — the app's "you are here". */
export function Sidebar({ collapsed, onToggle, onNavigate }: SidebarProps) {
  const t = useTranslations();
  const active = activeNavItem(usePathname());

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn('flex h-14 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
        <BrandMark className="size-6 shrink-0" />
        {collapsed ? null : (
          <span className="truncate text-lg font-semibold tracking-tight">{t('app.name')}</span>
        )}
      </div>
      <nav aria-label={t('nav.label')} className="flex-1 overflow-y-auto px-2 pb-4">
        {NAVIGATION.map((group) => (
          <div key={group.key ?? 'top'} className="mt-4 first:mt-1">
            {group.key && !collapsed ? (
              <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
                {t(`nav.groups.${group.key}`)}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = active?.key === item.key;
                const label = t(`nav.${item.key}`);
                const link = (
                  <Link
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    {...(onNavigate ? { onClick: onNavigate } : {})}
                    // Collapsed: icon only. The visually hidden label serves screen readers; title shows on hover.
                    {...(collapsed ? { title: label } : {})}
                    className={cn(
                      'relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-base text-muted-foreground transition-colors hover:bg-surface-sunken hover:text-foreground',
                      isActive &&
                        'bg-lagoon-wash font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-lagoon',
                      collapsed && 'justify-center px-0',
                    )}
                  >
                    <item.icon aria-hidden className={cn('size-4 shrink-0', isActive && 'text-lagoon')} />
                    {collapsed ? (
                      <span className="sr-only">{label}</span>
                    ) : (
                      <span className="truncate">{label}</span>
                    )}
                  </Link>
                );
                return <li key={item.key}>{link}</li>;
              })}
            </ul>
          </div>
        ))}
      </nav>
      {onToggle ? (
        <div className={cn('border-t px-2 py-2', collapsed && 'flex justify-center')}>
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!collapsed}
            className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-surface-sunken hover:text-foreground"
          >
            {collapsed ? (
              <PanelLeftOpenIcon aria-hidden className="size-4" />
            ) : (
              <PanelLeftCloseIcon aria-hidden className="size-4" />
            )}
            {collapsed ? null : <span>{t('nav.collapse')}</span>}
          </button>
        </div>
      ) : null}
    </div>
  );
}
