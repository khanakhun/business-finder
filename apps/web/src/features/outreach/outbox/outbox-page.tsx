'use client';

import type { OutboundMessageSummary } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { SendIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { useMailboxes } from '@/features/mailboxes/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { useMessageActions, useOutbox } from '../outbound-api.ts';
import { MessageSheet } from './message-sheet.tsx';

// The outbox (BF-052): messages by status — queued (and scheduled), sending, sent, failed, blocked, cancelled — with
// the reasons a message is stopped, and the actions that apply: cancel, reschedule, retry, open its decisions.

const TABS = ['queued', 'sending', 'sent', 'failed', 'blocked', 'cancelled'] as const;
const ALL = 'all';

export function OutboxPage() {
  const t = useTranslations('outbound.outbox');
  const status = useTranslations('outbound.status');
  const format = useFormatter();
  const errorLabels = useErrorLabels();
  const [tab, setTab] = useQueryState('status', parseAsStringLiteral(TABS).withDefault('queued'));
  const [mailboxId, setMailboxId] = useQueryState('mailbox', parseAsString.withDefault(ALL));
  // `?open=<id>` opens a message (links from a business's timeline).
  const [open, setOpen] = useQueryState('open', parseAsString);
  const mailboxes = useMailboxes();
  const list = useOutbox({ status: tab, ...(mailboxId !== ALL ? { mailboxId } : {}) });
  const actions = useMessageActions();

  const act = async (run: () => Promise<unknown>, done: string) => {
    const toast = await getToast();
    try {
      await run();
      toast.success(done);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const scheduled = (message: OutboundMessageSummary) =>
    message.status === 'queued' && new Date(message.scheduledAt).getTime() > Date.now() + 60_000;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={tab} onValueChange={(value) => void setTab(value as (typeof TABS)[number])}>
          <TabsList>
            {TABS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {status(value)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="ml-auto w-64">
          <Select value={mailboxId} onValueChange={(value) => void setMailboxId(value)}>
            <SelectTrigger aria-label={t('mailbox')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('allMailboxes')}</SelectItem>
              {(mailboxes.data ?? []).map((mailbox) => (
                <SelectItem key={mailbox.id} value={mailbox.id}>
                  {mailbox.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {list.isError ? (
        <ErrorState
          problem={toProblemLike(list.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void list.refetch()}
        />
      ) : !list.data ? (
        <Skeleton className="h-48 w-full" />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<SendIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('business')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('subject')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('mailbox')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('when')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('state')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  <span className="sr-only">{t('actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((message) => (
                <tr key={message.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{message.businessName}</div>
                    <div className="text-xs text-muted-foreground">{message.recipient}</div>
                  </td>
                  <td className="max-w-xs truncate px-3 py-2" title={message.subject}>
                    {message.subject}
                  </td>
                  <td className="px-3 py-2 text-xs">{message.mailboxEmail ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {format.dateTime(new Date(message.sentAt ?? message.scheduledAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={message.status === 'sent' ? 'secondary' : 'outline'}>
                      {scheduled(message) ? t('scheduled') : status(message.status)}
                    </Badge>
                    {message.blockedReasons.length > 0 ? (
                      <div className="mt-1 text-xs text-destructive">{message.blockedReasons.join(', ')}</div>
                    ) : null}
                    {message.lastError ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {message.lastError.message} ({t('attempts', { count: message.attempts })})
                      </div>
                    ) : null}
                  </td>
                  <td className="space-x-1 whitespace-nowrap px-3 py-2 text-right">
                    {message.status === 'queued' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void act(() => actions.cancel.mutateAsync(message.id), t('cancelled'))}
                      >
                        {t('cancel')}
                      </Button>
                    ) : null}
                    {message.status === 'failed' && message.lastError?.retryable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void act(() => actions.retry.mutateAsync(message.id), t('retried'))}
                      >
                        {t('retry')}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => void setOpen(message.id)}>
                      {t('open')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <MessageSheet id={open} onClose={() => void setOpen(null)} />
    </div>
  );
}
