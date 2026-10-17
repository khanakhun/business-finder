'use client';

import type { PipelineStatus } from '@bf/contracts';
import {
  ArrowRightLeftIcon,
  BanIcon,
  CircleCheckIcon,
  CirclePlusIcon,
  GaugeIcon,
  GitMergeIcon,
  HandshakeIcon,
  ListTodoIcon,
  RefreshCwIcon,
  StickyNoteIcon,
  TagsIcon,
  UserRoundIcon,
} from 'lucide-react';
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
  ];
  for (const [order, entry] of entries.entries()) activityRenderers.register({ ...entry, order });
}
