'use client';

import type { Notification } from '@bf/contracts';
import { cn } from '@bf/ui/lib/utils';
import Link from 'next/link';
import { useFormatter } from 'next-intl';
import { useMarkRead, useNotificationText } from './use-notifications.ts';

/** One notification; opening it marks it read. */
export function NotificationItem({
  notification,
  compact = false,
}: {
  readonly notification: Notification;
  readonly compact?: boolean;
}) {
  const format = useFormatter();
  const text = useNotificationText()(notification);
  const { one } = useMarkRead();
  const unread = notification.readAt === null;
  const content = (
    <>
      <span className="flex items-start gap-2">
        {unread ? <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" /> : null}
        <span className={cn('grid gap-0.5', !unread && 'pl-4')}>
          <span className={cn(unread && 'font-medium')}>{text.title}</span>
          {compact ? null : <span className="text-sm text-muted-foreground">{text.body}</span>}
          <time dateTime={notification.createdAt} className="text-xs text-muted-foreground">
            {format.relativeTime(new Date(notification.createdAt))}
          </time>
        </span>
      </span>
    </>
  );
  const className = 'block rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent';
  const markRead = () => {
    if (unread) one.mutate(notification.id);
  };
  // Dashboard paths only (the API guarantees it; never trust it blindly in an href).
  const link = notification.link && /^\/(?!\/)[^\s\\]*$/.test(notification.link) ? notification.link : null;
  return link ? (
    <Link href={link} className={className} onClick={markRead}>
      {content}
    </Link>
  ) : (
    <button type="button" className={cn(className, 'w-full')} onClick={markRead}>
      {content}
    </button>
  );
}
