'use client';

import type { MailboxStatus } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { cn } from '@bf/ui/lib/utils';
import { useTranslations } from 'next-intl';

const STYLE: Record<MailboxStatus, string> = {
  connected: 'border-sky-600/40 bg-sky-600/15 text-sky-900 dark:text-sky-100',
  warming: 'border-amber-600/40 bg-amber-500/15 text-amber-900 dark:text-amber-100',
  active: 'border-emerald-600/40 bg-emerald-600/15 text-emerald-900 dark:text-emerald-100',
  paused: 'border-muted-foreground/40 bg-muted text-muted-foreground',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
};

export function MailboxStatusBadge({ status }: { readonly status: MailboxStatus }) {
  const t = useTranslations('mailboxes.status');
  return (
    <Badge variant="outline" className={cn(STYLE[status])}>
      {t(status)}
    </Badge>
  );
}
