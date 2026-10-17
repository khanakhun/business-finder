'use client';

import { type EmailDraft, type InboxThread, TRIAGE_CLASSES } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { Textarea } from '@bf/ui/components/textarea';
import { cn } from '@bf/ui/lib/utils';
import { InboxIcon, SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { useMailboxes } from '@/features/mailboxes/api.ts';
import { useDraftActions } from '@/features/outreach/api.ts';
import { SendButton } from '@/features/outreach/send/send-button.tsx';
import { isTypingTarget } from '@/lib/keyboard.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useInbox, useInboxActions, useInboxThread } from './api.ts';
import { MessageFrame } from './message-frame.tsx';
import { TriageChip } from './triage-chip.tsx';

// The unified inbox (BF-054): outreach replies only. Threads on the left (triage class, mailbox, unread, needs a
// person, assigned to me, search); the conversation on the right — our emails and theirs, their HTML sanitized and
// sandboxed, the triage with its correction, and a suggested reply sent in the same thread through the outbound
// pipeline (compliance, undo). Keys: j/k move, e marks handled, a assigns to me, s snoozes a day.

const ALL = 'all';
const DAY_MS = 86_400_000;

export function InboxPage() {
  const t = useTranslations('inbox');
  const classes = useTranslations('inbox.classes');
  const errorLabels = useErrorLabels();
  const me = useSession().user.id;
  const mailboxes = useMailboxes();
  const [threadId, setThreadId] = useQueryState('thread', parseAsString);
  const [triageClass, setTriageClass] = useQueryState('class', parseAsString.withDefault(ALL));
  const [mailboxId, setMailboxId] = useQueryState('mailbox', parseAsString.withDefault(ALL));
  const [unread, setUnread] = React.useState(false);
  const [needsHuman, setNeedsHuman] = React.useState(false);
  const [mine, setMine] = React.useState(false);
  const [q, setQ] = React.useState('');
  const list = useInbox({
    ...(triageClass !== ALL ? { class: triageClass } : {}),
    ...(mailboxId !== ALL ? { mailboxId } : {}),
    ...(unread ? { unread: 'true' } : {}),
    ...(needsHuman ? { needsHuman: 'true' } : {}),
    ...(mine ? { assignedToMe: 'true' } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
  });
  const items = list.data?.items ?? [];
  const thread = useInboxThread(threadId);
  const actions = useInboxActions();
  const latestInbound = [...(thread.data?.entries ?? [])]
    .reverse()
    .find((entry) => entry.direction === 'inbound');

  const act = React.useCallback(
    async (body: Parameters<typeof actions.update.mutateAsync>[0]['body'], done: string) => {
      if (!latestInbound || latestInbound.direction !== 'inbound') return;
      const toast = await getToast();
      try {
        await actions.update.mutateAsync({ id: latestInbound.message.id, body });
        toast.success(done);
      } catch (error) {
        toast.error(toProblemLike(error, t('failed')).title);
      }
    },
    [actions.update, latestInbound, t],
  );

  // Opening a thread marks its newest reply read.
  React.useEffect(() => {
    if (latestInbound?.direction === 'inbound' && latestInbound.message.status === 'new')
      void actions.update
        .mutateAsync({ id: latestInbound.message.id, body: { status: 'read' } })
        .catch(() => {});
  }, [latestInbound, actions.update]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      const index = threadId ? items.findIndex((item) => item.threadId === threadId) : -1;
      const move = (to: number) => {
        const next = items[Math.max(0, Math.min(items.length - 1, to))];
        if (next) void setThreadId(next.threadId);
      };
      switch (event.key) {
        case 'j':
          move(index + 1);
          break;
        case 'k':
          move(index - 1);
          break;
        case 'e':
          void act({ status: 'handled' }, t('handled'));
          break;
        case 'a':
          void act({ assignedTo: me }, t('assigned'));
          break;
        case 's':
          void act(
            { status: 'snoozed', snoozedUntil: new Date(Date.now() + DAY_MS).toISOString() },
            t('snoozed'),
          );
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[24rem_1fr]">
      <aside className="min-w-0 space-y-3">
        <Input
          aria-label={t('search')}
          placeholder={t('search')}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <div className="grid grid-cols-2 gap-2">
          <Select value={triageClass} onValueChange={(value) => void setTriageClass(value)}>
            <SelectTrigger aria-label={t('class')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('allClasses')}</SelectItem>
              {TRIAGE_CLASSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {classes(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        <div className="flex flex-wrap gap-4 text-sm">
          <Toggle id="inbox-unread" label={t('unread')} checked={unread} onChange={setUnread} />
          <Toggle id="inbox-human" label={t('needsHuman')} checked={needsHuman} onChange={setNeedsHuman} />
          <Toggle id="inbox-mine" label={t('mine')} checked={mine} onChange={setMine} />
        </div>
        {list.isError ? (
          <ErrorState
            problem={toProblemLike(list.error, t('loadError'))}
            labels={errorLabels}
            onRetry={() => void list.refetch()}
          />
        ) : !list.data ? (
          <Skeleton className="h-64 w-full" />
        ) : items.length === 0 ? (
          <EmptyState icon={<InboxIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t('threads')}>
            {items.map((item) => (
              <ThreadRow
                key={item.threadId}
                item={item}
                active={item.threadId === threadId}
                onOpen={() => void setThreadId(item.threadId)}
              />
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t('keys')}</p>
      </aside>
      <section className="min-w-0">
        {!threadId ? (
          <EmptyState icon={<InboxIcon aria-hidden />} title={t('pickTitle')} description={t('pickBody')} />
        ) : thread.isError ? (
          <ErrorState
            problem={toProblemLike(thread.error, t('loadError'))}
            labels={errorLabels}
            onRetry={() => void thread.refetch()}
          />
        ) : !thread.data ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <ThreadView
            detail={thread.data}
            onHandled={() => void act({ status: 'handled' }, t('handled'))}
            onAssign={() => void act({ assignedTo: me }, t('assigned'))}
            onSnooze={() =>
              void act(
                { status: 'snoozed', snoozedUntil: new Date(Date.now() + DAY_MS).toISOString() },
                t('snoozed'),
              )
            }
          />
        )}
      </section>
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

function ThreadRow({
  item,
  active,
  onOpen,
}: {
  readonly item: InboxThread;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  const t = useTranslations('inbox');
  const classes = useTranslations('inbox.classes');
  const format = useFormatter();
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        className={cn('w-full px-3 py-2 text-left text-sm', active ? 'bg-muted' : 'hover:bg-muted/60')}
      >
        <span className="flex items-center gap-2">
          <span className={cn('truncate', item.unreadCount > 0 ? 'font-semibold' : 'font-medium')}>
            {item.businessName}
          </span>
          {item.unreadCount > 0 ? <Badge>{item.unreadCount}</Badge> : null}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {item.lastInboundAt
              ? format.dateTime(new Date(item.lastInboundAt), { dateStyle: 'short', timeStyle: 'short' })
              : ''}
          </span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">{item.snippet || item.subject}</span>
        <span className="mt-1 flex flex-wrap gap-1">
          {item.latestClass ? <Badge variant="secondary">{classes(item.latestClass)}</Badge> : null}
          {item.latestKind && item.latestKind !== 'human' ? (
            <Badge variant="outline">{t(`triage.kinds.${item.latestKind}`)}</Badge>
          ) : null}
          {item.needsHuman ? <Badge variant="outline">{t('triage.needsHuman')}</Badge> : null}
        </span>
      </button>
    </li>
  );
}

function ThreadView({
  detail,
  onHandled,
  onAssign,
  onSnooze,
}: {
  readonly detail: NonNullable<ReturnType<typeof useInboxThread>['data']>;
  readonly onHandled: () => void;
  readonly onAssign: () => void;
  readonly onSnooze: () => void;
}) {
  const t = useTranslations('inbox');
  const format = useFormatter();
  const latest = [...detail.entries].reverse().find((entry) => entry.direction === 'inbound');
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{detail.thread.subject}</h2>
        <Link
          className="text-sm text-primary underline-offset-2 hover:underline"
          href={`/businesses/${detail.thread.businessId}`}
        >
          {detail.thread.businessName}
        </Link>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="outline" onClick={onAssign}>
            {t('assignMe')}
          </Button>
          <Button size="sm" variant="outline" onClick={onSnooze}>
            {t('snooze')}
          </Button>
          <Button size="sm" onClick={onHandled}>
            {t('markHandled')}
          </Button>
        </div>
      </header>
      <ol className="space-y-3">
        {detail.entries.map((entry) => (
          <li
            key={`${entry.direction}-${entry.message.id}`}
            className={cn('rounded-lg border p-3', entry.direction === 'outbound' ? 'bg-muted/30' : '')}
          >
            {entry.direction === 'outbound' ? (
              <>
                <p className="mb-1 text-xs text-muted-foreground">
                  {t('weWrote', {
                    when: format.dateTime(new Date(entry.message.sentAt ?? entry.message.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                  })}
                </p>
                <pre className="whitespace-pre-wrap text-sm">{entry.message.bodyText}</pre>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t('theyWrote', {
                    who: entry.message.fromName ?? entry.message.fromEmail,
                    when: format.dateTime(new Date(entry.message.receivedAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                  })}
                </p>
                <TriageChip message={entry.message} />
                <MessageFrame
                  html={entry.message.bodyHtml}
                  text={entry.message.bodyText}
                  hasRemoteImages={entry.message.hasRemoteImages}
                />
              </div>
            )}
          </li>
        ))}
      </ol>
      {latest?.direction === 'inbound' && latest.message.kind === 'human' ? (
        <ReplyEditor inboundId={latest.message.id} />
      ) : null}
    </div>
  );
}

/** A suggested reply (BF-051 reply mode): edit, save, then send in the thread through the outbound pipeline. */
function ReplyEditor({ inboundId }: { readonly inboundId: string }) {
  const t = useTranslations('inbox.reply');
  const actions = useInboxActions();
  const drafts = useDraftActions();
  const [draft, setDraft] = React.useState<EmailDraft | null>(null);
  const [body, setBody] = React.useState('');
  React.useEffect(() => {
    setDraft(null);
    setBody('');
  }, [inboundId]);
  const suggest = async () => {
    const toast = await getToast();
    try {
      const created = await actions.suggest.mutateAsync({ id: inboundId });
      setDraft(created);
      setBody(created.bodyMd);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const save = async () => {
    if (!draft) return;
    const toast = await getToast();
    try {
      const updated = await drafts.update.mutateAsync({ id: draft.id, body: { bodyMd: body } });
      setDraft(updated);
      toast.success(t('saved'));
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  const dirty = draft !== null && body !== draft.bodyMd;
  return (
    <section className="space-y-2 rounded-lg border p-3" aria-label={t('title')}>
      <h3 className="text-sm font-medium">{t('title')}</h3>
      {!draft ? (
        <Button size="sm" disabled={actions.suggest.isPending} onClick={() => void suggest()}>
          <SparklesIcon aria-hidden />
          {actions.suggest.isPending ? t('writing') : t('suggest')}
        </Button>
      ) : (
        <>
          <Textarea
            aria-label={t('body')}
            rows={10}
            className="font-mono text-sm"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || drafts.update.isPending}
              onClick={() => void save()}
            >
              {t('save')}
            </Button>
            <SendButton
              draft={draft}
              decision={undefined}
              disabled={dirty || draft.lint.some((issue) => issue.severity === 'error')}
              copyText={() => body}
            />
          </div>
        </>
      )}
    </section>
  );
}
