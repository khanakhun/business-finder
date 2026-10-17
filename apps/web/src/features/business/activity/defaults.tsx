'use client';

import type { PipelineStatus } from '@bf/contracts';
import {
  ArrowRightLeftIcon,
  BanIcon,
  CircleCheckIcon,
  CirclePlusIcon,
  ClockIcon,
  GaugeIcon,
  GitMergeIcon,
  HandshakeIcon,
  ListTodoIcon,
  PhoneIcon,
  RefreshCwIcon,
  SendIcon,
  StickyNoteIcon,
  TagsIcon,
  TriangleAlertIcon,
  UndoIcon,
  UserRoundIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTeammates } from '../api.ts';
import { type ActivityRendererProps, activityRenderers } from './registry.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

function StatusChanged({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  const status = useTranslations('search.status');
  const { from, to, reason, automatic } = activity.data;
  const label = (value: unknown) => status(text(value) as PipelineStatus);
  return (
    <>
      {t(automatic === true ? 'statusAutomatic' : 'status', { from: label(from), to: label(to) })}
      {text(reason) ? <span className="block text-muted-foreground">“{text(reason)}”</span> : null}
    </>
  );
}

function OwnerChanged({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  const { byUser } = useTeammates();
  const owner = text(activity.data.ownerUserId);
  return <>{owner ? t('owner', { name: byUser.get(owner)?.name ?? t('someone') }) : t('ownerCleared')}</>;
}

function TagsChanged({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  const added = list(activity.data.added);
  const removed = list(activity.data.removed);
  return (
    <>
      {added.length > 0 ? t('tagsAdded', { tags: added.join(', ') }) : null}
      {added.length > 0 && removed.length > 0 ? ' ' : null}
      {removed.length > 0 ? t('tagsRemoved', { tags: removed.join(', ') }) : null}
    </>
  );
}

function DoNotContact({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  return (
    <>
      {activity.data.doNotContact === true ? t('doNotContactOn') : t('doNotContactOff')}
      {text(activity.data.reason) ? (
        <span className="block text-muted-foreground">“{text(activity.data.reason)}”</span>
      ) : null}
    </>
  );
}

function Plain({ message }: { readonly message: 'noteAdded' | 'tracked' | 'merged' }) {
  const t = useTranslations('business.activity');
  return <>{t(message)}</>;
}

const NoteAdded = () => <Plain message="noteAdded" />;
const Tracked = () => <Plain message="tracked" />;
const Merged = () => <Plain message="merged" />;

function TaskLine({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  const key = activity.type === 'task.completed' ? 'taskCompleted' : 'taskCreated';
  return <>{t(key, { title: text(activity.data.title) })}</>;
}

/** The primary profile's tier moved (BF-031). */
function ScoreUpdated({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  return <>{t('scoreUpdated', { from: text(activity.data.from), to: text(activity.data.to) })}</>;
}

/** A lead from the preview (BF-048): a claim, a contact request, or an opt-out. */
function LeadLine({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  if (activity.type === 'lead.opted_out')
    return <>{activity.data.removePreview === true ? t('leadOptedOutRemoved') : t('leadOptedOut')}</>;
  return <>{activity.data.kind === 'contact_request' ? t('leadContact') : t('leadClaim')}</>;
}

const EMAIL_TAB: Record<string, string> = {
  'email.queued': 'queued',
  'email.sent': 'sent',
  'email.cancelled': 'cancelled',
  'email.blocked': 'blocked',
  'email.failed': 'failed',
};

/** An email's status (BF-052), linking to the message (content, decisions, history); contacts logged by hand. */
function EmailLine({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  const channel = useTranslations('outbound.manual.channels');
  const messageId = text(activity.data.messageId);
  const line = (() => {
    switch (activity.type) {
      case 'email.queued':
        return t('emailQueued');
      case 'email.sent':
        return t('emailSent');
      case 'email.cancelled':
        return t('emailCancelled');
      case 'email.blocked':
        return t('emailBlocked', { reasons: list(activity.data.reasons).join(', ') || '—' });
      case 'email.failed':
        return activity.data.final === true ? t('emailFailedFinal') : t('emailFailed');
      default:
        return t('contactLogged', { channel: channel(text(activity.data.channel) as 'email') });
    }
  })();
  return (
    <>
      {line}
      {messageId ? (
        <>
          {' '}
          <Link
            className="text-primary underline-offset-2 hover:underline"
            href={`/outreach/outbox?status=${EMAIL_TAB[activity.type] ?? 'queued'}&open=${messageId}`}
          >
            {t('openEmail')}
          </Link>
        </>
      ) : null}
    </>
  );
}

function Updated({ activity }: ActivityRendererProps) {
  const t = useTranslations('business.activity');
  return <>{t('updated', { count: list(activity.data.fields).length })}</>;
}

let registered = false;

/** The renderers of the built-in activity types (idempotent). */
export function registerDefaultActivityRenderers(): void {
  if (registered) return;
  registered = true;
  const entries = [
    { id: 'status.changed', icon: ArrowRightLeftIcon, component: StatusChanged },
    { id: 'owner.changed', icon: UserRoundIcon, component: OwnerChanged },
    { id: 'tags.changed', icon: TagsIcon, component: TagsChanged },
    { id: 'do_not_contact.changed', icon: BanIcon, component: DoNotContact },
    { id: 'note.added', icon: StickyNoteIcon, component: NoteAdded },
    { id: 'task.created', icon: ListTodoIcon, component: TaskLine },
    { id: 'task.completed', icon: CircleCheckIcon, component: TaskLine },
    { id: 'business.tracked', icon: CirclePlusIcon, component: Tracked },
    { id: 'business.merged', icon: GitMergeIcon, component: Merged },
    { id: 'business.updated', icon: RefreshCwIcon, component: Updated },
    { id: 'score.updated', icon: GaugeIcon, component: ScoreUpdated },
    { id: 'lead.captured', icon: HandshakeIcon, component: LeadLine },
    { id: 'lead.opted_out', icon: BanIcon, component: LeadLine },
    { id: 'email.queued', icon: ClockIcon, component: EmailLine },
    { id: 'email.sent', icon: SendIcon, component: EmailLine },
    { id: 'email.cancelled', icon: UndoIcon, component: EmailLine },
    { id: 'email.blocked', icon: BanIcon, component: EmailLine },
    { id: 'email.failed', icon: TriangleAlertIcon, component: EmailLine },
    { id: 'contact.logged', icon: PhoneIcon, component: EmailLine },
  ];
  for (const [order, entry] of entries.entries()) activityRenderers.register({ ...entry, order });
}
