'use client';

import { useTranslations } from 'next-intl';
import { useUnreadCount } from './use-notifications.ts';

/** Count on the bell; also the trigger's accessible name, so screen readers hear it. */
export function UnreadBadge() {
  const count = useUnreadCount();
  if (count === 0) return null;
  return (
    <span
      data-testid="unread-count"
      className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function useBellLabel(): string {
  const t = useTranslations();
  const count = useUnreadCount();
  return count > 0 ? t('notifications.unreadLabel', { count }) : t('topbar.notifications');
}
