'use client';

import type { CheckOutcome, MailboxHealthStats, MailboxReadiness } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { cn } from '@bf/ui/lib/utils';
import { MailsIcon, RefreshCwIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import {
  useDeliverabilityActions,
  useDeliverabilityOverview,
  useMailboxHealth,
  useReadiness,
} from './api.ts';

// Deliverability (BF-056): the kill switch, the preview domain's blocklist status, and per mailbox its domain's
// authentication checklist (with the exact fix and a re-check), whether it may send (and an owner's override), its
// rolling health with the rules' warnings and a 30-day trend, plus the providers' own tools.

const OUTCOME_VARIANT: Record<CheckOutcome, 'secondary' | 'outline' | 'destructive'> = {
  pass: 'secondary',
  warn: 'outline',
  fail: 'destructive',
  unknown: 'outline',
};

export function DeliverabilityPage() {
  const t = useTranslations('deliverability');
  const errorLabels = useErrorLabels();
  const overview = useDeliverabilityOverview();
  const readiness = useReadiness();
  const health = useMailboxHealth();
  const canManage = usePermission('settings:manage');
  const byMailbox = new Map((health.data ?? []).map((row) => [row.mailboxId, row]));
  return (
    <div className="space-y-6">
      <section className="grid gap-3 md:grid-cols-2">
        <KillSwitchCard canManage={canManage} />
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <h2 className="font-medium">{t('blocklist.title')}</h2>
          {!overview.data ? (
            <Skeleton className="h-6 w-40" />
          ) : !overview.data.blocklist.enabled ? (
            <p className="text-muted-foreground">{t('blocklist.off')}</p>
          ) : (
            <p>
              {t('blocklist.sitesDomain', { domain: overview.data.blocklist.sitesDomain })}{' '}
              <Badge variant={overview.data.blocklist.listed ? 'destructive' : 'secondary'}>
                {overview.data.blocklist.listed === null
                  ? t('outcome.unknown')
                  : overview.data.blocklist.listed
                    ? t('blocklist.listed')
                    : t('blocklist.clean')}
              </Badge>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t('tools')}{' '}
            <a
              className="text-primary underline-offset-2 hover:underline"
              href="https://postmaster.google.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google Postmaster Tools
            </a>{' '}
            ·{' '}
            <a
              className="text-primary underline-offset-2 hover:underline"
              href="https://sendersupport.olc.protection.outlook.com/snds/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Microsoft SNDS
            </a>
          </p>
        </div>
      </section>
      {readiness.isError ? (
        <ErrorState
          problem={toProblemLike(readiness.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void readiness.refetch()}
        />
      ) : !readiness.data ? (
        <Skeleton className="h-64 w-full" />
      ) : readiness.data.length === 0 ? (
        <EmptyState icon={<MailsIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
      ) : (
        <ul className="space-y-4">
          {readiness.data.map((item) => (
            <MailboxCard
              key={item.mailboxId}
              item={item}
              health={byMailbox.get(item.mailboxId)}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function KillSwitchCard({ canManage }: { readonly canManage: boolean }) {
  const t = useTranslations('deliverability.killSwitch');
  const format = useFormatter();
  const overview = useDeliverabilityOverview();
  const actions = useDeliverabilityActions();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const kill = overview.data?.killSwitch;
  const toggle = async () => {
    if (!kill) return;
    const toast = await getToast();
    try {
      await actions.killSwitch.mutateAsync({ active: !kill.active, reason });
      toast.success(kill.active ? t('resumed') : t('stopped'));
      setOpen(false);
      setReason('');
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  return (
    <div className={cn('space-y-2 rounded-lg border p-3 text-sm', kill?.active ? 'border-destructive' : '')}>
      <h2 className="font-medium">{t('title')}</h2>
      {!kill ? (
        <Skeleton className="h-6 w-40" />
      ) : (
        <>
          <p>
            {kill.active
              ? t('on', {
                  reason: kill.reason ?? '',
                  when: kill.at
                    ? format.dateTime(new Date(kill.at), { dateStyle: 'medium', timeStyle: 'short' })
                    : '',
                })
              : t('off')}
          </p>
          {canManage ? (
            <Button size="sm" variant={kill.active ? 'outline' : 'destructive'} onClick={() => setOpen(true)}>
              {kill.active ? t('resume') : t('stop')}
            </Button>
          ) : null}
        </>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{kill?.active ? t('resumeTitle') : t('stopTitle')}</DialogTitle>
            <DialogDescription>{kill?.active ? t('resumeBody') : t('stopBody')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="kill-reason">{t('reason')}</Label>
            <Textarea
              id="kill-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant={kill?.active ? 'default' : 'destructive'}
              disabled={reason.trim().length < 5 || actions.killSwitch.isPending}
              onClick={() => void toggle()}
            >
              {kill?.active ? t('resume') : t('stop')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MailboxCard({
  item,
  health,
  canManage,
}: {
  readonly item: MailboxReadiness;
  readonly health: MailboxHealthStats | undefined;
  readonly canManage: boolean;
}) {
  const t = useTranslations('deliverability');
  const format = useFormatter();
  const locale = useLocale() === 'fr' ? 'fr' : 'en';
  const actions = useDeliverabilityActions();
  const [overriding, setOverriding] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const act = async (call: () => Promise<unknown>, done: string) => {
    const toast = await getToast();
    try {
      await call();
      toast.success(done);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 1000) / 10}%`);
  const maxSent = Math.max(1, ...(health?.daily ?? []).map((day) => day.sent));
  return (
    <li className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.email}</span>
        {health ? <Badge variant="outline">{t(`status.${health.status as 'active'}`)}</Badge> : null}
        <Badge variant={item.ready ? 'secondary' : 'destructive'}>
          {item.ready ? t('ready') : t('notReady')}
        </Badge>
        {item.override ? <Badge variant="outline">{t('overridden')}</Badge> : null}
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={actions.recheck.isPending}
            onClick={() => void act(() => actions.recheck.mutateAsync(item.mailboxId), t('rechecked'))}
          >
            <RefreshCwIcon aria-hidden />
            {t('recheck')}
          </Button>
          {canManage && !item.ready && !item.override ? (
            <Button size="sm" variant="outline" onClick={() => setOverriding(true)}>
              {t('override')}
            </Button>
          ) : null}
          {canManage && item.override ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void act(() => actions.clearOverride.mutateAsync(item.mailboxId), t('overrideCleared'))
              }
            >
              {t('clearOverride')}
            </Button>
          ) : null}
        </div>
      </div>
      {item.check ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {t('checked', {
              domain: item.domain,
              when: format.dateTime(new Date(item.check.checkedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </p>
          <ul className="space-y-1">
            {item.check.checks.map((check) => (
              <li key={check.id} className="rounded-md border px-2 py-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={OUTCOME_VARIANT[check.outcome]}>{t(`outcome.${check.outcome}`)}</Badge>
                  <span className="font-medium">{t(`checks.${check.id}`)}</span>
                  <span>{check.summary[locale]}</span>
                </div>
                {check.found ? (
                  <p className="break-all font-mono text-xs text-muted-foreground">{check.found}</p>
                ) : null}
                {check.fix ? <p className="mt-1 text-xs">{check.fix[locale]}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('notChecked')}</p>
      )}
      {health ? (
        <div className="space-y-2">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <dt className="text-muted-foreground">{t('health.sends')}</dt>
            <dd>{t('health.sendsValue', { day: health.sends24h, week: health.sends7d })}</dd>
            <dt className="text-muted-foreground">{t('health.bounces')}</dt>
            <dd>{percent(health.bounces.rate)}</dd>
            <dt className="text-muted-foreground">{t('health.unsubscribes')}</dt>
            <dd>{percent(health.unsubscribes7d.rate)}</dd>
            <dt className="text-muted-foreground">{t('health.positive')}</dt>
            <dd>{percent(health.positive7d.rate)}</dd>
            <dt className="text-muted-foreground">{t('health.negative')}</dt>
            <dd>{percent(health.negative7d.rate)}</dd>
            <dt className="text-muted-foreground">{t('health.deferrals')}</dt>
            <dd>{health.deferrals7d}</dd>
          </dl>
          {health.warnings.length > 0 ? (
            <p className="text-xs text-destructive">
              {health.warnings
                .map((warning) => t(`warnings.${warning.split(':')[0] as 'would_pause'}`))
                .join(' · ')}
            </p>
          ) : null}
          {health.daily.length > 0 ? (
            <div aria-label={t('health.trend')} className="flex h-12 items-end gap-px" role="img">
              {health.daily.map((day) => (
                <div
                  key={day.day}
                  title={`${day.day}: ${day.sent} / ${day.bounced}`}
                  className={cn('w-1.5 rounded-t', day.bounced > 0 ? 'bg-destructive/70' : 'bg-primary/60')}
                  style={{ height: `${Math.max(4, Math.round((day.sent / maxSent) * 100))}%` }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <Dialog open={overriding} onOpenChange={setOverriding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('overrideTitle', { email: item.email })}</DialogTitle>
            <DialogDescription>{t('overrideBody')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor={`override-${item.mailboxId}`}>{t('reason')}</Label>
            <Textarea
              id={`override-${item.mailboxId}`}
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverriding(false)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={reason.trim().length < 10 || actions.override.isPending}
              onClick={() =>
                void act(async () => {
                  await actions.override.mutateAsync({ mailboxId: item.mailboxId, reason });
                  setOverriding(false);
                  setReason('');
                }, t('overridden'))
              }
            >
              {t('override')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
