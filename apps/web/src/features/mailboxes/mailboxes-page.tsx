'use client';

import type { Mailbox } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Progress } from '@bf/ui/components/progress';
import { Skeleton } from '@bf/ui/components/skeleton';
import { MailIcon, PlusIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useMailboxActions, useMailboxes, useOAuthProviders } from './api.ts';
import { ConnectSmtpDialog } from './connect-smtp-dialog.tsx';
import { MailboxSheet } from './mailbox-sheet.tsx';
import { MailboxStatusBadge } from './mailbox-status.tsx';

// Settings → Mailboxes (BF-050): connect Google, Microsoft or SMTP/IMAP mailboxes; each one's status, today's cap
// and usage, next window and last error; a mailbox opens its detail. The OAuth redirect lands here with its outcome.

export function MailboxesPage() {
  const t = useTranslations('mailboxes');
  const errorLabels = useErrorLabels();
  const mailboxes = useMailboxes();
  const providers = useOAuthProviders();
  const { startOAuth } = useMailboxActions();
  const canManage = usePermission('settings:manage');
  const [smtpOpen, setSmtpOpen] = React.useState(false);
  const [shared, setShared] = React.useState(false);
  const [selected, setSelected] = useQueryState('mailbox', parseAsString);
  const [oauth, setOauth] = useQueryState('oauth', parseAsString);
  const [reason, setReason] = useQueryState('reason', parseAsString);

  React.useEffect(() => {
    if (!oauth) return;
    void (async () => {
      const toast = await getToast();
      if (oauth === 'connected') toast.success(t('oauth.connected'));
      else toast.error(t(`oauth.reasons.${reason ?? 'exchange_failed'}` as never));
      void setOauth(null);
      void setReason(null);
    })();
  }, [oauth, reason, setOauth, setReason, t]);

  const connect = async (provider: 'google' | 'microsoft', shared = false) => {
    try {
      const { url } = await startOAuth.mutateAsync({ provider, shared });
      globalThis.location.assign(url);
    } catch (error) {
      (await getToast()).error(toProblemLike(error, t('oauth.startFailed')).title);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!providers.data?.google || startOAuth.isPending}
          onClick={() => void connect('google', shared)}
        >
          <PlusIcon aria-hidden />
          {t('connect.google')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!providers.data?.microsoft || startOAuth.isPending}
          onClick={() => void connect('microsoft', shared)}
        >
          <PlusIcon aria-hidden />
          {t('connect.microsoft')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setSmtpOpen(true)}>
          <PlusIcon aria-hidden />
          {t('connect.smtp')}
        </Button>
        {canManage && (providers.data?.google || providers.data?.microsoft) ? (
          <Label className="flex items-center gap-1.5 text-xs font-normal">
            <Checkbox checked={shared} onCheckedChange={(on) => setShared(on === true)} />
            {t('connect.shared')}
          </Label>
        ) : null}
      </div>
      {providers.data && !providers.data.google && !providers.data.microsoft ? (
        <p className="text-xs text-muted-foreground">{t('connect.notConfigured')}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('noWarmupNetworks')}</p>
      {mailboxes.isError ? (
        <ErrorState
          problem={toProblemLike(mailboxes.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void mailboxes.refetch()}
        />
      ) : !mailboxes.data ? (
        <Skeleton className="h-40 w-full" />
      ) : mailboxes.data.length === 0 ? (
        <EmptyState icon={<MailIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {mailboxes.data.map((mailbox) => (
            <li key={mailbox.id}>
              <MailboxCard mailbox={mailbox} onOpen={() => void setSelected(mailbox.id)} />
            </li>
          ))}
        </ul>
      )}
      <ConnectSmtpDialog open={smtpOpen} onOpenChange={setSmtpOpen} />
      <MailboxSheet mailboxId={selected} onClose={() => void setSelected(null)} />
    </div>
  );
}

function MailboxCard({ mailbox, onOpen }: { readonly mailbox: Mailbox; readonly onOpen: () => void }) {
  const t = useTranslations('mailboxes');
  const errors = useTranslations('mailboxes.errors');
  const format = useFormatter();
  const cap = mailbox.today.effectiveCap;
  const used = mailbox.today.sent + mailbox.today.reserved;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full space-y-2 rounded-lg border p-3 text-left text-sm hover:bg-muted/50"
      aria-label={t('open', { email: mailbox.email })}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{mailbox.displayName}</span>
        <MailboxStatusBadge status={mailbox.status} />
      </span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {mailbox.email}
        <Badge variant="outline">{t(`detail.provider.${mailbox.provider}`)}</Badge>
        {mailbox.ownerUserId === null ? <Badge variant="secondary">{t('detail.shared')}</Badge> : null}
      </span>
      <span className="block space-y-1">
        <span className="flex justify-between text-xs">
          <span>{t('detail.today')}</span>
          <span>{t('detail.usage', { sent: mailbox.today.sent, cap })}</span>
        </span>
        <Progress value={cap > 0 ? Math.min(100, (used / cap) * 100) : 0} aria-label={t('detail.today')} />
      </span>
      <span className="block text-xs text-muted-foreground">
        {mailbox.nextWindowAt
          ? t('nextWindow', {
              when: format.dateTime(new Date(mailbox.nextWindowAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })
          : t('notSending')}
      </span>
      {mailbox.lastError && (mailbox.status === 'error' || mailbox.status === 'paused') ? (
        <span className="block text-xs text-destructive">{errors(mailbox.lastError.code)}</span>
      ) : null}
    </button>
  );
}
