'use client';

import type { Locale, Mailbox, MailboxRamp, SendWindow } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@bf/ui/components/sheet';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { Textarea } from '@bf/ui/components/textarea';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { SafeMarkdown } from '@/features/business/markdown.tsx';
import { usePermission, useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useMailbox, useMailboxActions } from './api.ts';
import { MailboxStatusBadge } from './mailbox-status.tsx';
import { RampChart } from './ramp-chart.tsx';
import { WindowEditor } from './window-editor.tsx';

// One mailbox (BF-050): status and health with the fix for its last error, actions (pause/resume, test send,
// reconnect, disconnect), the ramp chart, settings (admins: cap, ramp, interval, window), signature and its trail.

const LOCALES: Locale[] = ['en', 'fr'];

export function MailboxSheet({
  mailboxId,
  onClose,
}: {
  readonly mailboxId: string | null;
  readonly onClose: () => void;
}) {
  const t = useTranslations('mailboxes.detail');
  const detail = useMailbox(mailboxId);
  return (
    <Sheet open={mailboxId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-2xl">
        <SheetTitle className="sr-only">{t('title')}</SheetTitle>
        <SheetDescription className="sr-only">{t('hint')}</SheetDescription>
        {detail.data ? (
          <Detail
            key={detail.data.mailbox.updatedAt}
            mailbox={detail.data.mailbox}
            detail={detail.data}
            onClose={onClose}
          />
        ) : (
          <Skeleton className="h-96 w-full" />
        )}
      </SheetContent>
    </Sheet>
  );
}

function Detail({
  mailbox,
  detail,
  onClose,
}: {
  readonly mailbox: Mailbox;
  readonly detail: NonNullable<ReturnType<typeof useMailbox>['data']>;
  readonly onClose: () => void;
}) {
  const t = useTranslations('mailboxes.detail');
  const errors = useTranslations('mailboxes.errors');
  const format = useFormatter();
  const session = useSession();
  const manage = usePermission('settings:manage');
  const own = mailbox.ownerUserId !== null && mailbox.ownerUserId === session.user.id;
  const canEdit = manage || own;
  const actions = useMailboxActions();
  const [displayName, setDisplayName] = React.useState(mailbox.displayName);
  const [dailyCap, setDailyCap] = React.useState(mailbox.dailyCap);
  const [ramp, setRamp] = React.useState<MailboxRamp>(mailbox.ramp);
  const [minIntervalSec, setMinIntervalSec] = React.useState(mailbox.minIntervalSec);
  const [window, setWindow] = React.useState<SendWindow>(mailbox.window);
  const [locales, setLocales] = React.useState<Locale[]>(mailbox.locales);
  const [replyTo, setReplyTo] = React.useState(mailbox.replyTo ?? '');
  const [signature, setSignature] = React.useState(mailbox.signatureMd);
  const run = async (action: () => Promise<unknown>, done: string) => {
    const toast = await getToast();
    try {
      await action();
      toast.success(done);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const save = () =>
    run(
      () =>
        actions.update.mutateAsync({
          id: mailbox.id,
          body: {
            displayName,
            locales,
            signatureMd: signature,
            replyTo: replyTo.trim() === '' ? null : replyTo.trim(),
            ...(manage ? { dailyCap, ramp, minIntervalSec, window } : {}),
          },
        }),
      t('saved'),
    );
  const test = async () => {
    const toast = await getToast();
    try {
      const result = await actions.test.mutateAsync(mailbox.id);
      if (result.ok) toast.success(t('testSent', { to: result.to }));
      else toast.error(t('testFailed', { error: result.error ?? '' }));
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  const reconnect = async () => {
    if (mailbox.provider === 'smtp_imap') return;
    try {
      const { url } = await actions.startOAuth.mutateAsync({
        provider: mailbox.provider === 'gmail' ? 'google' : 'microsoft',
        mailboxId: mailbox.id,
      });
      globalThis.location.assign(url);
    } catch (error) {
      (await getToast()).error(toProblemLike(error, t('failed')).title);
    }
  };
  return (
    <div className="space-y-6 text-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{mailbox.displayName}</h2>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          {mailbox.email}
          <MailboxStatusBadge status={mailbox.status} />
          <Badge variant="outline">{t(`provider.${mailbox.provider}`)}</Badge>
          {mailbox.ownerUserId === null ? <Badge variant="secondary">{t('shared')}</Badge> : null}
        </p>
        {mailbox.lastError && (mailbox.status === 'error' || mailbox.status === 'paused') ? (
          <p
            role="status"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive"
          >
            {errors(mailbox.lastError.code)}
          </p>
        ) : null}
      </header>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          {mailbox.status === 'paused' ? (
            <Button
              size="sm"
              onClick={() => void run(() => actions.resume.mutateAsync(mailbox.id), t('resumed'))}
            >
              {t('resume')}
            </Button>
          ) : mailbox.status === 'warming' || mailbox.status === 'active' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run(() => actions.pause.mutateAsync(mailbox.id), t('paused'))}
            >
              {t('pause')}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={actions.test.isPending} onClick={() => void test()}>
            {t('test')}
          </Button>
          {mailbox.provider !== 'smtp_imap' ? (
            <Button size="sm" variant="outline" onClick={() => void reconnect()}>
              {t('reconnect')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() =>
              void run(async () => {
                await actions.disconnect.mutateAsync(mailbox.id);
                onClose();
              }, t('disconnected'))
            }
          >
            {t('disconnect')}
          </Button>
        </div>
      ) : null}
      <section className="grid gap-2 sm:grid-cols-3">
        <Stat
          label={t('today')}
          value={t('usage', { sent: mailbox.today.sent, cap: mailbox.today.effectiveCap })}
        />
        <Stat
          label={t('nextWindow')}
          value={
            mailbox.nextWindowAt
              ? format.dateTime(new Date(mailbox.nextWindowAt), { dateStyle: 'medium', timeStyle: 'short' })
              : '—'
          }
        />
        <Stat
          label={t('health')}
          value={
            mailbox.health.checkedAt
              ? mailbox.health.tokenOk && mailbox.health.reachable
                ? t('healthy')
                : t('unhealthy')
              : t('notChecked')
          }
        />
      </section>
      <RampChart usage={detail.usage} />
      {canEdit ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="mbx-name" label={t('displayName')}>
              <Input
                id="mbx-name"
                value={displayName}
                maxLength={120}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
            <Field id="mbx-reply" label={t('replyTo')}>
              <Input
                id="mbx-reply"
                type="email"
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
              />
            </Field>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm">{t('languages')}</legend>
            <div className="flex gap-4">
              {LOCALES.map((locale) => (
                <Label key={locale} className="flex items-center gap-1.5 font-normal">
                  <Checkbox
                    checked={locales.includes(locale)}
                    onCheckedChange={(on) =>
                      setLocales((current) =>
                        on === true
                          ? [...new Set([...current, locale])]
                          : current.filter((l) => l !== locale),
                      )
                    }
                  />
                  {t(`locale.${locale}`)}
                </Label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-3 rounded-lg border p-3" disabled={!manage}>
            <legend className="px-1 text-sm font-medium">{t('capacity')}</legend>
            {!manage ? <p className="text-xs text-muted-foreground">{t('adminsOnly')}</p> : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id="mbx-cap" label={t('dailyCap')}>
                <Input
                  id="mbx-cap"
                  type="number"
                  min={1}
                  value={dailyCap}
                  onChange={(e) => setDailyCap(Number(e.target.value))}
                />
              </Field>
              <Field id="mbx-interval" label={t('minInterval')}>
                <Input
                  id="mbx-interval"
                  type="number"
                  min={30}
                  max={3600}
                  value={minIntervalSec}
                  onChange={(e) => setMinIntervalSec(Number(e.target.value))}
                />
              </Field>
              <Label className="flex items-center gap-2 self-end font-normal">
                <Switch checked={ramp.enabled} onCheckedChange={(enabled) => setRamp({ ...ramp, enabled })} />
                {t('rampEnabled')}
              </Label>
            </div>
            {ramp.enabled ? (
              <div className="grid gap-3 sm:grid-cols-4">
                {(['startCap', 'increment', 'everyDays', 'maxCap'] as const).map((key) => (
                  <Field key={key} id={`mbx-ramp-${key}`} label={t(`ramp.${key}`)}>
                    <Input
                      id={`mbx-ramp-${key}`}
                      type="number"
                      min={key === 'increment' ? 0 : 1}
                      value={ramp[key]}
                      onChange={(e) => setRamp({ ...ramp, [key]: Number(e.target.value) })}
                    />
                  </Field>
                ))}
              </div>
            ) : null}
            <WindowEditor value={window} onChange={setWindow} disabled={!manage} />
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="mbx-signature" label={t('signature')}>
              <Textarea
                id="mbx-signature"
                rows={6}
                maxLength={4000}
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
              />
            </Field>
            <div className="space-y-1">
              <p className="text-sm">{t('preview')}</p>
              <div className="min-h-24 rounded-md border p-2 text-sm">
                {signature.trim() ? (
                  <SafeMarkdown>{signature}</SafeMarkdown>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </div>
          </div>
          <Button type="submit" disabled={actions.update.isPending}>
            {t('save')}
          </Button>
        </form>
      ) : null}
      <section className="space-y-1">
        <h3 className="font-medium">{t('trail')}</h3>
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {detail.events.map((event) => (
            <li key={event.id}>
              {format.dateTime(new Date(event.createdAt), { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
              {t(`event.${event.kind}` as never)}
              {event.toStatus && event.fromStatus ? ` (${event.fromStatus} → ${event.toStatus})` : ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
